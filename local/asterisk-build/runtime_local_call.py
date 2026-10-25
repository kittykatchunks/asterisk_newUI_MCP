import json
import re
import time

import runtime_image as runtime


CONTEXT = "isolated-local-queue-proof"
QUEUE_SECONDS = 3
RESULT_HOLD_SECONDS = 5


def prepare(root):
    (root / "etc/extensions.conf").write_text(
        "[general]\nstatic=yes\nwriteprotect=yes\n"
        f"[{CONTEXT}]\n"
        "exten => start,1,Answer()\n"
        f" same => n,Queue(proof-queue,r,,,{QUEUE_SECONDS})\n"
        f" same => n,Wait({RESULT_HOLD_SECONDS})\n"
        " same => n,Hangup()\n"
    )


def channels(output):
    rows = []
    for line in output.splitlines():
        fields = line.split("!")
        if len(fields) < 12:
            raise ValueError(f"Unexpected concise channel row: {line!r}")
        if not fields[0].startswith(f"Local/start@{CONTEXT}-"):
            raise ValueError(f"Foreign channel in isolated fixture: {fields[0]}")
        rows.append(dict(name=fields[0], application=fields[5], data=fields[6]))
    return rows


def policy(output):
    if len(output.encode()) > 8192 or len(output.splitlines()) != 1:
        raise ValueError("Queue policy must be one bounded JSON line")
    response = json.loads(output)
    baseline = runtime.read_json(runtime.HERE / "runtime-bundle-smoke-report.json")["observations"][0]["response"]
    if (response.keys() != baseline.keys()
            or any(response[key] != baseline[key] for key in baseline if key != "objects")):
        raise ValueError("Unexpected queue-policy envelope")
    if len(response["objects"]) != 2:
        raise ValueError("Expected exactly two queue-policy rows")
    proof = None
    for actual, expected in zip(response["objects"], baseline["objects"]):
        if actual["name"] == "proof-queue":
            static = {key: value for key, value in actual.items()
                      if key not in ("callerCount", "callerListEmpty")}
            expected_static = {key: value for key, value in expected.items()
                               if key not in ("callerCount", "callerListEmpty")}
            if static != expected_static:
                raise ValueError("Loaded queue policy changed during synthetic call")
            if (type(actual["callerCount"]) is not int or actual["callerCount"] not in (0, 1)
                    or type(actual["callerListEmpty"]) is not bool
                    or actual["callerListEmpty"] != (actual["callerCount"] == 0)):
                raise ValueError("Inconsistent synthetic caller count/list state")
            proof = actual
        elif actual != expected:
            raise ValueError("Unrelated queue policy changed during synthetic call")
    if proof is None:
        raise ValueError("Missing proof queue")
    return proof


def result_variables(detail):
    values = {}
    for name in ["QUEUESTATUS", "QUEUEWAIT_MS", "ANSWEREDTIME_MS", "ABANDONED"]:
        matches = re.findall(r"^\s*" + name + r"=(\S+)\s*$", detail, re.MULTILINE)
        if len(matches) != 1:
            raise ValueError(f"Expected one result variable: {name}")
        values[name] = matches[0]
    if (values["QUEUESTATUS"] != "TIMEOUT" or values["ANSWEREDTIME_MS"] != "0"
            or values["ABANDONED"] != "TRUE" or not values["QUEUEWAIT_MS"].isdigit()
            or not QUEUE_SECONDS * 1000 <= int(values["QUEUEWAIT_MS"]) < (QUEUE_SECONDS + 1) * 1000):
        raise ValueError(f"Unexpected synthetic queue timeout result: {values}")
    return values


def execute(cli):
    if channels(cli("core show channels concise")):
        raise ValueError("Synthetic call requires zero initial channels")
    before = policy(cli(f"queue policy snapshot {runtime.NAMESPACE}"))
    if before["callerCount"] != 0:
        raise ValueError("Synthetic queue not initially empty")
    started = time.monotonic()
    originated = cli(f"channel originate Local/start@{CONTEXT}/n application Wait 20")
    if originated.strip():
        raise ValueError(f"Unexpected originate response: {originated!r}")
    deadline = started + 25
    queued = None
    status = None
    channel_seen = set()
    channel_details = None
    variables = None
    while time.monotonic() < deadline:
        active = channels(cli("core show channels concise"))
        channel_seen.update(row["name"] for row in active)
        observed = policy(cli(f"queue policy snapshot {runtime.NAMESPACE}"))
        if observed["callerCount"] == 1:
            queued = dict(elapsedSeconds=round(time.monotonic() - started, 3), policy=observed)
        for row in active:
            if row["name"].endswith(";2") and row["application"] == "Wait":
                detail = cli("core show channel " + row["name"])
                variables = result_variables(detail)
                status = variables["QUEUESTATUS"]
                channel_details = detail
        if not active and status:
            elapsed = time.monotonic() - started
            if queued is None or len(channel_seen) != 2:
                raise ValueError("Did not observe one queued caller and both Local channel legs")
            if not QUEUE_SECONDS <= elapsed < 25:
                raise ValueError(f"Unexpected synthetic call duration: {elapsed}")
            if observed["callerCount"] != 0:
                raise ValueError("Queue retained caller after channel cleanup")
            return dict(
                passed=True, channelNames=sorted(channel_seen), initialPolicy=before,
                queuedObservation=queued, queueStatus=status, resultChannelDetails=channel_details,
                resultVariables=variables,
                finalPolicy=observed, finalActiveChannels=0,
                elapsedSeconds=round(elapsed, 3), queueTimeoutSeconds=QUEUE_SECONDS,
                resultHoldSeconds=RESULT_HOLD_SECONDS, sipTested=False, mediaTested=False,
                humanAnsweringTested=False,
            )
        time.sleep(0.1)
    raise TimeoutError("Synthetic Local-channel call did not finish within 25 seconds")
