"""Host observations for a caller that hangs up while the SIP member rings."""

import re
import time

import runtime_sip_answer as shared
import runtime_unanswered_call as local_unanswered
import runtime_image as runtime


PHASES = ("registered-both", "agent-ringing", "caller-abandoned",
          "call-complete", "unregistered-both")


def prepare(root):
    (root / "etc/extensions.conf").write_text(
        "[general]\nstatic=yes\nwriteprotect=yes\n[isolated-sip-proof]\n"
        "exten => queue-abandon,1,Answer()\n"
        " same => n,Queue(proof-queue,r,,,10)\n"
        " same => n,Wait(20)\n same => n,Hangup()\n")
    local_unanswered.configure_queue(root)


def phase(cli, stage, progress, report):
    def channels():
        return shared.channels(cli("core show channels concise"),
                               "queue-abandon", "proof-queue,r,,,10", "20")

    def policy():
        return shared.answered.policy(cli(f"queue policy snapshot {runtime.NAMESPACE}"), 1)

    def queue_output():
        return cli("queue show proof-queue")

    def assert_abandoned(output):
        if (not re.search(r"\bC:0\b", output) or not re.search(r"\bA:1\b", output)
                or "No Callers" not in output
                or not re.search(r"^\s*PJSIP/proof-agent\b.*has taken no calls\b",
                                 output, re.MULTILINE)):
            raise ValueError("Expected caller abandonment and no completed agent calls")

    if stage == "registered-both":
        shared.phase(cli, stage, progress, report)
    elif stage == "agent-ringing":
        rows = channels()
        observed = policy()
        if (len(rows) != 2 or observed["callerCount"] != 1
                or sum(row["name"].startswith("PJSIP/proof-client-") for row in rows) != 1
                or not any(row["name"].startswith("PJSIP/proof-client-")
                           and row["state"] == "Up" and row["application"] == "Queue"
                           for row in rows)
                or not any(row["name"].startswith("PJSIP/proof-agent-")
                           and row["state"] == "Ringing" for row in rows)):
            raise ValueError("Expected one queued SIP caller and one ringing agent")
        report["ringingObservation"] = dict(channels=rows, policy=observed)
    elif stage == "caller-abandoned":
        outcome = progress["phases"][-1]
        if (outcome.get("callerByeCode") != 200 or outcome.get("cancelCode") != 200
                or outcome.get("inviteFinalCode") != 487
                or outcome.get("transactionAckSeen") is not True
                or outcome.get("agentAnswered") is not False):
            raise ValueError("Missing caller BYE and correlated agent cancellation")
        report["abandonProgress"] = []
        deadline = time.monotonic() + 5
        while True:
            rows = channels()
            observed = policy()
            output = queue_output()
            if len(report["abandonProgress"]) >= 64:
                raise ValueError("Caller abandonment exceeds 64 samples")
            report["abandonProgress"].append(
                dict(channels=rows, policy=observed, queueOutput=output))
            if not rows:
                if observed["callerCount"] != 0:
                    raise ValueError("Queue retained caller after caller BYE")
                assert_abandoned(output)
                report["abandonment"] = outcome
                break
            if any(row["name"].startswith("PJSIP/proof-agent-") and row["state"] == "Up"
                   for row in rows):
                raise ValueError("Agent answered after caller abandonment")
            if time.monotonic() >= deadline:
                raise TimeoutError("Caller-abandon channels did not drain within five seconds")
            time.sleep(0.1)
    elif stage == "call-complete":
        if channels():
            raise ValueError("Channels remain after caller abandonment")
        output = queue_output()
        assert_abandoned(output)
        shared.remove_member(cli, report)
        report["completedQueueOutput"] = output
    elif stage == "unregistered-both":
        if (not report.get("memberRemoved") or "ringingObservation" not in report
                or "abandonment" not in report or channels()):
            raise ValueError("Caller-abandon cleanup incomplete")
        report.update(passed=True, mediaVerified=False, humanAnsweringTested=False)
    else:
        raise ValueError("Unexpected caller-abandon phase")
