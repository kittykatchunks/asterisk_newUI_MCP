"""Private two-identity SIP answered-member fixture and host acceptance."""

import re
import time

import runtime_answer_call as answered
import runtime_image as runtime


MEMBER = "PJSIP/proof-agent"
PHASES = ("registered-both", "agent-ringing", "agent-answered",
          "agent-ended", "call-complete", "unregistered-both")


def configuration(base):
    endpoint = base[base.index("[proof-client]\n"):]
    return base + endpoint.replace("proof-client", "proof-agent").replace("@SECRET@", "@AGENT_SECRET@")


def prepare(root):
    (root / "etc/extensions.conf").write_text(
        "[general]\nstatic=yes\nwriteprotect=yes\n[isolated-sip-proof]\n"
        "exten => queue-answer,1,Answer()\n"
        " same => n,Queue(proof-queue,rc,,,20)\n"
        " same => n,Wait(10)\n same => n,Hangup()\n")


def contacts(output, address, caller_port, agent_port):
    values = re.findall(r"^\s*Contact:\s+(\S+)", output, re.MULTILINE)
    values = [value for value in values if not value.startswith("<")]
    expected = [f"{name}/sip:{name}@{address}:{port}" for name, port in (
        ("proof-client", caller_port), ("proof-agent", agent_port))]
    if (caller_port == agent_port or sorted(values) != sorted(expected)
            or not re.search(r"Objects found:\s*2\s*$", output)):
        raise ValueError("Expected exactly two distinct registered fixture contacts")
    return values


def channels(output, extension="queue-answer", queue_data="proof-queue,rc,,,20",
             wait_data="10"):
    rows = []
    for line in output.splitlines():
        fields = line.split("!")
        if len(fields) < 12 or not re.fullmatch(r"PJSIP/proof-(client|agent)-[a-fA-F0-9]+", fields[0]):
            raise ValueError("Foreign or malformed answered SIP channel")
        if fields[0].startswith("PJSIP/proof-client-") and (
                fields[1:3] != ["isolated-sip-proof", extension]
                or fields[5:7] not in (["Queue", queue_data], ["Wait", wait_data])):
            raise ValueError("Unexpected caller context or queue application")
        rows.append(dict(name=fields[0], state=fields[4], application=fields[5], data=fields[6]))
    if len(rows) != len({row["name"] for row in rows}):
        raise ValueError("Duplicate SIP channel")
    return rows


def remove_member(cli, report):
    response = cli(f"queue remove member {MEMBER} from proof-queue")
    if response != f"Removed interface {MEMBER} from queue 'proof-queue'\n":
        raise ValueError("Failed to remove private SIP member")
    final = answered.policy(cli(f"queue policy snapshot {runtime.NAMESPACE}"), 0)
    if final != report["initialPolicy"]:
        raise ValueError("SIP queue baseline not restored")
    report.update(finalPolicy=final, memberRemoved=True)


def phase(cli, stage, progress, report):
    snapshot = lambda members: answered.policy(
        cli(f"queue policy snapshot {runtime.NAMESPACE}"), members)
    if stage == "registered-both":
        before = snapshot(0)
        if before["callerCount"] or channels(cli("core show channels concise")):
            raise ValueError("Answered SIP proof requires empty initial state")
        response = cli(f"queue add member {MEMBER} to proof-queue")
        if response != f"Added interface '{MEMBER}' to queue 'proof-queue'\n":
            raise ValueError("Failed to add private SIP member")
        report.update(initialPolicy=before, memberAddedPolicy=snapshot(1))
    elif stage in ("agent-ringing", "agent-answered"):
        rows = channels(cli("core show channels concise"))
        if len(rows) != 2 or sum(row["name"].startswith("PJSIP/proof-client-") for row in rows) != 1:
            raise ValueError("Expected caller and agent SIP legs")
        policy = snapshot(1)
        if stage == "agent-ringing":
            if policy["callerCount"] != 1 or not any(
                    row["name"].startswith("PJSIP/proof-agent-") and row["state"] == "Ringing"
                    for row in rows):
                raise ValueError("Missing queued SIP caller while agent rings")
        elif any(row["state"] != "Up" for row in rows):
            raise ValueError("Both SIP legs must be Up after agent ACK")
        if stage == "agent-answered":
            details = [cli("core show channel " + row["name"]) for row in rows]
            bridges = [re.findall(r"^\s*Bridge ID:\s*([a-fA-F0-9-]{36})\s*$", detail, re.MULTILINE)
                       for detail in details]
            if any(len(value) != 1 for value in bridges) or bridges[0] != bridges[1]:
                raise ValueError("SIP caller and agent must share one live bridge")
            report["bridgeId"] = bridges[0][0]
        report[stage] = dict(channels=rows, policy=policy)
    elif stage == "agent-ended":
        deadline = time.monotonic() + 5
        while True:
            rows = channels(cli("core show channels concise"))
            if len(rows) == 1 and rows[0]["application"] == "Wait":
                break
            if time.monotonic() >= deadline:
                raise TimeoutError("Answered SIP result hold not reached in five seconds")
            time.sleep(0.1)
        if (len(rows) != 1 or not rows[0]["name"].startswith("PJSIP/proof-client-")
                or rows[0]["application"] != "Wait" or rows[0]["data"] != "10"):
            raise ValueError("Expected sole caller in post-answer result hold")
        policy = snapshot(1)
        if policy["callerCount"] != 0:
            raise ValueError("Answered queue retained a caller")
        detail = cli("core show channel " + rows[0]["name"])
        report.update(resultVariables=answered.result_variables(detail), resultChannelDetails=detail)
    elif stage == "call-complete":
        deadline = time.monotonic() + 5
        while channels(cli("core show channels concise")):
            if time.monotonic() >= deadline:
                raise TimeoutError("Answered SIP call left active channels after five seconds")
            time.sleep(0.1)
        output = cli("queue show proof-queue")
        if (not re.search(r"\bC:1\b", output) or not re.search(r"\bA:0\b", output)
                or "No Callers" not in output
                or not re.search(r"^\s*PJSIP/proof-agent\b.*has taken 1 calls\b", output, re.MULTILINE)):
            raise ValueError("Expected one completed queue call")
        remove_member(cli, report)
        report["completedQueueOutput"] = output
    elif stage == "unregistered-both":
        if (not report.get("memberRemoved") or "bridgeId" not in report
                or "agent-ringing" not in report or "resultVariables" not in report
                or channels(cli("core show channels concise"))):
            raise ValueError("Answered SIP cleanup incomplete")
        report.update(passed=True, mediaVerified=False, humanAnsweringTested=False)
    else:
        raise ValueError("Unexpected answered SIP phase")
