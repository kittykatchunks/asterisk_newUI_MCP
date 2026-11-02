import hashlib
import json
import pathlib
import re
import stat


EXPECTED_PATHS = [
    "include/asterisk/module.h",
    "main/loader.c",
    "main/asterisk.c",
]
EXPECTED_OUTPUT_PATHS = [
    "apps/app_queue.c",
    "tests/test_bounded_queue_policy.c",
    "tests/test_protected_cli_target.c",
]
EXPECTED_ACCOUNTING_PATHS = [
    "include/asterisk/astobj2.h",
    "main/astobj2.c",
    "main/astobj2_container.c",
    "main/astobj2_hash.c",
]
EXPECTED_ACCOUNTING_WORK_COUNTERS = [
    "AO2 reference calls",
    "AO2 allocations",
    "AO2 container links",
    "AO2 container unlinks",
    "mutex lock attempts and acquisitions",
    "unlock attempts and successes",
    "bucket reads",
    "physical node reads",
]
CLI_OUTPUT_REPORT_FIELDS = (
    "cliOutputSupplementPatchSha256",
    "cliOutputSupplementManifestSha256",
    "cliOutputSupplementParentPatchSha256",
    "cliOutputSupplementParentSupplementPatchSha256",
    "cliOutputSupplementParentSupplementManifestSha256",
)
AO2_ACCOUNTING_REPORT_FIELDS = (
    "ao2AccountingSupplementPatchSha256",
    "ao2AccountingSupplementManifestSha256",
    "ao2AccountingSupplementParentPatchSha256",
    "ao2AccountingSupplementParentSupplementPatchSha256",
    "ao2AccountingSupplementParentSupplementManifestSha256",
    "ao2AccountingSupplementParentOutputSupplementPatchSha256",
    "ao2AccountingSupplementParentOutputSupplementManifestSha256",
)


