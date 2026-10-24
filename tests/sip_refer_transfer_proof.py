"""Local bridged REFER proof, correlated with read-only CEL evidence."""

import argparse
import csv
import json
import re
import select
import time
import uuid
from pathlib import Path

from sip_refer_proof import ReferProbe
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


def run_transfer(host, password, subscribed, blind_progress, outcome="answered"):
    probe = ReferProbe(host)
    token = uuid.uuid4().hex
    prefix, target_name, dialstatus = {
        "answered": ("target", "answer", "ANSWER"),
        "busy": ("failed", "reject", "BUSY"),
        "timeout": ("timeout", "noanswer", "NOANSWER"),
    }[outcome]
    rejected = outcome != "answered"
    extension = f"{prefix}-{token}"
    probe.uri = f"sip:bridge-{token}@{host}"
    probe.to_value = f"<{probe.uri}>"
    try:
        code, headers, _ = probe.invite(password)
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
                         and row["channel"].startswith("Local/hold@refer-proof-")
                         and json.loads(row["extra"])["bridge_id"] == bridge_id), None)

        transferee = wait_for(probe, "PJSIP/Local shared bridge", original_bridge)
        probe.cseq += 1
        probe.branch = "z9hG4bK" + uuid.uuid4().hex
        extra_headers = [f"Refer-To: <sip:{extension}@{host}>"]
        if not subscribed:
            extra_headers.append("Refer-Sub: false")
        request = probe.request("REFER", uri=target, extra_headers=extra_headers)
        code, headers, _ = probe.exchange(request, "REFER")
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
                                 "Local/noanswer@refer-proof-"))
                            for row in events()),
                    "Target leg started before early NOTIFY observation")
            print("PASS refer_blind_progress=no: terminal NOTIFY 200 observed "
                  "before any target leg started")

        def target_bridge(rows):
            entries = [row for row in rows if row["linkedid"] == linkedid
                       and row["event"] == "BRIDGE_ENTER"]
            target_entries = [row for row in entries
                              if row["channel"].startswith("Local/answer@refer-proof-")]
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
            expected_terminal = 503 if outcome == "busy" and blind_progress == "yes" else 200
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
        require(len(started) == 5, f"Expected source and two Local pairs, found {len(started)} channels")
        if rejected:
            target_ids = {row["uniqueid"] for row in related
                          if row["channel"].startswith(f"Local/{target_name}@refer-proof-")}
            require(len(target_ids) == 2, "Expected rejecting target Local pair")
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
              "transferer BYE, all five channels ended")
    finally:
        probe.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--blind-progress", choices=("yes", "no"), default="yes")
    args = parser.parse_args()
    password = read_password(Path("/run/proof/pjsip.conf"))
    for subscribed in (False, True):
        for outcome in ("answered", "busy", "timeout"):
            run_transfer(args.host, password, subscribed, args.blind_progress, outcome)


if __name__ == "__main__":
    main()
