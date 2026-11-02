import argparse
import hashlib
import importlib.util
import json
import pathlib
import re
import shutil
import sys
import uuid


HERE = pathlib.Path(__file__).resolve().parent
NAMESPACE_PATTERN = re.compile(r"cp-[0-9a-f]{24}\Z")
MAX_ATTEMPTS = 10
MIN_DAEMON_MEMORY_BYTES = 6 * 1024 * 1024 * 1024


if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
import runtime_image as runtime

_desktop_spec = importlib.util.spec_from_file_location(
    "asterisk_smoke_desktop", HERE / "smoke-desktop.py"
)
if _desktop_spec is None or _desktop_spec.loader is None:
    raise ImportError("Could not load the reviewed Docker Desktop smoke helpers")
desktop = importlib.util.module_from_spec(_desktop_spec)
sys.modules[_desktop_spec.name] = desktop
_desktop_spec.loader.exec_module(desktop)


def validate_attempt(attempt):
    if not isinstance(attempt, int) or isinstance(attempt, bool) or not 1 <= attempt <= MAX_ATTEMPTS:
        raise ValueError(f"Attempt must be between 1 and {MAX_ATTEMPTS}")


def validate_namespace(namespace):
    if not isinstance(namespace, str) or not NAMESPACE_PATTERN.fullmatch(namespace):
        raise ValueError("Namespace must be cp- followed by 24 lowercase hexadecimal digits")


def expected_snapshot(namespace, include_target=True):
    validate_namespace(namespace)
    objects = []
    if include_target:
        objects.append({
            "name": namespace + "-smoke",
            "origin": "static",
            "strategy": "ringall",
            "memberTimeoutSeconds": 11,
            "joinEmptyMask": 0,
            "leaveWhenEmptyMask": 0,
            "memberCount": 0,
            "callerCount": 0,
            "callerListEmpty": True,
        })
    objects.append({
        "name": "proof-queue",
        "origin": "static",
        "strategy": "ringall",
        "memberTimeoutSeconds": 7,
        "joinEmptyMask": 0,
        "leaveWhenEmptyMask": 0,
        "memberCount": 0,
        "callerCount": 0,
        "callerListEmpty": True,
    })
    objects.sort(key=lambda item: item["name"])
    return {
        "schemaVersion": 1,
        "reader": "app-queue-policy-v1",
        "maskMapping": "asterisk-22-empty-v1",
        "status": "observed",
        "namespace": namespace,
        "consistency": "bounded-per-object-sample",
        "objects": objects,
    }


def validate_snapshot(raw, expected):
    if len(raw.encode("utf-8")) > 8192:
        raise ValueError("Queue policy response exceeds 8 KiB")
    if len(raw.splitlines()) != 1:
        raise ValueError("Queue policy response must be exactly one line")
    try:
        actual = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ValueError("Queue policy response is not valid JSON") from error
    if actual != expected:
        raise ValueError("Queue policy response differs from the exact expected facts")
    return actual


def write_queue_configuration(path, namespace, include_target=True, include_disk_only=False):
    validate_namespace(namespace)
    sections = [
        "[general]\npersistentmembers=no",
        "[proof-queue]\nstrategy=ringall\ntimeout=7\njoinempty=yes\nleavewhenempty=no",
    ]
    if include_target:
        sections.append(
            f"[{namespace}-smoke]\nstrategy=ringall\ntimeout=11\n"
            "joinempty=yes\nleavewhenempty=no"
        )
    if include_disk_only:
        sections.append(
            f"[{namespace}-disk-only]\nstrategy=linear\ntimeout=23\n"
            "joinempty=yes\nleavewhenempty=no"
        )
    sections.append(
        "[unrelated-queue]\nstrategy=ringall\ntimeout=99\njoinempty=yes\nleavewhenempty=no"
    )
    path.write_text("\n".join(sections) + "\n")


def fixture(root, namespace):
    root.mkdir(parents=True, exist_ok=False)
    runtime.fixture(root)
    config = root / "etc/asterisk.conf"
    content = config.read_text()
    for name in ["data", "db", "spool", "log", "run", "cache"]:
        content = content.replace("/state/" + name, "/state")
    content = content.replace("/state/keys", "/fixture/keys")
    config.write_text(content)
    (root / "etc/keys/keys").mkdir(parents=True)
    write_queue_configuration(root / "etc/queues.conf", namespace)


