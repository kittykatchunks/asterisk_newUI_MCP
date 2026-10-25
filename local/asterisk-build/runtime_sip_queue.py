"""Host assertions for a private SIP caller's empty-queue timeout."""

import re
import time

import runtime_image as runtime
import runtime_local_call as local_call


CONTEXT = "isolated-sip-proof"
EXTENSION = "queue-timeout"
RESULT_HOLD_SECONDS = 10


def prepare(root):
    (root / "etc/extensions.conf").write_text(
        "[general]\nstatic=yes\nwriteprotect=yes\n"
        f"[{CONTEXT}]\n"
        f"exten => {EXTENSION},1,Answer()\n"
        f" same => n,Queue(proof-queue,r,,,{local_call.QUEUE_SECONDS})\n"
        f" same => n,Wait({RESULT_HOLD_SECONDS})\n"
        " same => n,Hangup()\n")


def channel(output):
    lines = output.splitlines()
    if not lines:
        raise ValueError("Expected one live SIP queue caller")
    if len(lines) != 1:
        raise ValueError("Expected exactly one SIP channel")
    fields = lines[0].split("!")
    if (len(fields) < 12 or not re.fullmatch(r"PJSIP/proof-client-[a-fA-F0-9]+", fields[0])
            or fields[1:3] != [CONTEXT, EXTENSION]
            or fields[5] not in ("Queue", "Wait")):
        raise ValueError("Unexpected SIP queue channel/context/application")
    if fields[5] == "Queue" and fields[6] != f"proof-queue,r,,,{local_call.QUEUE_SECONDS}":
        raise ValueError("Unexpected SIP queue application arguments")
    if fields[5] == "Wait" and fields[6] != str(RESULT_HOLD_SECONDS):
        raise ValueError("Unexpected SIP queue result hold")
    return dict(name=fields[0], application=fields[5], data=fields[6])


def observe(cli, progress=None):
    started = time.monotonic()
    deadline = started + 8
    queued = None
    name = None
    samples = [] if progress is None else progress
    while time.monotonic() < deadline:
        row = channel(cli("core show channels concise"))
        if name is not None and row["name"] != name:
            raise ValueError("SIP caller identity changed during queue proof")
        name = row["name"]
        policy = local_call.policy(cli(f"queue policy snapshot {runtime.NAMESPACE}"))
        if policy["memberCount"] != 0:
            raise ValueError("SIP timeout proof requires an empty-member queue")
        if len(samples) >= 64:
            raise ValueError("SIP queue progress exceeds 64 samples")
        samples.append(dict(elapsedSeconds=round(time.monotonic() - started, 3),
                            channel=row, policy=policy))
        if row["application"] == "Queue" and policy["callerCount"] == 1:
            queued = policy
        if row["application"] == "Wait":
            if queued is None:
                raise ValueError("Did not observe the SIP caller in Queue")
            if policy["callerCount"] != 0:
                raise ValueError("Queue retained caller after timeout")
            detail = cli("core show channel " + name)
            variables = local_call.result_variables(detail)
            return dict(passed=True, channelName=name, queuedPolicy=queued,
                        resultPolicy=policy, resultVariables=variables,
                        resultChannelDetails=detail, progress=samples,
                        mediaVerified=False)
        time.sleep(0.1)
    raise TimeoutError("SIP queue result not observed within eight seconds")
