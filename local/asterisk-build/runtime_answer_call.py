import json
import re
import time

import runtime_image as runtime


CONTEXT = "isolated-local-answer-proof"
MEMBER = f"Local/member@{CONTEXT}/n"


def prepare(root):
    (root / "etc/extensions.conf").write_text(
        "[general]\nstatic=yes\nwriteprotect=yes\n"
        f"[{CONTEXT}]\n"
        "exten => start,1,Answer()\n"
        " same => n,Queue(proof-queue,rc,,,12)\n"
        " same => n,Wait(5)\n"
        " same => n,Hangup()\n"
        "exten => member,1,Wait(2)\n"
        " same => n,Answer()\n"
        " same => n,Wait(4)\n"
        " same => n,Hangup()\n"
    )


def channels(output):
    rows = []
    for line in output.splitlines():
        fields = line.split("!")
        if len(fields) < 12 or not any(fields[0].startswith(
                f"Local/{extension}@{CONTEXT}-") for extension in ("start", "member")):
            raise ValueError(f"Unexpected answered-fixture channel: {line!r}")
        rows.append(dict(name=fields[0], application=fields[5], data=fields[6]))
    return rows


def policy(output, members):
    if len(output.encode()) > 8192 or len(output.splitlines()) != 1:
        raise ValueError("Expected one bounded policy JSON line")
    response = json.loads(output)
    expected = runtime.read_json(runtime.HERE / "runtime-bundle-smoke-report.json")["observations"][0]["response"]
    if (response.keys() != expected.keys()
            or any(response[key] != expected[key] for key in expected if key != "objects")
            or len(response["objects"]) != 2):
        raise ValueError("Unexpected answered-fixture policy envelope")
    proof = None
    for actual, baseline in zip(response["objects"], expected["objects"]):
        if baseline["name"] == "proof-queue":
            static = dict(actual)
            count = static.pop("callerCount")
            empty = static.pop("callerListEmpty")
            wanted = {key: value for key, value in baseline.items()
                      if key not in ("callerCount", "callerListEmpty")}
            wanted["memberCount"] = members
            if (static != wanted or type(count) is not int or count not in (0, 1)
                    or type(empty) is not bool or empty != (count == 0)):
                raise ValueError("Unexpected answered-fixture loaded queue state")
            proof = actual
        elif actual != baseline:
            raise ValueError("Unrelated loaded queue changed")
    return proof


def result_variables(detail):
    values = {}
    for name in ("QUEUESTATUS", "ANSWEREDTIME_MS", "DIALEDTIME_MS"):
        matches = re.findall(r"^\s*" + name + r"=(\S+)\s*$", detail, re.MULTILINE)
        if len(matches) != 1:
            raise ValueError(f"Expected exactly one answered result variable: {name}")
        values[name] = matches[0]
    if (values["QUEUESTATUS"] != "CONTINUE" or not values["ANSWEREDTIME_MS"].isdigit()
            or not 3500 <= int(values["ANSWEREDTIME_MS"]) < 7000
            or not values["DIALEDTIME_MS"].isdigit()
            or int(values["DIALEDTIME_MS"]) < int(values["ANSWEREDTIME_MS"])):
        raise ValueError(f"Unexpected answered-member result: {values}")
    return values


def execute(cli):
    if channels(cli("core show channels concise")):
        raise ValueError("Answered proof requires zero initial channels")
    before = policy(cli(f"queue policy snapshot {runtime.NAMESPACE}"), 0)
    added = cli(f"queue add member {MEMBER} to proof-queue")
    if f"Added interface '{MEMBER}' to queue 'proof-queue'" not in added:
        raise ValueError(f"Member addition failed: {added!r}")
    member_state = policy(cli(f"queue policy snapshot {runtime.NAMESPACE}"), 1)
    if member_state["callerCount"] != 0:
        raise ValueError("Unexpected caller before origination")
    started = time.monotonic()
    response = cli(f"channel originate Local/start@{CONTEXT}/n application Wait 25")
    if response.strip():
        raise ValueError(f"Unexpected originate response: {response!r}")
    seen = set()
    queued = None
    answered_member = None
    variables = None
    detail = None
    while time.monotonic() - started < 25:
        active = channels(cli("core show channels concise"))
        seen.update(row["name"] for row in active)
        observed = policy(cli(f"queue policy snapshot {runtime.NAMESPACE}"), 1)
        if observed["callerCount"] == 1:
            queued = observed
        for row in active:
            if row["name"].startswith("Local/member@") and row["name"].endswith(";2") \
                    and row["application"] == "Wait" and row["data"] == "4":
                answered_member = row
            if row["name"].startswith("Local/start@") and row["name"].endswith(";2") \
                    and row["application"] == "Wait":
                detail = cli("core show channel " + row["name"])
                variables = result_variables(detail)
        if not active and variables:
            if len(seen) != 4 or queued is None or answered_member is None or observed["callerCount"] != 0:
                raise ValueError("Missing queued caller, answered member, four Local legs or cleanup")
            queue_output = cli("queue show proof-queue")
            if not re.search(r"\bC:1\b", queue_output) or "No Callers" not in queue_output:
                raise ValueError(f"Expected one completed call and no callers: {queue_output}")
            removed = cli(f"queue remove member {MEMBER} from proof-queue")
            if removed != f"Removed interface {MEMBER} from queue 'proof-queue'\n":
                raise ValueError(f"Member removal failed: {removed!r}")
            final = policy(cli(f"queue policy snapshot {runtime.NAMESPACE}"), 0)
            if final != before or channels(cli("core show channels concise")):
                raise ValueError("Answered call did not restore empty baseline")
            return dict(
                passed=True, initialPolicy=before, memberAddedPolicy=member_state,
                queuedObservation=queued, answeredMemberObservation=answered_member,
                channelNames=sorted(seen), resultVariables=variables, resultChannelDetails=detail,
                completedQueueOutput=queue_output, finalPolicy=final, finalActiveChannels=0,
                memberRemoved=True, elapsedSeconds=round(time.monotonic() - started, 3),
                syntheticAnswerHoldSeconds=4, sipTested=False, mediaTested=False,
                humanAnsweringTested=False,
            )
        time.sleep(0.1)
    raise TimeoutError("Synthetic answered-member call exceeded 25 seconds")
