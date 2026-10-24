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


def run_transfer(host, password, subscribed):
    probe = ReferProbe(host)
    token = uuid.uuid4().hex
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
        extra_headers = [f"Refer-To: <sip:target-{token}@{host}>"]
        if not subscribed:
            extra_headers.append("Refer-Sub: false")
        request = probe.request("REFER", uri=target, extra_headers=extra_headers)
        code, headers, _ = probe.exchange(request, "REFER")
        require(code == (202 if subscribed else 200), f"Unexpected accepted REFER: {code}")
        require(headers.get("refer-sub") == (None if subscribed else ["false"]),
                "Unexpected accepted Refer-Sub response")
        destination = wait_for(probe, "transferee executing target", lambda rows: next(
            (row for row in rows if row["linkedid"] == linkedid
             and user_event(row, "PROOF_REFER_TARGET", f"target-{token}")), None))
        require(destination["uniqueid"] == transferee["uniqueid"],
                "Target marker does not belong to original bridged transferee")

        def target_bridge(rows):
            entries = [row for row in rows if row["linkedid"] == linkedid
                       and row["event"] == "BRIDGE_ENTER"]
            target_entries = [row for row in entries
                              if row["channel"].startswith("Local/answer@refer-proof-")]
            return next((row for row in target_entries if any(
                other["uniqueid"] == transferee["uniqueid"]
                and json.loads(other["extra"])["bridge_id"]
                == json.loads(row["extra"])["bridge_id"] for other in entries)), None)

        answered_target = wait_for(probe, "transferee/target shared bridge", target_bridge)
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
            wait_for(probe, "terminal success NOTIFY", lambda rows: any(
                state.split(";", 1)[0] == "terminated" and status == 200
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
        require(any(row["event"] == "ANSWER" and row["uniqueid"] == answered_target["uniqueid"]
                    for row in related), "Target bridge leg has no ANSWER evidence")
        transfers = [row for row in related if row["event"] == "BLINDTRANSFER"]
        require(len(transfers) == 1 and transfers[0]["uniqueid"] == source_id,
                "Expected exactly one source BLINDTRANSFER CEL event")
        transfer = json.loads(transfers[0]["extra"])
        require(transfer["transferee_channel_uniqueid"] == transferee["uniqueid"]
                and transfer["extension"] == f"target-{token}"
                and transfer["context"] == "sip-proof",
                "BLINDTRANSFER identity/target does not match correlated channels")
        require(sum(user_event(row, "PROOF_REFER_TARGET", f"target-{token}")
                    for row in related) == 1, "Target executed more than once")
        if subscribed:
            terminal = [status for state, status in probe.notifications.values()
                        if state.split(";", 1)[0] == "terminated"]
            require(terminal == [200], f"Unexpected terminal NOTIFY outcomes: {terminal}")
        else:
            require(not probe.notifications, "No-subscription transfer emitted NOTIFY")
        mode = "implicit subscription" if subscribed else "Refer-Sub: false"
        refer_code = 202 if subscribed else 200
        print(f"PASS accepted {mode}: REFER {refer_code}, original transferee reached target, "
              "answered target bridge, one BLINDTRANSFER after retransmission, "
              "transferer BYE, all five channels ended")
    finally:
        probe.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    args = parser.parse_args()
    password = read_password(Path("/run/proof/pjsip.conf"))
    for subscribed in (False, True):
        run_transfer(args.host, password, subscribed)


if __name__ == "__main__":
    main()
