"""Bounded synthetic SIP digest/RTP echo probe, not a general-purpose SIP stack."""

import argparse
import configparser
import hashlib
import random
import re
import select
import socket
import struct
import time
import uuid
from pathlib import Path


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def parse_message(data):
    head, _, body = data.decode("utf-8").partition("\r\n\r\n")
    lines = head.split("\r\n")
    headers = {}
    for line in lines[1:]:
        name, separator, value = line.partition(":")
        require(separator, "Malformed SIP header")
        headers.setdefault(name.lower(), []).append(value.strip())
    return lines[0], headers, body


def parse_response(data):
    start, headers, body = parse_message(data)
    require(start.startswith("SIP/2.0 "), "Expected SIP response")
    return int(start.split()[1]), headers, body


def read_password(path):
    config = configparser.ConfigParser(interpolation=None)
    require(config.read(path), "Missing generated proof credentials")
    password = config["proof-client-auth"]["password"]
    require(len(password) == 64, "Unexpected proof password format")
    return password


def authorization(challenge, password, uri):
    require(challenge.startswith("Digest "), "Expected Digest challenge")
    fields = dict(
        (match[0].lower(), match[1] or match[2])
        for match in re.findall(r'(\w+)=(?:"([^"]*)"|([^,\s]+))', challenge[7:])
    )
    require(fields.get("algorithm", "MD5").upper() == "MD5", "Probe supports MD5 digest only")
    md5 = lambda value: hashlib.md5(value.encode()).hexdigest()
    ha1 = md5(f"proof-client:{fields['realm']}:{password}")
    ha2 = md5(f"INVITE:{uri}")
    parts = [
        'username="proof-client"', f'realm="{fields["realm"]}"',
        f'nonce="{fields["nonce"]}"', f'uri="{uri}"', "algorithm=MD5",
    ]
    if "qop" in fields:
        require("auth" in fields["qop"].split(","), "Digest auth qop not offered")
        cnonce = uuid.uuid4().hex
        response = md5(f"{ha1}:{fields['nonce']}:00000001:{cnonce}:auth:{ha2}")
        parts += ["qop=auth", "nc=00000001", f'cnonce="{cnonce}"']
    else:
        response = md5(f"{ha1}:{fields['nonce']}:{ha2}")
    parts.append(f'response="{response}"')
    if "opaque" in fields:
        parts.append(f'opaque="{fields["opaque"]}"')
    return "Digest " + ", ".join(parts)


def verify_rtp_echo(sip, rtp, call_id, receive_sip):
    source = random.Random(call_id)
    # Restrict bytes to moderate-amplitude PCMU values; no microphone or real audio.
    payloads = [bytes(source.choice((0xC0, 0xD0, 0xE0, 0x40, 0x50, 0x60)) for _ in range(160))
                for _ in range(100)]
    received = set()
    outbound = set()
    sequence = 0
    start = time.monotonic()
    ssrc = source.getrandbits(32)
    while time.monotonic() - start < 3:
        elapsed = time.monotonic() - start
        if sequence < len(payloads) and elapsed >= sequence * 0.02:
            payload = payloads[sequence]
            packet = struct.pack("!BBHII", 0x80, 0, sequence, sequence * 160, ssrc) + payload
            rtp.send(packet)
            outbound.add(payload)
            sequence += 1
        readable, _, _ = select.select([rtp, sip], [], [], 0.005)
        for sock in readable:
            if sock is sip:
                receive_sip()
                continue
            data = sock.recv(4096)
            require(len(data) >= 12 and data[0] >> 6 == 2, "Malformed RTP packet")
            require(data[1] & 0x7F == 0, "Unexpected RTP payload type")
            offset = 12 + 4 * (data[0] & 0x0F)
            if data[0] & 0x10:
                require(len(data) >= offset + 4, "Truncated RTP extension")
                offset += 4 + 4 * struct.unpack("!H", data[offset + 2:offset + 4])[0]
            end = len(data) - (data[-1] if data[0] & 0x20 else 0)
            payload = data[offset:end]
            if payload in outbound:
                received.add(payload)
    require(len(received) >= 70,
            f"Only {len(received)}/100 distinct outbound PCMU frames echoed; require 70")
    return len(received)


