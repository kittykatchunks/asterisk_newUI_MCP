"""Owned management-outage proof: continuous synthetic RTP, never live calls."""

import argparse
import concurrent.futures
import json
import math
import random
import select
import struct
import time
from pathlib import Path

from sip_rtp_proof import Probe, read_password, require


def correlate(rows, call_ids):
    require(len(call_ids) == 2 and call_ids[0] != call_ids[1], "Two distinct Call-IDs required")
    dialogs = []
    for call_id in call_ids:
        matches = [row for row in rows if row["event"] == "PROOF_SIP_DIALOG" and
                   json.loads(row["extra"]).get("extra") == call_id]
        require(len(matches) == 1, f"Expected exactly one CEL correlation for {call_id}")
        event = matches[0]
        lifecycle = [row for row in rows if row["uniqueid"] == event["uniqueid"]]
        for name in ["CHAN_START", "ANSWER", "HANGUP", "CHAN_END"]:
            require(sum(row["event"] == name for row in lifecycle) == 1,
                    f"Missing/duplicate {name} for {call_id}")
        require(event["context"] == "sip-proof" and event["extension"] == "echo",
                "Unexpected conventional route")
        dialogs.append({"callId": call_id, "uniqueid": event["uniqueid"],
                        "linkedid": event["linkedid"], "events": [row["event"] for row in lifecycle]})
    require(dialogs[0]["uniqueid"] != dialogs[1]["uniqueid"], "Dialogs shared one channel identity")
    return {"dialogs": dialogs}


class Observation:
    SECONDS = 60

    def __init__(self, started):
        self.started = started
        self.sent = [0] * self.SECONDS
        self.echoes = [set() for _ in range(self.SECONDS)]
        self.last_echo = started
        self.max_gap = 0.0

    def sent_at(self, now):
        offset = now - self.started
        if 0 <= offset < self.SECONDS:
            window = int(offset)
            self.sent[window] += 1
            return window
        return None

    def received(self, payload, window, now):
        if window is not None and payload not in self.echoes[window]:
            self.echoes[window].add(payload)
            if now - self.started <= self.SECONDS:
                self.max_gap = max(self.max_gap, now - self.last_echo)
                self.last_echo = now

    def check_gap(self, now):
        self.max_gap = max(self.max_gap, min(now, self.started + self.SECONDS) - self.last_echo)
        require(self.max_gap <= 1.0, f"RTP receive gap exceeded one second: {self.max_gap:.3f}s")

    def result(self, now):
        require(now - self.started >= self.SECONDS, "Observation shorter than 60 monotonic seconds")
        self.check_gap(now)
        windows = []
        for index, (sent, echoed) in enumerate(zip(self.sent, self.echoes)):
            require(sent >= 40, f"Window {index}: only {sent} sent RTP frames")
            require(len(echoed) >= math.ceil(sent * 0.70),
                    f"Window {index}: only {len(echoed)}/{sent} distinct frames echoed")
            windows.append({"second": index, "sent": sent, "echoed": len(echoed)})
        return {"seconds": self.SECONDS, "observedSeconds": now - self.started,
                "maxReceiveGapSeconds": self.max_gap, "windows": windows}


def payload(data):
    require(len(data) >= 12 and data[0] >> 6 == 2, "Malformed RTP")
    require(data[1] & 0x7F == 0, "Expected PCMU RTP")
    offset = 12 + 4 * (data[0] & 0x0F)
    require(len(data) >= offset, "Truncated RTP CSRC list")
    if data[0] & 0x10:
        require(len(data) >= offset + 4, "Truncated RTP extension")
        offset += 4 + 4 * struct.unpack("!H", data[offset + 2:offset + 4])[0]
    end = len(data)
    if data[0] & 0x20:
        padding = data[-1]
        require(padding > 0 and padding <= end - offset, "Invalid RTP padding")
        end -= padding
    require(end >= offset, "Truncated RTP payload")
    return data[offset:end]


def fresh_call(host, password):
    probe = Probe(host)
    try:
        code, headers, sdp = probe.invite(password)
        require(code == 200, f"New outage call INVITE failed: {code}")
        echoed = probe.echo(headers, sdp)
        return {"callId": probe.call_id, "echoed": echoed, "sent": 100, "byeStatus": 200}
    finally:
        probe.close()


def observe(host, directory, password, sip, rtp, call_id, receive_sip):
    rng = random.Random(call_id)
    ssrc = rng.getrandbits(32)
    sequence = 0
    sent_payloads = {}
    baseline = set()
    started = time.monotonic()
    next_send = started
    ready = False
    observation = None
    new_call = None
    outcome = None
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        while True:
            now = time.monotonic()
            if not ready and now - started > 10:
                raise RuntimeError("Pre-outage media baseline did not become ready")
            if ready and observation is None and now - started > 25:
                raise RuntimeError("Controller did not confirm management exit")
            if observation is None and ready and (directory / "outage-start.json").exists():
                marker = json.loads((directory / "outage-start.json").read_text())
                require(marker.get("managementExited") is True, "Management exit marker required")
                observation = Observation(now)
            if observation:
                observation.check_gap(now)
                if new_call is None and now - observation.started >= 3:
                    new_call = executor.submit(fresh_call, host, password)
                if new_call and new_call.done() and outcome is None:
                    outcome = new_call.result()
                    require(outcome["callId"] != call_id, "New call reused original Call-ID")
                if now - observation.started >= Observation.SECONDS + 0.5:
                    require(outcome is not None, "No fresh call completed during outage")
                    result = observation.result(now)
                    result.update({"callId": call_id, "baselineEchoed": len(baseline), "newCall": outcome})
                    return result
            if now >= next_send:
                sample = bytes(rng.choice((0xC0, 0xD0, 0xE0, 0x40, 0x50, 0x60)) for _ in range(160))
                require(sample not in sent_payloads, "Synthetic payload collision")
                window = observation.sent_at(now) if observation else None
                sent_payloads[sample] = window
                rtp.send(struct.pack("!BBHII", 0x80, 0, sequence & 0xFFFF, sequence * 160, ssrc) + sample)
                sequence += 1
                next_send = now + 0.02
            for sock in select.select([sip, rtp], [], [], 0.003)[0]:
                if sock is sip:
                    receive_sip()
                else:
                    sample = payload(rtp.recv(4096))
                    require(sample in sent_payloads, "Received RTP not sent by this dialog")
                    if observation:
                        observation.received(sample, sent_payloads[sample], time.monotonic())
                    else:
                        baseline.add(sample)
            if not ready and now - started >= 2 and len(baseline) >= 70:
                temporary = directory / "ready.tmp"
                temporary.write_text(json.dumps({"callId": call_id, "baselineEchoed": len(baseline)}))
                temporary.replace(directory / "ready.json")
                ready = True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True, choices=["customer-a", "customer-b"])
    args = parser.parse_args()
    directory = Path("/run/outage")
    password = read_password(directory / "pjsip.conf")
    probe = Probe(args.host)
    try:
        code, headers, sdp = probe.invite(password)
        require(code == 200, f"Original outage call INVITE failed: {code}")
        result = probe.echo(headers, sdp, lambda sip, rtp, call_id, receive_sip:
                            observe(args.host, directory, password, sip, rtp, call_id, receive_sip))
        result.update({"customer": args.host, "byeStatus": 200})
        (directory / "result.json").write_text(json.dumps(result))
        print(f"PASS {args.host}: 60 one-second media windows, new call during management outage, clean BYEs")
    finally:
        probe.close()


if __name__ == "__main__":
    main()