def container_arguments(image, name, owner, root):
    arguments = desktop.arguments(image, name, owner, root)
    resource_limits = {
        "--cpus=4": "--cpus=2",
        "--memory=4g": "--memory=2g",
        "--memory-swap=4g": "--memory-swap=2g",
    }
    for existing, bounded in resource_limits.items():
        if arguments.count(existing) != 1:
            raise ValueError(f"Desktop smoke helper resource setting changed: {existing}")
        arguments[arguments.index(existing)] = bounded
    return arguments


def verify_image_lineage(image):
    build_path = HERE / "image-build-validation-nss.json"
    payload_path = HERE / "image-payload-validation-nss.json"
    startup_path = HERE / "image-startup-validation.json"
    bundle_path = HERE / "runtime-bundle-manifest-nss.json"
    original_compile_path = HERE / "compile-report-optional-api.json"
    latest_compile_path = HERE / "compile-report-loader-v1.json"
    build = runtime.read_json(build_path)
    payload = runtime.read_json(payload_path)
    startup = runtime.read_json(startup_path)
    bundle = runtime.read_json(bundle_path)
    original_compile = runtime.read_json(original_compile_path)
    latest_compile = runtime.read_json(latest_compile_path)
    base_patch = runtime.read_json(HERE.parent / "asterisk-patches/queue-policy-v1.json")

    if build["imageId"] != image or payload["imageId"] != image or startup["imageId"] != image:
        raise ValueError("Image build, payload and startup evidence do not bind the selected image")
    if runtime.digest(payload_path) != build["evidence"][payload_path.name]["sha256"]:
        raise ValueError("Image payload evidence hash differs from the image build record")
    if (payload["bundleManifestSha256"] != runtime.digest(bundle_path)
            or runtime.digest(bundle_path) != runtime.MANIFEST_SHA256
            or bundle["patchSha256"] != base_patch["patchSha256"]
            or runtime.digest(original_compile_path) != bundle["compileReportSha256"]
            or original_compile["patchSha256"] != bundle["patchSha256"]):
        raise ValueError("Image source, compile report or runtime bundle lineage mismatch")
    if (startup["runtimeModulesRunning"] != 41
            or startup["processExitCode"] != 0
            or startup["allOwnedSmokeContainersRemoved"] is not True):
        raise ValueError("Pinned image lacks the recorded successful full-module startup")

    bundle_hashes = {entry["path"]: entry["sha256"] for entry in bundle["entries"]}
    original_outputs = next(
        profile["outputs"] for profile in original_compile["profiles"]
        if profile["name"] == "release"
    )
    latest_outputs = next(
        profile["outputs"] for profile in latest_compile["profiles"]
        if profile["name"] == "release"
    )
    exact_matches = sum(
        bundle_hashes.get(output["path"]) == output["sha256"]
        for output in original_outputs
    )
    if len(original_outputs) != 44 or exact_matches != 44:
        raise ValueError("Runtime bundle is not exactly bound to all 44 original release outputs")
    latest_matches = sum(
        bundle_hashes.get(output["path"]) == output["sha256"]
        for output in latest_outputs
    )
    if len(latest_outputs) != 44:
        raise ValueError("Latest Gate B report does not contain 44 release outputs")

    return {
        "imageId": image,
        "localTag": build["localTag"],
        "sourcePatchSha256": bundle["patchSha256"],
        "bundleManifestSha256": runtime.digest(bundle_path),
        "bundleCompileReportSha256": bundle["compileReportSha256"],
        "originalCompileReportSha256": runtime.digest(original_compile_path),
        "originalReleaseOutputs": len(original_outputs),
        "originalReleaseOutputsMatched": exact_matches,
        "latestGateBCompileReportSha256": runtime.digest(latest_compile_path),
        "latestGateBReleaseOutputs": len(latest_outputs),
        "latestGateBReleaseOutputsMatchedToExistingBundle": latest_matches,
        "latestGateBOutputMatchNote": (
            "The existing image is bound to the earlier source-candidate compile; "
            "its outputs are not byte-identical to the newer Gate B compile."
        ),
        "imagePayloadValidationSha256": runtime.digest(payload_path),
        "imageBuildValidationSha256": runtime.digest(build_path),
        "imageStartupValidationSha256": runtime.digest(startup_path),
    }


