"""Local bridged REFER proof, correlated with read-only CEL evidence."""

import argparse
import csv
import json
import re
import select
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from sip_refer_proof import ReferProbe
from sip_refer_peer_proof import TransferPeer
from sip_rtp_proof import read_password, require


CEL_FIELDS = ("event", "time", "channel", "uniqueid", "linkedid", "context",
              "extension", "extra")


def events():
    with Path("/evidence/cel-custom/Master.csv").open(newline="") as stream:
        return list(csv.DictReader(stream, fieldnames=CEL_FIELDS))


def wait_for(probe, description, predicate, seconds=8):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = predicate(events())
        if result:
            return result
        if select.select([probe.sip], [], [], 0.05)[0]:
            probe.receive()
    raise RuntimeError(f"Timed out awaiting {description}; NOTIFY results: {probe.notifications}")


def user_event(row, name, value):
    if row["event"] != name:
        return False
    return json.loads(row["extra"]).get("extra") == value


def verify_notify_retry_window(probe, linkedid):
    require(probe.terminal_received_at is not None, "Missing unacknowledged terminal NOTIFY")
    before = [row for row in events() if row["linkedid"] == linkedid]
    deadline = probe.terminal_received_at + 40
    while time.monotonic() < deadline:
        if select.select([probe.sip], [], [], max(0, min(0.1, deadline - time.monotonic())))[0]:
            probe.receive()
    require(not probe.terminal_retry_acked, "Permanent-loss case acknowledged a terminal NOTIFY")
    receipts = probe.terminal_receipts
    require(len(receipts) >= 6, f"Expected repeated terminal NOTIFY attempts, found {len(receipts)}")
    last = receipts[-1] - receipts[0]
    require(20 <= last < 35, f"Last terminal NOTIFY outside 20-35s window: {last}")
    require(time.monotonic() - receipts[-1] >= 5, "Terminal NOTIFY retries did not become quiet")
    after = [row for row in events() if row["linkedid"] == linkedid]
    require(after == before, "Correlated channel/transfer CEL changed after channels settled")
    print(f"PASS permanently withheld terminal NOTIFY acknowledgements: "
          f"{len(receipts)} identical requests, last at {last:.3f}s, "
          "40s observation with at least 5s final silence; settled CEL unchanged")


