import re
import time

import runtime_answer_call as member_call
import runtime_image as runtime
import runtime_local_call as timeout_call


CONTEXT = "isolated-local-unanswered-proof"
MEMBER = f"Local/member@{CONTEXT}/n"


def prepare(root):
    (root / "etc/extensions.conf").write_text(
        "[general]\nstatic=yes\nwriteprotect=yes\n"
        f"[{CONTEXT}]\n"
        "exten => start,1,Answer()\n"
        " same => n,Queue(proof-queue,r,,,3)\n"
        " same => n,Wait(5)\n"
        " same => n,Hangup()\n"
        "exten => member,1,Ringing()\n"
        " same => n,Wait(20)\n"
        " same => n,Hangup()\n"
    )


def configure_queue(root):
    queues = root / "etc/queues.conf"
    content = queues.read_text()
    if content.count("[proof-queue]\n") != 1:
        raise ValueError("Expected exactly one private proof queue")
    queues.write_text(content.replace("[proof-queue]\n",
                                      "[proof-queue]\ntimeoutpriority=app\n"))


def execute(cli, root, progress=None):
    if progress is None:
        progress = []
    def channels():
        return member_call.channels(cli("core show channels concise"), CONTEXT)

    def policy(members):
        return member_call.policy(cli(f"queue policy snapshot {runtime.NAMESPACE}"), members)

    if channels():
        raise ValueError("Unanswered proof requires zero initial channels")
    configure_queue(root)
    cli("queue reload parameters proof-queue")
    before = policy(0)
    if before["callerCount"] != 0:
        raise ValueError("Expected empty initial proof queue")
    added = cli(f"queue add member {MEMBER} to proof-queue")
    if added != f"Added interface '{MEMBER}' to queue 'proof-queue'\n":
        raise ValueError(f"Member addition failed: {added!r}")
    member_state = policy(1)
    if member_state["callerCount"] != 0:
        raise ValueError("Unexpected initial caller")
    started = time.monotonic()
    originated = cli(f"channel originate Local/start@{CONTEXT}/n application Wait 25")
    if originated.strip():
        raise ValueError(f"Unexpected originate response: {originated!r}")
    seen = set()
    queued = None
    ringing = None
    variables = None
    detail = None
    while time.monotonic() - started < 25:
        active = channels()
        seen.update(row["name"] for row in active)
        observed = policy(1)
        if len(progress) >= 128:
            raise ValueError("Unanswered proof exceeded 128 diagnostic samples")
        progress.append(dict(channels=active, policy=observed))
        if observed["callerCount"] == 1:
            queued = observed
        for row in active:
            if row["name"].startswith("Local/member@") and row["name"].endswith(";2"):
                if row["application"] == "Wait" and row["data"] == "20":
                    ringing = row
            if row["name"].startswith("Local/start@") and row["name"].endswith(";2") \
                    and row["application"] == "Wait" and variables is None:
                detail = cli("core show channel " + row["name"])
                progress[-1]["resultChannelDetails"] = detail
                variables = timeout_call.result_variables(detail)
        if not active and variables:
            if len(seen) != 4 or queued is None or ringing is None or observed["callerCount"] != 0:
                raise ValueError("Missing attempted member, queued caller, four Local legs or cleanup")
            output = cli("queue show proof-queue")
            if (not re.search(r"\bC:0\b", output) or not re.search(r"\bA:1\b", output)
                    or "has taken no calls" not in output or "No Callers" not in output):
                raise ValueError(f"Expected zero completed calls and one abandonment: {output}")
            removed = cli(f"queue remove member {MEMBER} from proof-queue")
            if removed != f"Removed interface {MEMBER} from queue 'proof-queue'\n":
                raise ValueError(f"Member removal failed: {removed!r}")
            final = policy(0)
            if final != before or channels():
                raise ValueError("Unanswered fixture did not restore empty queue/channel baseline")
            return dict(
                passed=True, initialPolicy=before, memberAddedPolicy=member_state,
                queuedObservation=queued, unansweredMemberObservation=ringing,
                channelNames=sorted(seen), resultVariables=variables, resultChannelDetails=detail,
                completedQueueOutput=output, finalPolicy=final, finalActiveChannels=0,
                memberRemoved=True, queueTimeoutSeconds=3, timeoutPriority="app",
                elapsedSeconds=round(time.monotonic() - started, 3),
                sipTested=False, mediaTested=False, humanAnsweringTested=False,
            )
        time.sleep(0.1)
    raise TimeoutError("Synthetic unanswered-member call exceeded 25 seconds")
