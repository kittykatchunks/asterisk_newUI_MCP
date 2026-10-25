import hashlib
import json
import os
import pathlib
import subprocess
import sys
import urllib.request


if sys.argv[1:] != ["--approve-locked-install"] or os.geteuid() != 0:
    raise SystemExit("Requires root and explicit --approve-locked-install")
root = pathlib.Path("/var/lib/asterisk-build-preparation")
lock_bytes = (root / "dependency-lock.json").read_bytes()
if hashlib.sha256(lock_bytes).hexdigest() != "b2b1c3dbe3e38df962b52eddcf24297b1c8b39a0b7cd0678ddeed46db7231928":
    raise ValueError("Dependency lock differs from approved resolution")
lock = json.loads(lock_bytes)
query = ["dpkg-query", "-W", "-f=${binary:Package}\t${Version}\t${Architecture}\n"]
baseline = subprocess.check_output(query)
if hashlib.sha256(baseline).hexdigest() != lock["baselineSha256"]:
    raise ValueError("Installed packages differ from the resolved baseline")
for index, archive in enumerate(lock["archives"], 1):
    filename = archive["filename"]
    if pathlib.Path(filename).name != filename:
        raise ValueError(f"Invalid archive filename: {filename}")
    if not archive["url"].startswith("https://snapshot.ubuntu.com/ubuntu/20261024T000000Z/"):
        raise ValueError("Package URL is outside the approved snapshot")
    destination = root / "archives" / filename
    digest = hashlib.sha256()
    total = 0
    with urllib.request.urlopen(archive["url"], timeout=30) as response:
        with destination.open("xb") as output:
            while chunk := response.read(65536):
                total += len(chunk)
                if total > archive["bytes"]:
                    raise ValueError(f"Package exceeds locked length: {filename}")
                output.write(chunk)
                digest.update(chunk)
    if total != archive["bytes"] or digest.hexdigest() != archive["sha256"]:
        raise ValueError(f"Package length/SHA256 mismatch: {filename}")
    print(f"VERIFIED_PACKAGE {index}/{len(lock['archives'])} {filename}", flush=True)
os.environ["DEBIAN_FRONTEND"] = "noninteractive"
versions = [f"{change['package']}={change['version']}" for change in lock["packageChanges"]]
subprocess.run(
    ["apt-get", "-c", str(root / "apt.conf"), "--yes", "--no-download",
     "--no-install-recommends", "--no-remove", "install", *versions],
    check=True,
)
for change in lock["packageChanges"]:
    version = subprocess.check_output(
        ["dpkg-query", "-W", "-f=${Version}", change["package"]], text=True
    )
    if version != change["version"]:
        raise ValueError(f"Installed version mismatch: {change['package']}")
after = subprocess.check_output(query)
(root / "installed-packages.tsv").write_bytes(after)
print("INSTALLED_PACKAGE_BASELINE_SHA256=" + hashlib.sha256(after).hexdigest())
print("LOCKED_PACKAGE_INSTALL_VERIFIED_NO_ASTERISK_COMPILED", flush=True)