def verify_preserved_call(probe, target, request, code, headers, source, transferee, sdp,
                          subscribed, blind_progress):
    require(code == (202 if subscribed else 404), f"Unexpected unknown-target REFER: {code}")
    require(headers.get("refer-sub") == (None if subscribed else ["false"]),
            "Unexpected unknown-target Refer-Sub response")
    repeated, repeated_headers, _ = probe.exchange(request, "REFER")
    require(repeated == code and repeated_headers.get("to") == headers.get("to")
            and repeated_headers.get("refer-sub") == headers.get("refer-sub"),
            "Unknown-target retransmission changed final response")
    probe.observe_notifications(subscribed)
    connection = re.search(r"(?m)^c=IN IP4 ([^\r\n]+)", sdp)
    media = re.search(r"(?m)^m=audio (\d+) RTP/AVP ([^\r\n]+)", sdp)
    require(connection and media and "0" in media[2].split(), "Expected PCMU RTP SDP")
    require(connection[1] == probe.server[0], "Unexpected local-proof RTP host")
    probe.rtp.connect((connection[1], int(media[1])))
    while select.select([probe.rtp], [], [], 0)[0]:
        probe.rtp.recv(4096)
    sequences = set()
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline and len(sequences) < 10:
        for sock in select.select([probe.sip, probe.rtp], [], [], 0.05)[0]:
            if sock is probe.sip:
                probe.receive()
            else:
                packet = sock.recv(4096)
                require(len(packet) >= 172 and packet[0] == 0x80 and packet[1] & 0x7F == 0,
                        "Unexpected proof RTP packet")
                sequences.add(int.from_bytes(packet[2:4], "big"))
    require(len(sequences) >= 10, "Fewer than ten fresh RTP packets after rejected transfer")
    require(not probe.remote_ended, "Rejected transfer ended the source SIP dialog")
    related = [row for row in events() if row["linkedid"] == source["linkedid"]]
    original_ids = {row["uniqueid"] for row in related if row["event"] == "CHAN_START"}
    require(len(original_ids) == 3 and {source["uniqueid"], transferee["uniqueid"]} <= original_ids,
            "Rejected transfer created or replaced a channel")
    require(not any(row["event"] in ("BRIDGE_EXIT", "HANGUP", "CHAN_END", "BLINDTRANSFER",
                                    "PROOF_REFER_TARGET") for row in related),
            "Rejected transfer altered the original bridge/channel lifecycle")
    bridge_id = json.loads(transferee["extra"])["bridge_id"]
    require(all(any(row["event"] == "BRIDGE_ENTER" and row["uniqueid"] == channel_id
                    and json.loads(row["extra"])["bridge_id"] == bridge_id for row in related)
                for channel_id in (source["uniqueid"], transferee["uniqueid"])),
            "Original bridge identities were not preserved")
    probe.cseq += 1
    probe.branch = "z9hG4bK" + uuid.uuid4().hex
    bye_code, _, _ = probe.exchange(probe.request("BYE", uri=target), "BYE")
    require(bye_code == 200, f"Preserved source BYE failed: {bye_code}")

    def settled(rows):
        related = [row for row in rows if row["linkedid"] == source["linkedid"]]
        ended = {row["uniqueid"] for row in related if row["event"] == "CHAN_END"}
        return related if ended == original_ids else None

    related = wait_for(probe, "preserved call cleanup", settled)
    require({row["uniqueid"] for row in related if row["event"] == "CHAN_START"} == original_ids,
            "Unexpected new channels during preserved-call cleanup")
    require(not any(row["event"] in ("BLINDTRANSFER", "PROOF_REFER_TARGET") for row in related),
            "Rejected transfer performed delayed work")
    mode = "implicit subscription" if subscribed else "Refer-Sub: false"
    print(f"PASS preserved bridged call, {mode}, refer_blind_progress={blind_progress}: "
          f"REFER {code}, unchanged bridge, ten fresh RTP packets, BYE, all three channels ended")