def verify_container(container, owner, name, root):
    if container["Name"] != "/" + name:
        raise ValueError("Owned container name does not match the requested unique name")
    labels = container["Config"].get("Labels") or {}
    if labels.get("org.asterisk.local.smoke-owner") != owner:
        raise ValueError("Container ownership label mismatch")
    host = container["HostConfig"]
    expected = {
        "NetworkMode": "none",
        "ReadonlyRootfs": True,
        "Privileged": False,
        "Memory": 2147483648,
        "MemorySwap": 2147483648,
        "NanoCpus": 2000000000,
        "PidsLimit": 256,
    }
    for key, value in expected.items():
        if host.get(key) != value:
            raise ValueError(f"Container isolation/resource mismatch: {key}")
    if (host.get("PortBindings") or host.get("CapDrop") != ["ALL"]
            or "no-new-privileges:true" not in host.get("SecurityOpt", [])
            or container["Config"].get("User") != "10001:10001"):
        raise ValueError("Container exposes a port or lacks required restrictions")
    mounts = container["Mounts"]
    fixture_mounts = [
        mount for mount in mounts if mount["Destination"] == "/fixture"
    ]
    state_tmpfs = host.get("Tmpfs") or {}
    if (len(mounts) != 1 or len(fixture_mounts) != 1
            or fixture_mounts[0]["Type"] != "bind" or fixture_mounts[0]["RW"]
            or pathlib.Path(fixture_mounts[0]["Source"]).name != "etc"
            or state_tmpfs != {
                "/state": "rw,noexec,nosuid,size=67108864,uid=10001,gid=10001,mode=0700"
            }
            or not fixture_mounts[0]["Source"].replace("\\", "/").endswith(
                f"/{root.parent.name}/{root.name}/etc"
            )):
        raise ValueError("Container mounts do not match its private read-only fixture and tmpfs state")
    return {
        **expected,
        "portBindings": host.get("PortBindings"),
        "capDrop": host.get("CapDrop"),
        "securityOpt": host.get("SecurityOpt"),
        "fixtureMountReadOnly": True,
        "privateTmpfsState": True,
    }


def docker_inspect(container_id):
    return json.loads(desktop.command(["inspect", container_id])[0])[0]