def _read_regular_file(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError(f"Expected a regular, non-symlink file: {path}")
    return path.read_bytes()


def load_shutdown_supplement(manifest_path, parent_manifest):
    manifest_path = pathlib.Path(manifest_path).absolute()
    manifest_bytes = _read_regular_file(manifest_path)
    manifest = json.loads(manifest_bytes)
    if (
        manifest.get("schemaVersion") != 1
        or manifest.get("stage") != "source-only-shutdown-supervisor-scaffold"
        or manifest.get("upstreamCommit") != parent_manifest["upstreamCommit"]
        or manifest.get("parentManifest") != "queue-policy-v1.json"
        or manifest.get("parentPatchSha256") != parent_manifest["patchSha256"]
        or manifest.get("patch") != "queue-policy-shutdown-v1.patch"
        or manifest.get("changedUpstreamPaths") != EXPECTED_PATHS
        or manifest.get("nativeCompiled") is not False
        or manifest.get("nativeTestsExecuted") is not False
        or manifest.get("patchApplicationVerified") is not False
        or manifest.get("runtimeApplyAuthorized") is not False
        or manifest.get("gatesBAndCApproved") is not False
    ):
        raise ValueError("Shutdown supplement does not match the pinned parent candidate")

    patch_path = manifest_path.parent / manifest["patch"]
    patch_bytes = _read_regular_file(patch_path)
    patch_hash = hashlib.sha256(patch_bytes).hexdigest()
    if manifest.get("patchSha256") != patch_hash:
        raise ValueError("Shutdown supplement patch SHA256 mismatch")
    patch_text = patch_bytes.decode("utf-8")
    patch_paths = re.findall(r"^diff --git a/(\S+) b/(\S+)$", patch_text, re.MULTILINE)
    if patch_paths != [(path, path) for path in EXPECTED_PATHS]:
        raise ValueError("Shutdown supplement diff paths differ from its manifest")

    return manifest, patch_path, patch_hash, hashlib.sha256(manifest_bytes).hexdigest()


def load_cli_output_supplement(
    manifest_path, parent_manifest, shutdown_manifest, shutdown_manifest_hash
):
    manifest_path = pathlib.Path(manifest_path).absolute()
    manifest_bytes = _read_regular_file(manifest_path)
    manifest = json.loads(manifest_bytes)
    if not isinstance(manifest, dict):
        raise ValueError("CLI output supplement manifest must be an object")
    if (
        manifest.get("schemaVersion") != 1
        or manifest.get("stage") != "source-only-cli-output-fixtures-prepared"
        or manifest.get("upstreamCommit") != parent_manifest["upstreamCommit"]
        or manifest.get("parentManifest") != "queue-policy-v1.json"
        or manifest.get("parentPatchSha256") != parent_manifest["patchSha256"]
        or manifest.get("parentSupplementManifest") != "queue-policy-shutdown-v1.json"
        or manifest.get("parentSupplementManifestSha256") != shutdown_manifest_hash
        or manifest.get("parentSupplementPatchSha256") != shutdown_manifest["patchSha256"]
        or manifest.get("patch") != "queue-policy-output-v1.patch"
        or manifest.get("changedUpstreamPaths") != EXPECTED_OUTPUT_PATHS
        or manifest.get("nativeCompiled") is not False
        or manifest.get("nativeTestsExecuted") is not False
        or manifest.get("asteriskStarted") is not False
        or manifest.get("runtimeApplyAuthorized") is not False
        or manifest.get("gatesBAndCApproved") is not False
    ):
        raise ValueError("CLI output supplement does not match the pinned parent supplements")

    if not re.fullmatch(r"[0-9a-f]{64}", shutdown_manifest_hash or ""):
        raise ValueError("CLI output supplement has invalid parent supplement manifest hash")
    for field in ("basisCompileReportSha256", "basisNativeReportSha256"):
        value = manifest.get(field)
        if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
            raise ValueError(f"CLI output supplement has invalid {field}")
    for field in ("basisSourceSha256",):
        hashes = manifest.get(field)
        if (
            not isinstance(hashes, dict)
            or list(hashes) != EXPECTED_OUTPUT_PATHS
            or any(not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value)
                   for value in hashes.values())
        ):
            raise ValueError(f"CLI output supplement has invalid {field}")
    application = manifest.get("applicationVerification", {})
    if not isinstance(application, dict):
        raise ValueError("CLI output supplement has invalid application evidence")
    postimages = application.get("postimageSha256")
    if (
        not isinstance(postimages, dict)
        or list(postimages) != EXPECTED_OUTPUT_PATHS
        or any(not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value)
               for value in postimages.values())
        or application.get("patchDryRunSucceeded") is not True
        or application.get("zeroFuzz") is not True
        or application.get("zeroOffset") is not True
        or application.get("appliedToTemporarySourceCopy") is not True
        or application.get("originalSuccessorSourceModified") is not False
    ):
        raise ValueError("CLI output supplement has invalid application evidence")

    patch_path = manifest_path.parent / manifest["patch"]
    patch_bytes = _read_regular_file(patch_path)
    patch_hash = hashlib.sha256(patch_bytes).hexdigest()
    if manifest.get("patchSha256") != patch_hash:
        raise ValueError("CLI output supplement patch SHA256 mismatch")
    patch_text = patch_bytes.decode("utf-8")
    patch_paths = re.findall(r"^diff --git a/(\S+) b/(\S+)$", patch_text, re.MULTILINE)
    if patch_paths != [(path, path) for path in EXPECTED_OUTPUT_PATHS]:
        raise ValueError("CLI output supplement diff paths differ from its manifest")

    return manifest, patch_path, patch_hash, hashlib.sha256(manifest_bytes).hexdigest()


def verify_cli_output_basis(tree, manifest):
    for relative, expected in manifest["basisSourceSha256"].items():
        path = pathlib.Path(tree) / relative
        if hashlib.sha256(_read_regular_file(path)).hexdigest() != expected:
            raise ValueError(f"CLI output supplement source preimage mismatch: {relative}")


def verify_cli_output_postimages(tree, manifest):
    postimages = manifest["applicationVerification"]["postimageSha256"]
    records = []
    for relative in EXPECTED_OUTPUT_PATHS:
        digest = hashlib.sha256(_read_regular_file(pathlib.Path(tree) / relative)).hexdigest()
        if digest != postimages[relative]:
            raise ValueError(f"CLI output supplement source postimage mismatch: {relative}")
        records.append(dict(path=relative, sha256=digest))
    return records


