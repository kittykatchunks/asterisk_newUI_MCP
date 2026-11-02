"""Host observations for a registered SIP member returning Busy Here."""

import hashlib
import re
import time

import runtime_sip_answer as shared
import runtime_local_call as timeout
import runtime_unanswered_call as local_unanswered
import runtime_image as runtime


def capture_failure(report, key, stage, error, output):
    encoded = output.encode("utf-8")
    report.setdefault(key, []).append({
        "stage": stage,
        "error": str(error),
        "outputBytes": len(encoded),
        "outputSha256": hashlib.sha256(encoded).hexdigest(),
        "output": encoded[:8192].decode("utf-8", errors="replace"),
        "truncated": len(encoded) > 8192,
    })


PHASES = ("registered-both", "agent-ringing", "agent-busy",
          "queue-timeout", "call-complete", "unregistered-both")
QUEUE_RETRY_SECONDS = 1


def prepare(root):
    (root / "etc/extensions.conf").write_text(
        "[general]\nstatic=yes\nwriteprotect=yes\n[isolated-sip-proof]\n"
        "exten => queue-busy,1,Answer()\n"
        " same => n,Queue(proof-queue,r,,,3)\n"
        " same => n,Wait(10)\n same => n,Hangup()\n")
    local_unanswered.configure_queue(root)
    queues = root / "etc/queues.conf"
    content = queues.read_text()
    section = "[proof-queue]\ntimeoutpriority=app\n"
    if content.count(section) != 1:
        raise ValueError("Expected exactly one app-priority proof queue")
    queues.write_text(content.replace(
        section, section + f"retry={QUEUE_RETRY_SECONDS}\n", 1))


def phase(cli, stage, progress, report):
    def channels(observation_stage):
        output = cli("core show channels concise")
        try:
            return shared.channels(output, "queue-busy", "proof-queue,r,,,3")
        except ValueError as error:
            capture_failure(report, "channelParserFailures", observation_stage, error, output)
            raise

    def policy():
        return shared.answered.policy(cli(f"queue policy snapshot {runtime.NAMESPACE}"), 1)

    if stage == "registered-both":
        shared.phase(cli, stage, progress, report)
        report.update(configuredTimeoutPriority="app",
                      configuredQueueRetrySeconds=QUEUE_RETRY_SECONDS)
    elif stage == "agent-ringing":
        rows = channels(stage)
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
        rows = channels(stage)
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
            rows = channels(stage)
            observed = policy()
            if len(report["timeoutProgress"]) >= 64:
                raise ValueError("SIP busy queue timeout exceeds 64 samples")
            report["timeoutProgress"].append(dict(channels=rows, policy=observed))
            if (len(rows) == 1 and rows[0]["name"] == caller and rows[0]["state"] == "Up"
                    and rows[0]["application"] == "Wait"):
                if observed["callerCount"] != 0:
                    raise ValueError("Queue retained caller after Busy Here timeout")
                detail = cli("core show channel " + caller)
                try:
                    variables = timeout.result_variables(detail)
                except ValueError as error:
                    capture_failure(report, "resultVariableFailures", stage, error, detail)
                    raise
                report.update(resultChannelDetails=detail, resultVariables=variables)
                break
            if any(row["name"].startswith("PJSIP/proof-agent-") and row["state"] == "Up"
                   for row in rows):
                raise ValueError("Busy SIP member unexpectedly answered")
            if time.monotonic() >= deadline:
                raise TimeoutError("Busy SIP caller timeout not observed within five seconds")
            time.sleep(0.1)
    elif stage == "call-complete":
        transactions = progress["phases"][-1].get("busyTransactions")
        if (not isinstance(transactions, list) or not transactions or len(transactions) > 8
                or not any(item.get("inviteFinalCode") == 486
                           and item.get("transactionAckSeen") is True
                           for item in transactions)
                or any(item.get("transactionAckSeen") is not True
                       or item.get("agentAnswered") is not False
                       or item.get("inviteFinalCode") != 486
                       for item in transactions)):
            raise ValueError("Busy queue retries lack correlated 486/ACK completion")
        deadline = time.monotonic() + 5
        while channels(stage):
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
        report.update(busyTransactions=transactions, completedQueueOutput=output)
    elif stage == "unregistered-both":
        if (not report.get("memberRemoved") or "ringingObservation" not in report
                or "busyObservation" not in report or "busyTransactions" not in report
                or "resultVariables" not in report
                or channels(stage)):
            raise ValueError("Busy SIP cleanup incomplete")
        report.update(passed=True, mediaVerified=False, humanAnsweringTested=False)
    else:
        raise ValueError("Unexpected busy SIP phase")