def run_transfer(host, password, subscribed, blind_progress, outcome="answered",
                 lose_response=False, lose_terminal_ack=False, lose_all_terminal_acks=False):
    require(not (lose_terminal_ack or lose_all_terminal_acks) or subscribed,
            "NOTIFY acknowledgement loss needs a subscription")
    probe = ReferProbe(host, lose_terminal_ack=lose_terminal_ack,
                       lose_all_terminal_acks=lose_all_terminal_acks)
    peer = TransferPeer(host, busy=outcome == "peer-busy") \
        if outcome in ("peer", "peer-busy") else None
    executor = ThreadPoolExecutor(max_workers=1) if peer else None
    peer_result = None
    token = uuid.uuid4().hex
    prefix, target_name, dialstatus = {
        "answered": ("target", "answer", "ANSWER"),
        "busy": ("failed", "reject", "BUSY"),
        "timeout": ("timeout", "noanswer", "NOANSWER"),
        "unknown": ("missing", None, None),
        "peer": ("peer", None, "ANSWER"),
        "peer-busy": ("peer", None, "BUSY"),
    }[outcome]
    rejected = outcome in ("busy", "timeout", "peer-busy")
    extension = f"peer-{peer.port}-{token}" if peer else f"{prefix}-{token}"
    probe.uri = f"sip:{'media' if peer else 'bridge'}-{token}@{host}"
    probe.to_value = f"<{probe.uri}>"
    try:
        code, headers, sdp = probe.invite(password)
        require(code == 200, f"Bridged INVITE failed: {code}")
        probe.to_value = headers["to"][0]
        contact = re.fullmatch(r"<([^>]+)>", headers["contact"][0])
        require(contact is not None, "Unexpected dialog Contact")
        target = contact[1]
        probe.branch = "z9hG4bK" + uuid.uuid4().hex
        probe.sip.send(probe.request("ACK", uri=target))
        source = wait_for(probe, "source CEL correlation", lambda rows: next(
            (row for row in rows if user_event(row, "PROOF_REFER_SOURCE", probe.call_id)), None))
        linkedid = source["linkedid"]
        source_id = source["uniqueid"]

        def original_bridge(rows):
            entries = [row for row in rows if row["linkedid"] == linkedid
                       and row["event"] == "BRIDGE_ENTER"]
            source_entries = [row for row in entries if row["uniqueid"] == source_id]
            if not source_entries:
                return None
            bridge_id = json.loads(source_entries[0]["extra"])["bridge_id"]
            return next((row for row in entries if row["uniqueid"] != source_id
                         and row["channel"].startswith(
                             "Local/echo@refer-proof-" if peer else "Local/hold@refer-proof-")
                         and json.loads(row["extra"])["bridge_id"] == bridge_id), None)

        transferee = wait_for(probe, "PJSIP/Local shared bridge", original_bridge)
        probe.cseq += 1
        probe.branch = "z9hG4bK" + uuid.uuid4().hex
        extra_headers = [f"Refer-To: <sip:{extension}@{host}>"]
        if not subscribed:
            extra_headers.append("Refer-Sub: false")
        if peer:
            peer_result = executor.submit(peer.run)
        request = probe.request("REFER", uri=target, extra_headers=extra_headers)
        code, headers, _ = probe.exchange(request, "REFER", discard_first_final=lose_response)
        if lose_terminal_ack:
            wait_for(probe, "identical terminal NOTIFY retry acknowledged",
                     lambda rows: probe.terminal_retry_acked, seconds=5)
            delay = time.monotonic() - probe.terminal_received_at
            require(0 < delay < 5, f"Terminal NOTIFY recovery outside five seconds: {delay}")
            print(f"PASS withheld first terminal NOTIFY acknowledgement: "
                  f"identical retry acknowledged within {delay:.3f}s")
        if outcome == "unknown":
            verify_preserved_call(probe, target, request, code, headers, source, transferee,
                                  sdp, subscribed, blind_progress)
            if lose_response:
                print("PASS lost REFER response: original bridged call and RTP preserved")
            if lose_terminal_ack:
                print("PASS lost terminal NOTIFY acknowledgement: rejected transfer "
                      "preserved original bridge and RTP")
            if lose_all_terminal_acks:
                verify_notify_retry_window(probe, linkedid)
            return
        require(code == (202 if subscribed else 200), f"Unexpected accepted REFER: {code}")
        require(headers.get("refer-sub") == (None if subscribed else ["false"]),
                "Unexpected accepted Refer-Sub response")
        destination = wait_for(probe, "transferee executing target", lambda rows: next(
            (row for row in rows if row["linkedid"] == linkedid
             and user_event(row, "PROOF_REFER_TARGET", extension)), None))
        require(destination["uniqueid"] == transferee["uniqueid"],
                "Target marker does not belong to original bridged transferee")
        if subscribed and blind_progress == "no":
            wait_for(probe, "early terminal success NOTIFY", lambda rows: any(
                state.split(";", 1)[0] == "terminated" and status == 200
                for state, status in probe.notifications.values()))
            require(not any(row["linkedid"] == linkedid
                            and row["event"] == "CHAN_START"
                            and row["channel"].startswith(
                                ("Local/answer@refer-proof-", "Local/reject@refer-proof-",
                                 "Local/noanswer@refer-proof-", "PJSIP/proof-client-"))
                            and row["uniqueid"] != source_id
                            for row in events()),
                    "Target leg started before early NOTIFY observation")
            print("PASS refer_blind_progress=no: terminal NOTIFY 200 observed "
                  "before any target leg started")

        def target_bridge(rows):
            entries = [row for row in rows if row["linkedid"] == linkedid
                       and row["event"] == "BRIDGE_ENTER"]
            target_entries = [row for row in entries
                              if row["uniqueid"] != source_id
                              and row["channel"].startswith(
                                  "PJSIP/proof-client-" if peer else "Local/answer@refer-proof-")]
            return next((row for row in target_entries if any(
                other["uniqueid"] == transferee["uniqueid"]
                and json.loads(other["extra"])["bridge_id"]
                == json.loads(row["extra"])["bridge_id"] for other in entries)), None)

        answered_target = None if rejected else wait_for(
            probe, "transferee/target shared bridge", target_bridge)
        repeated, repeated_headers, _ = probe.exchange(request, "REFER")
        require(repeated == code and repeated_headers.get("to") == headers.get("to")
                and repeated_headers.get("refer-sub") == headers.get("refer-sub"),
                "Accepted REFER retransmission changed its response")
        if not probe.remote_ended:
            probe.cseq += 1
            probe.branch = "z9hG4bK" + uuid.uuid4().hex
            code, _, _ = probe.exchange(probe.request("BYE", uri=target), "BYE")
            require(code == 200, f"Transferer BYE failed: {code}")
        if subscribed:
            expected_terminal = 503 if outcome in ("busy", "peer-busy") \
                and blind_progress == "yes" else 200
            wait_for(probe, f"terminal NOTIFY {expected_terminal}", lambda rows: any(
                state.split(";", 1)[0] == "terminated" and status == expected_terminal
                for state, status in probe.notifications.values()))
        else:
            probe.observe_notifications(False)

        def settled(rows):
            related = [row for row in rows if row["linkedid"] == linkedid]
            started = {row["uniqueid"] for row in related if row["event"] == "CHAN_START"}
            ended = {row["uniqueid"] for row in related if row["event"] == "CHAN_END"}
            return related if source_id in started and transferee["uniqueid"] in started \
                and started == ended else None

        related = wait_for(probe, "all correlated channels ending", settled)
        started = {row["uniqueid"] for row in related if row["event"] == "CHAN_START"}
        expected_channels = 4 if peer else 5
        require(len(started) == expected_channels,
                f"Expected {expected_channels} channels, found {len(started)}")
        if peer:
            frames = peer_result.result()
            require(peer.dialog["call-id"] != [probe.call_id], "Target reused source SIP dialog")
            peer_markers = [row for row in related if user_event(
                row, "PROOF_REFER_PEER", peer.dialog["call-id"][0])]
            require(len(peer_markers) == 1, "Expected one outbound SIP Call-ID marker")
            peer_id = peer_markers[0]["uniqueid"]
            require(peer_id != source_id and peer_markers[0]["channel"].startswith(
                "PJSIP/proof-client-"), "Outbound SIP Call-ID does not identify a target channel")
            if rejected:
                print("PASS outbound PJSIP target: INVITE rejected with 486 Busy Here, "
                      "matching transaction ACK, no answered target")
            else:
                require(peer_id == answered_target["uniqueid"],
                        "Outbound SIP Call-ID does not match target bridge channel")
                print(f"PASS outbound PJSIP target: independent INVITE/ACK/BYE, "
                      f"{frames}/100 distinct post-transfer RTP frames echoed")
        if rejected:
            target_ids = {peer_id} if peer else {
                row["uniqueid"] for row in related
                if row["channel"].startswith(f"Local/{target_name}@refer-proof-")}
            require(len(target_ids) == (1 if peer else 2), "Unexpected rejecting target channels")
            require(not any(row["uniqueid"] in target_ids
                            and row["event"] in ("ANSWER", "BRIDGE_ENTER") for row in related),
                    "Rejecting target unexpectedly answered or bridged")
            require(any(row["uniqueid"] == transferee["uniqueid"]
                        and row["event"] == "HANGUP"
                        and json.loads(row["extra"]).get("dialstatus") == dialstatus
                        for row in related), f"Missing transferee {dialstatus} dial result")
            if outcome == "timeout":
                target_start = min(float(row["time"]) for row in related
                                   if row["uniqueid"] in target_ids and row["event"] == "CHAN_START")
                target_end = max(float(row["time"]) for row in related
                                 if row["uniqueid"] in target_ids and row["event"] == "CHAN_END")
                require(2.5 <= target_end - target_start < 5,
                        f"No-answer target duration outside 2.5-5 seconds: {target_end - target_start}")
        else:
            require(any(row["event"] == "ANSWER" and row["uniqueid"] == answered_target["uniqueid"]
                        for row in related), "Target bridge leg has no ANSWER evidence")
        transfers = [row for row in related if row["event"] == "BLINDTRANSFER"]
        require(len(transfers) == 1 and transfers[0]["uniqueid"] == source_id,
                "Expected exactly one source BLINDTRANSFER CEL event")
        transfer = json.loads(transfers[0]["extra"])
        require(transfer["transferee_channel_uniqueid"] == transferee["uniqueid"]
                and transfer["extension"] == extension
                and transfer["context"] == "sip-proof",
                "BLINDTRANSFER identity/target does not match correlated channels")
        require(sum(user_event(row, "PROOF_REFER_TARGET", extension)
                    for row in related) == 1, "Target executed more than once")
        if subscribed:
            terminal = [status for state, status in probe.notifications.values()
                        if state.split(";", 1)[0] == "terminated"]
            require(terminal == [expected_terminal], f"Unexpected terminal NOTIFY outcomes: {terminal}")
            if outcome == "timeout" and blind_progress == "yes":
                require(any(state.split(";", 1)[0] == "active" and status == 180
                            for state, status in probe.notifications.values()),
                        "Missing active ringing NOTIFY for no-answer target")
        else:
            require(not probe.notifications, "No-subscription transfer emitted NOTIFY")
        mode = "implicit subscription" if subscribed else "Refer-Sub: false"
        refer_code = 202 if subscribed else 200
        result = f"{dialstatus} target without answer" if rejected else "answered target bridge"
        print(f"PASS accepted {mode}, refer_blind_progress={blind_progress}: "
              f"REFER {refer_code}, original transferee reached target, "
              f"{result}, one BLINDTRANSFER after retransmission, "
              f"transferer BYE, all {expected_channels} channels ended")
        if lose_response:
            print("PASS lost REFER response: exactly one transfer, target execution, "
                  "outbound target dialog, and post-transfer RTP echo")
        if lose_terminal_ack:
            print("PASS lost terminal NOTIFY acknowledgement: one transfer and target "
                  "execution, outbound dialog and RTP echo, all channels ended")
        if lose_all_terminal_acks:
            verify_notify_retry_window(probe, linkedid)
    finally:
        if executor:
            executor.shutdown(wait=True)
        try:
            if peer_result:
                peer_result.result()
        finally:
            if peer:
                peer.close()
            probe.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--blind-progress", choices=("yes", "no"), default="yes")
    args = parser.parse_args()
    password = read_password(Path("/run/proof/pjsip.conf"))
    for subscribed in (False, True):
        for outcome in ("answered", "busy", "timeout", "unknown", "peer", "peer-busy"):
            run_transfer(args.host, password, subscribed, args.blind_progress, outcome)
        for outcome in ("unknown", "peer"):
            run_transfer(args.host, password, subscribed, args.blind_progress, outcome,
                         lose_response=True)
            if subscribed:
                run_transfer(args.host, password, subscribed, args.blind_progress, outcome,
                             lose_terminal_ack=True)
                run_transfer(args.host, password, subscribed, args.blind_progress, outcome,
                             lose_all_terminal_acks=True)


if __name__ == "__main__":
    main()