def load_ao2_accounting_supplement(
    manifest_path,
    parent_manifest,
    shutdown_manifest,
    shutdown_manifest_hash,
    output_manifest,
    output_manifest_hash,
):
    manifest_path = pathlib.Path(manifest_path).absolute()
    manifest_bytes = _read_regular_file(manifest_path)
    manifest = json.loads(manifest_bytes)
    if not isinstance(manifest, dict):
        raise ValueError("AO2 accounting supplement manifest must be an object")
    if (
        manifest.get("schemaVersion") != 1
        or manifest.get("stage") != "source-only-ao2-work-accounting-prepared"
        or manifest.get("upstreamCommit") != parent_manifest["upstreamCommit"]
        or manifest.get("parentManifest") != "queue-policy-v1.json"
        or manifest.get("parentPatchSha256") != parent_manifest["patchSha256"]
        or manifest.get("parentSupplementManifest") != "queue-policy-shutdown-v1.json"
        or manifest.get("parentSupplementManifestSha256") != shutdown_manifest_hash
        or manifest.get("parentSupplementPatchSha256") != shutdown_manifest["patchSha256"]
        or manifest.get("parentOutputSupplementManifest") != "queue-policy-output-v1.json"
        or manifest.get("parentOutputSupplementManifestSha256") != output_manifest_hash
        or manifest.get("parentOutputSupplementPatchSha256") != output_manifest["patchSha256"]
        or manifest.get("basisCompileReport")
        != "../asterisk-build/compile-report-output-v1.json"
        or manifest.get("basisNativeReport")
        != "../asterisk-build/native-test-report-output-v1.json"
        or manifest.get("patch") != "queue-policy-accounting-v1.patch"
        or manifest.get("changedUpstreamPaths") != EXPECTED_ACCOUNTING_PATHS
        or manifest.get("nativeCompileAuthorized") is not False
        or manifest.get("nativeCompiled") is not False
        or manifest.get("nativeTestsExecuted") is not False
        or manifest.get("asteriskStarted") is not False
        or manifest.get("runtimeApplyAuthorized") is not False
        or manifest.get("gatesBAndCApproved") is not False
    ):
        raise ValueError("AO2 accounting supplement does not match the pinned parent supplements")

    for field in ("basisCompileReport", "basisNativeReport"):
        relative = manifest.get(field)
        if not isinstance(relative, str):
            raise ValueError(f"AO2 accounting supplement has invalid {field}")
        report_path = manifest_path.parent / relative
        report_bytes = _read_regular_file(report_path)
        expected_hash = manifest.get(f"{field}Sha256")
        if (
            not isinstance(expected_hash, str)
            or not re.fullmatch(r"[0-9a-f]{64}", expected_hash)
            or hashlib.sha256(report_bytes).hexdigest() != expected_hash
        ):
            raise ValueError(f"AO2 accounting supplement has invalid or changed {field}")
    basis_compile_report = json.loads(
        _read_regular_file(manifest_path.parent / manifest["basisCompileReport"])
    )
    if not validate_cli_output_compile_report(basis_compile_report):
        raise ValueError("AO2 accounting basis compile report omits the CLI output supplement")

    for field in ("basisSourceSha256",):
        hashes = manifest.get(field)
        if (
            not isinstance(hashes, dict)
            or list(hashes) != EXPECTED_ACCOUNTING_PATHS
            or any(not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value)
                   for value in hashes.values())
        ):
            raise ValueError(f"AO2 accounting supplement has invalid {field}")
    application = manifest.get("applicationVerification", {})
    if not isinstance(application, dict):
        raise ValueError("AO2 accounting supplement has invalid application evidence")
    postimages = application.get("postimageSha256")
    if (
        not isinstance(postimages, dict)
        or list(postimages) != EXPECTED_ACCOUNTING_PATHS
        or any(not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value)
               for value in postimages.values())
        or application.get("patchDryRunSucceeded") is not True
        or application.get("zeroFuzz") is not True
        or application.get("zeroOffset") is not True
        or application.get("appliedToTemporarySourceCopy") is not True
        or application.get("originalSuccessorSourceModified") is not False
    ):
        raise ValueError("AO2 accounting supplement has invalid application evidence")

    instrumentation = manifest.get("instrumentation")
    if (
        not isinstance(instrumentation, dict)
        or instrumentation.get("testFrameworkOnly") is not True
        or instrumentation.get("nativeDefinitionsAdded") != 0
        or instrumentation.get("visitorCallsExcludedFromInternalCounters") is not True
        or instrumentation.get("nonAo2AllocatorsAndIoInstrumented") is not False
        or instrumentation.get("gateAAcceptanceComplete") is not False
        or instrumentation.get("workCounters") != EXPECTED_ACCOUNTING_WORK_COUNTERS
    ):
        raise ValueError("AO2 accounting supplement has invalid instrumentation scope")
    compiler_support = manifest.get("compilerApplicationSupport")
    if (
        not isinstance(compiler_support, dict)
        or compiler_support.get("implemented") is not True
        or compiler_support.get("offlineValidated") is not True
    ):
        raise ValueError("AO2 accounting supplement compiler application support is incomplete")

    patch_path = manifest_path.parent / manifest["patch"]
    patch_bytes = _read_regular_file(patch_path)
    patch_hash = hashlib.sha256(patch_bytes).hexdigest()
    if manifest.get("patchSha256") != patch_hash:
        raise ValueError("AO2 accounting supplement patch SHA256 mismatch")
    patch_text = patch_bytes.decode("utf-8")
    patch_paths = re.findall(r"^diff --git a/(\S+) b/(\S+)$", patch_text, re.MULTILINE)
    if patch_paths != [(path, path) for path in EXPECTED_ACCOUNTING_PATHS]:
        raise ValueError("AO2 accounting supplement diff paths differ from its manifest")

    return manifest, patch_path, patch_hash, hashlib.sha256(manifest_bytes).hexdigest()


