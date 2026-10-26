"""Host observations for a registered SIP member returning Busy Here."""

import re
import time

import runtime_sip_answer as shared
import runtime_local_call as timeout
import runtime_unanswered_call as local_unanswered
import runtime_image as runtime


PHASES = ("registered-both", "agent-ringing", "agent-busy",
          "queue-timeout", "call-complete", "unregistered-both")


def prepare(root):
    (root / "etc/extensions.conf").write_text(
        "[general]\nstatic=yes\nwriteprotect=yes\n[isolated-sip-proof]\n"
        "exten => queue-busy,1,Answer()\n"
        " same => n,Queue(proof-queue,r,,,3)\n"
        " same => n,Wait(10)\n same => n,Hangup()\n")
    local_unanswered.configure_queue(root)


def phase(cli, stage, progress, report):
    def channels():
        return shared.channels(cli("core show channels concise"),
                               "queue-busy", "proof-queue,r,,,3")

    def policy():
        return shared.answered.policy(cli(f"queue policy snapshot {runtime.NAMESPACE}"), 1)

    if stage == "registered-both":
        shared.phase(cli, stage, progress, report)
        report["configuredTimeoutPriority"] = "app"
    elif stage == "agent-ringing":
        rows = channels()
        observed = policy()
        if (len(rows) != 2 or observed["callerCount"] != 1
                or not any(row["name"].startswith("PJSIP/proof-client-")
                           and row["state"] == "Up" and row["application"] == "Queue"
                           for row in rows)
                or not any(row["name"].startswith("PJSIP/proof-agent-")
                           and row["state"] == "Ringing" for row in rows)):
            raise ValueError("Expected one queued SIP caller and one ringing busy member")
        report["ringingObservation"] = dict(channels=rows, policy=observed)
    elif stage == "agent-busy":
        outcome = progress["phases"][-1]
        if (outcome.get("inviteFinalCode") != 486
                or outcome.get("transactionAckSeen") is not True
                or outcome.get("agentAnswered") is not False):
            raise ValueError("Missing Busy Here response and matching non-2xx ACK")
        rows = channels()
        observed = policy()
        caller = next(row for row in report["ringingObservation"]["channels"]
                      if row["name"].startswith("PJSIP/proof-client-"))
        if (len(rows) != 1 or rows[0]["name"] != caller["name"]
                or rows[0]["application"] != "Queue" or observed["callerCount"] != 1):
            raise ValueError("Caller did not remain queued after member Busy Here")
        report["busyObservation"] = dict(channels=rows, policy=observed, transaction=outcome)
    elif stage == "queue-timeout":
        if progress["phases"][-1].get("phase") != "queue-timeout":
            raise ValueError("Missing caller timeout checkpoint")
        caller = next(row["name"] for row in report["ringingObservation"]["channels"]
                      if row["name"].startswith("PJSIP/proof-client-"))
        report["timeoutProgress"] = []
        deadline = time.monotonic() + 5
        while True:
            rows = channels()
            observed = policy()
            if len(report["timeoutProgress"]) >= 64:
                raise ValueError("SIP busy queue timeout exceeds 64 samples")
            report["timeoutProgress"].append(dict(channels=rows, policy=observed))
            if (len(rows) == 1 and rows[0]["name"] == caller and rows[0]["state"] == "Up"
                    and rows[0]["application"] == "Wait"):
                if observed["callerCount"] != 0:
                    raise ValueError("Queue retained caller after Busy Here timeout")
                detail = cli("core show channel " + caller)
                report.update(resultChannelDetails=detail,
                              resultVariables=timeout.result_variables(detail))
                break
            if any(row["name"].startswith("PJSIP/proof-agent-") and row["state"] == "Up"
                   for row in rows):
                raise ValueError("Busy SIP member unexpectedly answered")
            if time.monotonic() >= deadline:
                raise TimeoutError("Busy SIP caller timeout not observed within five seconds")
            time.sleep(0.1)
    elif stage == "call-complete":
        deadline = time.monotonic() + 5
        while channels():
            if time.monotonic() >= deadline:
                raise TimeoutError("Busy SIP caller left active channels after BYE")
            time.sleep(0.1)
        output = cli("queue show proof-queue")
        if (not re.search(r"\bC:0\b", output) or not re.search(r"\bA:1\b", output)
                or "No Callers" not in output
                or not re.search(r"^\s*PJSIP/proof-agent\b.*has taken no calls\b",
                                 output, re.MULTILINE)):
            raise ValueError("Expected one abandoned caller and no completed member calls")
        shared.remove_member(cli, report)
        report["completedQueueOutput"] = output
    elif stage == "unregistered-both":
        if (not report.get("memberRemoved") or "ringingObservation" not in report
                or "busyObservation" not in report or "resultVariables" not in report or channels()):
            raise ValueError("Busy SIP cleanup incomplete")
        report.update(passed=True, mediaVerified=False, humanAnsweringTested=False)
    else:
        raise ValueError("Unexpected busy SIP phase")