def run_proof(work_dir, report_path, attempt):
    validate_attempt(attempt)
    work_dir = work_dir.resolve()
    report_path = report_path.resolve()
    if "," in str(work_dir):
        raise ValueError("Docker bind-mount work path cannot contain commas")
    if report_path.exists():
        raise FileExistsError(f"Refusing to overwrite existing Gate C report: {report_path}")
    work_dir.mkdir(parents=True, exist_ok=True)
    run_id = uuid.uuid4().hex
    owner = run_id
    fixture_base = work_dir / "fixtures" / run_id
    fixture_base.mkdir(parents=True, exist_ok=False)
    namespaces = [
        "cp-" + hashlib.sha256((run_id + "-customer-a").encode()).hexdigest()[:24],
        "cp-" + hashlib.sha256((run_id + "-customer-b").encode()).hexdigest()[:24],
    ]
    if namespaces[0] == namespaces[1]:
        raise ValueError("Generated customer namespaces are not unique")
    customers = []
    for label, suffix, namespace in [
        ("customer-a", "a", namespaces[0]),
        ("customer-b", "b", namespaces[1]),
    ]:
        root = fixture_base / label
        customers.append({
            "label": label,
            "namespace": namespace,
            "queueName": namespace + "-smoke",
            "diskOnlyQueueName": namespace + "-disk-only",
            "name": f"asterisk-gate-c-{run_id[:12]}-{suffix}",
            "root": root,
        })

    report = {
        "schemaVersion": 1,
        "stage": "two-pbx-static-queue-policy-gate-c-proof",
        "attempt": attempt,
        "runnerSha256": runtime.digest(HERE / "runtime-two-pbx-gate-c.py"),
        "runnerSha256Normalization": "raw-execution-file-bytes",
        "evidenceFileHashNormalization": (
            "Raw file bytes from this Windows worktree; CRLF files differ from LF-normalized Git blobs."
        ),
        "passed": False,
        "authorization": (
            "User approved two uniquely owned disposable custom-image PBXs; "
            "no build, export, push, reload, call, apply or shared-PBX access."
        ),
        "imageLineage": {},
        "containers": [],
        "observations": [],
        "actions": {
            "queueReloadIssued": False,
            "callIssued": False,
            "runtimeApplyIssued": False,
            "productionOrSharedRuntimeAccessed": False,
            "imageBuiltOrExported": False,
            "registryPushed": False,
        },
        "exitCodes": {},
        "allOwnedContainersRemoved": False,
        "fixtureConfigurationRemoved": False,
        "runtimeApplyAuthorized": False,
        "existingPbxOperated": False,
        "callsOrMediaTested": False,
        "redistributionApproved": False,
        "licenseClosureComplete": False,
        "gateAAcceptanceComplete": False,
    }
    original_error = None
    cleanup_errors = []
    try:
        image, payload_path = desktop.verify_image()
        info = json.loads(desktop.command(["info", "--format", "{{json .}}"])[0])
        if (info["OSType"] != "linux" or info["Architecture"] not in ("x86_64", "amd64")):
            raise ValueError("Gate C image requires the verified local Linux amd64 daemon")
        if info["MemTotal"] < MIN_DAEMON_MEMORY_BYTES or info["NCPU"] < 4:
            raise ValueError("Docker Desktop lacks the minimum memory/CPU headroom for two PBXs")
        report["imageLineage"] = verify_image_lineage(image)
        report["imageLineage"]["imagePayloadSha256"] = runtime.digest(payload_path)
        report["dockerDaemon"] = {
            "osType": info["OSType"],
            "architecture": info["Architecture"],
            "context": "desktop-linux",
        }

        for customer in customers:
            fixture(customer["root"], customer["namespace"])
        for customer in customers:
            launch = container_arguments(
                image, customer["name"], owner, customer["root"]
            )
            container_id = desktop.command(launch)[0].strip()
            if not re.fullmatch(r"[a-f0-9]{64}", container_id):
                raise ValueError("Docker did not return a valid owned container ID")
            customer["containerId"] = container_id
            inspected = docker_inspect(container_id)
            if inspected["Image"] != image:
                raise ValueError(f"{customer['label']} started from an unexpected image ID")
            isolation = verify_container(
                inspected, owner, customer["name"], customer["root"]
            )
            report["containers"].append({
                "customer": customer["label"],
                "namespace": customer["namespace"],
                "containerName": customer["name"],
                "containerId": container_id,
                "ownerLabel": owner,
                "imageId": inspected["Image"],
                "isolation": isolation,
            })
        if len({customer["containerId"] for customer in customers}) != 2:
            raise ValueError("Customer fixtures did not start as two distinct containers")
        if len({item["isolation"]["fixtureMountReadOnly"] for item in report["containers"]}) != 1:
            raise ValueError("Customer fixture mount isolation differs")
        sources = []
        for item, customer in zip(report["containers"], customers):
            inspected = docker_inspect(item["containerId"])
            source = next(
                mount["Source"] for mount in inspected["Mounts"]
                if mount["Destination"] == "/fixture"
            )
            sources.append(source)
        if len(set(sources)) != 2:
            raise ValueError("Customer PBXs do not have distinct configuration sources")
        report["distinctReadOnlyFixtureSources"] = True

        diagnostics = []
        for customer in customers:
            container_id = customer["containerId"]
            if desktop.cli(container_id, "core waitfullybooted", diagnostics) != \
                    "Asterisk has fully booted.\n":
                raise ValueError(f"{customer['label']} did not fully boot")
            modules = runtime.check_modules(
                desktop.cli(container_id, "module show", diagnostics)
            )
            report["containers"][customers.index(customer)]["loadedModules"] = modules
            for name in ["endpoints", "transports"]:
                response = desktop.cli(
                    container_id, f"pjsip show {name}", diagnostics
                ).strip()
                if response != "No objects found.":
                    raise ValueError(f"Unexpected PJSIP {name} in {customer['label']}")
            report["containers"][customers.index(customer)]["pjsipObjectsAbsent"] = True
        report["cliDiagnostics"] = diagnostics

        def observe(customer, stage, namespace, expected, description):
            raw = desktop.cli(
                customer["containerId"],
                f"queue policy snapshot {namespace}",
                diagnostics,
            )
            response = validate_snapshot(raw, expected)
            report["observations"].append({
                "customer": customer["label"],
                "stage": stage,
                "queryNamespace": namespace,
                "description": description,
                "response": response,
            })
            return response

        for customer in customers:
            observe(
                customer, "initial-own-static-facts", customer["namespace"],
                expected_snapshot(customer["namespace"]),
                "Own namespace returns exact static target and shared baseline facts.",
            )
        for customer, other in [(customers[0], customers[1]), (customers[1], customers[0])]:
            observe(
                customer, "other-customer-namespace-isolation", other["namespace"],
                expected_snapshot(other["namespace"], include_target=False),
                "Other customer's target is absent; only this PBX's baseline is observable.",
            )

        for customer in customers:
            queue_path = customer["root"] / "etc/queues.conf"
            write_queue_configuration(
                queue_path, customer["namespace"], include_target=True,
                include_disk_only=True,
            )
            disk_text = queue_path.read_text()
            if f"[{customer['diskOnlyQueueName']}]" not in disk_text:
                raise ValueError("Disk-only queue fixture was not written")
            disk_response = observe(
                customer, "disk-only-queue-not-loaded", customer["namespace"],
                expected_snapshot(customer["namespace"]),
                "Disk-only queue is absent from the live snapshot without a reload.",
            )
            if any(row["name"] == customer["diskOnlyQueueName"]
                   for row in disk_response["objects"]):
                raise ValueError("Disk-only queue unexpectedly appeared in loaded state")

            write_queue_configuration(
                queue_path, customer["namespace"], include_target=False,
                include_disk_only=False,
            )
            if f"[{customer['queueName']}]" in queue_path.read_text():
                raise ValueError("Loaded-only queue fixture remains on disk")
            loaded_response = observe(
                customer, "loaded-only-queue-remains-visible", customer["namespace"],
                expected_snapshot(customer["namespace"]),
                "Queue removed from disk remains visible in loaded state without a reload.",
            )
            if not any(row["name"] == customer["queueName"]
                       for row in loaded_response["objects"]):
                raise ValueError("Loaded-only queue disappeared without a reload")

        for customer in customers:
            container_id = customer["containerId"]
            desktop.command(["stop", "--timeout=10", container_id], timeout=15)
            exit_code = desktop.command(["wait", container_id], timeout=15)[0].strip()
            state = json.loads(
                desktop.command(["inspect", "--format", "{{json .State}}", container_id])[0]
            )
            if exit_code != "0" or state["Running"] or state["OOMKilled"]:
                raise ValueError(f"{customer['label']} did not stop cleanly: {state}")
            report["exitCodes"][customer["label"]] = int(exit_code)
    except Exception as error:
        original_error = error
        report["failure"] = repr(error)

    expected_names = {customer["name"] for customer in customers}
    try:
        matches = desktop.command([
            "ps", "--all", "--filter",
            f"label=org.asterisk.local.smoke-owner={owner}", "--format", "{{.ID}}",
        ])[0].splitlines()
        if len(matches) > 2:
            raise RuntimeError("More than two containers carry the unique Gate C owner label")
        removed = []
        for container_id in matches:
            owned = docker_inspect(container_id)
            name = owned["Name"].lstrip("/")
            if (name not in expected_names
                    or (owned["Config"].get("Labels") or {}).get(
                        "org.asterisk.local.smoke-owner"
                    ) != owner):
                raise RuntimeError("Refusing to remove a container with mismatched ownership")
            expected_id = next(
                (customer.get("containerId") for customer in customers
                 if customer["name"] == name),
                None,
            )
            if expected_id and expected_id != owned["Id"]:
                raise RuntimeError("Owned container ID differs from the recorded launch")
            desktop.command(["rm", "--force", owned["Id"]])
            removed.append(name)
        remaining = desktop.command([
            "ps", "--all", "--filter",
            f"label=org.asterisk.local.smoke-owner={owner}", "--format", "{{.ID}}",
        ])[0].splitlines()
        if remaining:
            raise RuntimeError("Owned Gate C containers remain after cleanup")
        started_names = {
            customer["name"] for customer in customers if "containerId" in customer
        }
        if not started_names.issubset(set(removed)):
            raise RuntimeError("Not all confirmed Gate C containers were removed")
        report["removedContainerNames"] = sorted(removed)
        report["allOwnedContainersRemoved"] = True
        for customer in customers:
            root = customer["root"]
            if root.exists():
                if root.parent != fixture_base or root.is_symlink():
                    raise RuntimeError("Refusing fixture cleanup outside the owned attempt directory")
                shutil.rmtree(root)
        if fixture_base.exists():
            fixture_base.rmdir()
        report["fixtureConfigurationRemoved"] = True
    except Exception as error:
        cleanup_errors.append(repr(error))
        report["cleanupErrors"] = cleanup_errors

    report["passed"] = original_error is None and not cleanup_errors
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_bytes((json.dumps(report, indent=2) + "\n").encode("utf-8"))

    if cleanup_errors:
        message = "Gate C cleanup failed: " + "; ".join(cleanup_errors)
        if original_error is not None:
            raise RuntimeError(f"{message}; original failure: {original_error!r}") from original_error
        raise RuntimeError(message)
    if original_error is not None:
        raise original_error
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--approve-gate-c-runtime-proof", action="store_true", required=True)
    parser.add_argument("--attempt", type=int, required=True)
    parser.add_argument("--work-dir", type=pathlib.Path, required=True)
    parser.add_argument("--report", type=pathlib.Path, required=True)
    args = parser.parse_args()
    print(json.dumps(
        run_proof(args.work_dir, args.report, args.attempt),
        indent=2,
    ))


if __name__ == "__main__":
    main()