def verify_ao2_accounting_basis(tree, manifest):
    for relative, expected in manifest["basisSourceSha256"].items():
        path = pathlib.Path(tree) / relative
        if hashlib.sha256(_read_regular_file(path)).hexdigest() != expected:
            raise ValueError(f"AO2 accounting supplement source preimage mismatch: {relative}")


def verify_ao2_accounting_postimages(tree, manifest):
    postimages = manifest["applicationVerification"]["postimageSha256"]
    records = []
    for relative in EXPECTED_ACCOUNTING_PATHS:
        digest = hashlib.sha256(_read_regular_file(pathlib.Path(tree) / relative)).hexdigest()
        if digest != postimages[relative]:
            raise ValueError(f"AO2 accounting supplement source postimage mismatch: {relative}")
        records.append(dict(path=relative, sha256=digest))
    return records


def validate_cli_output_compile_report(report):
    if not isinstance(report, dict):
        raise ValueError("Compile report must be an object")
    present_fields = [field in report for field in CLI_OUTPUT_REPORT_FIELDS]
    profiles = report.get("profiles")
    profile_claims_supplement = isinstance(profiles, list) and any(
        isinstance(profile, dict)
        and ("cliOutputSupplement" in profile or "ao2AccountingSupplement" in profile)
        for profile in profiles
    )
    if not any(present_fields) and not profile_claims_supplement:
        return False
    if not all(present_fields):
        raise ValueError("Compile report has incomplete CLI output supplement bindings")

    repository = pathlib.Path(__file__).resolve().parents[2]
    patches = repository / "local" / "asterisk-patches"
    parent_manifest = json.loads((patches / "queue-policy-v1.json").read_text())
    shutdown_path = patches / "queue-policy-shutdown-v1.json"
    shutdown_manifest, _, shutdown_patch_hash, shutdown_manifest_hash = (
        load_shutdown_supplement(shutdown_path, parent_manifest)
    )
    output_path = patches / "queue-policy-output-v1.json"
    output_manifest, _, output_patch_hash, output_manifest_hash = (
        load_cli_output_supplement(
            output_path, parent_manifest, shutdown_manifest, shutdown_manifest_hash
        )
    )

    expected_bindings = {
        "cliOutputSupplementPatchSha256": output_patch_hash,
        "cliOutputSupplementManifestSha256": output_manifest_hash,
        "cliOutputSupplementParentPatchSha256": parent_manifest["patchSha256"],
        "cliOutputSupplementParentSupplementPatchSha256": shutdown_patch_hash,
        "cliOutputSupplementParentSupplementManifestSha256": shutdown_manifest_hash,
    }
    if any(report.get(field) != digest for field, digest in expected_bindings.items()):
        raise ValueError("Compile report does not bind the pinned CLI output supplement")

    if not isinstance(profiles, list) or len(profiles) != 2:
        raise ValueError("Compile report has invalid profiles for the CLI output supplement")
    profiles_by_name = {profile.get("name"): profile for profile in profiles
                        if isinstance(profile, dict)}
    if (
        len(profiles_by_name) != 2
        or set(profiles_by_name) != {"instrumented", "release"}
    ):
        raise ValueError("Compile report must contain both CLI output supplement profiles")

    expected_postimages = [
        dict(path=path, sha256=output_manifest["applicationVerification"]["postimageSha256"][path])
        for path in EXPECTED_OUTPUT_PATHS
    ]
    for profile_name in ("instrumented", "release"):
        application = profiles_by_name[profile_name].get("cliOutputSupplement")
        if (
            not isinstance(application, dict)
            or application.get("patchSha256") != output_patch_hash
            or application.get("appliedWithZeroFuzz") is not True
            or application.get("postimages") != expected_postimages
        ):
            raise ValueError(
                f"Compile profile does not bind the CLI output supplement: {profile_name}"
            )

    accounting_fields_present = [field in report for field in AO2_ACCOUNTING_REPORT_FIELDS]
    profile_claims_accounting = any(
        "ao2AccountingSupplement" in profile for profile in profiles_by_name.values()
    )
    if not any(accounting_fields_present) and not profile_claims_accounting:
        return True
    if not all(accounting_fields_present):
        raise ValueError("Compile report has incomplete AO2 accounting supplement bindings")

    accounting_path = patches / "queue-policy-accounting-v1.json"
    accounting_manifest, _, accounting_patch_hash, accounting_manifest_hash = (
        load_ao2_accounting_supplement(
            accounting_path,
            parent_manifest,
            shutdown_manifest,
            shutdown_manifest_hash,
            output_manifest,
            output_manifest_hash,
        )
    )
    expected_accounting_bindings = {
        "ao2AccountingSupplementPatchSha256": accounting_patch_hash,
        "ao2AccountingSupplementManifestSha256": accounting_manifest_hash,
        "ao2AccountingSupplementParentPatchSha256": parent_manifest["patchSha256"],
        "ao2AccountingSupplementParentSupplementPatchSha256": shutdown_patch_hash,
        "ao2AccountingSupplementParentSupplementManifestSha256": shutdown_manifest_hash,
        "ao2AccountingSupplementParentOutputSupplementPatchSha256": output_patch_hash,
        "ao2AccountingSupplementParentOutputSupplementManifestSha256": output_manifest_hash,
    }
    if any(report.get(field) != digest for field, digest in expected_accounting_bindings.items()):
        raise ValueError("Compile report does not bind the pinned AO2 accounting supplement")

    expected_accounting_postimages = [
        dict(
            path=path,
            sha256=accounting_manifest["applicationVerification"]["postimageSha256"][path],
        )
        for path in EXPECTED_ACCOUNTING_PATHS
    ]
    for profile_name in ("instrumented", "release"):
        application = profiles_by_name[profile_name].get("ao2AccountingSupplement")
        if (
            not isinstance(application, dict)
            or application.get("patchSha256") != accounting_patch_hash
            or application.get("appliedWithZeroFuzz") is not True
            or application.get("postimages") != expected_accounting_postimages
        ):
            raise ValueError(
                f"Compile profile does not bind the AO2 accounting supplement: {profile_name}"
            )
    return True