class Probe:
    def __init__(self, host):
        self.server = (socket.gethostbyname(host), 5060)
        self.sip = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sip.connect(self.server)
        self.ip, self.port = self.sip.getsockname()
        self.rtp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.rtp.bind((self.ip, 0))
        self.uri = f"sip:echo@{host}"
        self.call_id = uuid.uuid4().hex
        self.from_value = f"<sip:proof-client@{self.ip}>;tag={uuid.uuid4().hex}"
        self.to_value = f"<{self.uri}>"
        self.cseq = 1
        self.branch = "z9hG4bK" + uuid.uuid4().hex

    def close(self):
        self.rtp.close()
        self.sip.close()

    def request(self, method, *, uri=None, to_value=None, body="", auth=None,
                extra_headers=()):
        headers = [
            f"{method} {uri or self.uri} SIP/2.0",
            f"Via: SIP/2.0/UDP {self.ip}:{self.port};branch={self.branch};rport",
            "Max-Forwards: 10", f"From: {self.from_value}",
            f"To: {to_value or self.to_value}", f"Call-ID: {self.call_id}",
            f"CSeq: {self.cseq} {method}",
            f"Contact: <sip:proof-client@{self.ip}:{self.port}>",
        ]
        if auth:
            headers.append(f"Authorization: {auth}")
        if body:
            headers.append("Content-Type: application/sdp")
        headers.extend(extra_headers)
        headers += [f"Content-Length: {len(body.encode())}", "", body]
        return "\r\n".join(headers).encode()

    def final_response(self, request, method):
        deadline = time.monotonic() + 5
        next_send = 0
        while time.monotonic() < deadline:
            now = time.monotonic()
            if now >= next_send:
                self.sip.send(request)
                next_send = now + 0.5
            readable, _, _ = select.select([self.sip], [], [], 0.1)
            if readable:
                code, headers, body = parse_response(self.sip.recv(65535))
                if headers.get("cseq") != [f"{self.cseq} {method}"]:
                    continue
                require(headers.get("call-id") == [self.call_id], "Unexpected SIP dialog")
                if code >= 200:
                    return code, headers, body
        raise RuntimeError(f"Timed out awaiting {method} final response")

    def invite(self, password):
        sdp = (
            f"v=0\r\no=proof 1 1 IN IP4 {self.ip}\r\ns=synthetic\r\n"
            f"c=IN IP4 {self.ip}\r\nt=0 0\r\n"
            f"m=audio {self.rtp.getsockname()[1]} RTP/AVP 0\r\n"
            "a=rtpmap:0 PCMU/8000\r\na=ptime:20\r\na=sendrecv\r\n"
        )
        code, headers, _ = self.final_response(self.request("INVITE", body=sdp), "INVITE")
        require(code == 401, f"Unauthenticated INVITE was not challenged: {code}")
        self.sip.send(self.request("ACK", to_value=headers["to"][0]))
        auth = authorization(headers["www-authenticate"][0], password, self.uri)
        self.cseq += 1
        self.branch = "z9hG4bK" + uuid.uuid4().hex
        result = self.final_response(self.request("INVITE", body=sdp, auth=auth), "INVITE")
        code, headers, _ = result
        if code != 200:
            self.sip.send(self.request("ACK", to_value=headers["to"][0]))
        return result

    def echo(self, headers, sdp, verify=verify_rtp_echo):
        self.to_value = headers["to"][0]
        contact = re.search(r"<([^>]+)>", headers["contact"][0])
        require(contact is not None, "Missing dialog Contact")
        target = contact[1]
        self.branch = "z9hG4bK" + uuid.uuid4().hex
        self.sip.send(self.request("ACK", uri=target))
        connection = re.search(r"(?m)^c=IN IP4 ([^\r\n]+)", sdp)
        media = re.search(r"(?m)^m=audio (\d+) RTP/AVP ([^\r\n]+)", sdp)
        require(connection and media and "0" in media[2].split(), "Expected PCMU RTP SDP")
        address = (connection[1], int(media[1]))
        require(address[0] == self.server[0], "Unexpected media host in local proof")
        self.rtp.connect(address)
        def receive_sip():
            code, response, _ = parse_response(self.sip.recv(65535))
            if code == 200 and response.get("cseq") == [f"{self.cseq} INVITE"]:
                self.sip.send(self.request("ACK", uri=target))

        try:
            received = verify(self.sip, self.rtp, self.call_id, receive_sip)
            if verify is verify_rtp_echo:
                print(f"PASS authenticated call, PCMU negotiation, and {received}/100 distinct RTP frames echoed")
        finally:
            self.cseq += 1
            self.branch = "z9hG4bK" + uuid.uuid4().hex
            code, _, _ = self.final_response(self.request("BYE", uri=target), "BYE")
            require(code == 200, f"BYE failed: {code}")
        return received


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    args = parser.parse_args()
    correct = read_password(Path("/run/proof/pjsip.conf"))
    foreign = read_password(Path("/run/foreign/pjsip.conf"))
    require(correct != foreign, "Customer test credentials must differ")
    for label, password in (("wrong", uuid.uuid4().hex), ("other customer", foreign)):
        probe = Probe(args.host)
        try:
            code, _, _ = probe.invite(password)
            require(code in (401, 403), f"{label} credentials not rejected: {code}")
            print(f"PASS {label} credentials rejected with SIP {code}")
        finally:
            probe.close()
    probe = Probe(args.host)
    try:
        code, headers, sdp = probe.invite(correct)
        require(code == 200, f"Authenticated INVITE failed: {code}")
        probe.echo(headers, sdp)
    finally:
        probe.close()


if __name__ == "__main__":
    main()
