#!/bin/bash
set -euo pipefail
export LC_ALL=C
export DEBIAN_FRONTEND=noninteractive

test "$(id -u)" -eq 0
root=/var/lib/asterisk-build-preparation
if test -e "$root"; then
    echo "Refusing to overwrite existing resolution directory: $root" >&2
    exit 1
fi
mkdir -p "$root/lists/partial" "$root/archives/partial"
chmod 0755 "$root"
cat > "$root/snapshot.sources" <<'EOF'
Types: deb
URIs: https://snapshot.ubuntu.com/ubuntu/20261024T000000Z/
Suites: noble noble-updates noble-security
Components: main universe
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
Check-Valid-Until: no
EOF
cat > "$root/apt.conf" <<'EOF'
Dir::Etc::sourcelist "/var/lib/asterisk-build-preparation/snapshot.sources";
Dir::Etc::sourceparts "-";
Dir::State::lists "/var/lib/asterisk-build-preparation/lists";
Dir::Cache::archives "/var/lib/asterisk-build-preparation/archives";
Dir::Cache::pkgcache "";
Dir::Cache::srcpkgcache "";
APT::Get::List-Cleanup "false";
APT::Get::AllowUnauthenticated "false";
Acquire::AllowInsecureRepositories "false";
Acquire::Retries "0";
Acquire::https::Timeout "30";
Acquire::Languages "none";
Acquire::ForceHash "sha256";
EOF
packages=(
    build-essential autoconf automake libtool pkg-config
    libedit-dev libjansson-dev libsqlite3-dev uuid-dev libxml2-dev
    libssl-dev libsrtp2-dev libresample1-dev libcurl4-openssl-dev
    libncurses-dev zlib1g-dev libcap-dev libspeexdsp-dev
    bison flex patch bzip2 xz-utils xmlstarlet
)
dpkg-query -W -f='${binary:Package}\t${Version}\t${Architecture}\n' > "$root/before.tsv"
apt-get -c "$root/apt.conf" update > "$root/update.log" 2>&1
apt-get -c "$root/apt.conf" --simulate --no-install-recommends --no-remove \
    install "${packages[@]}" > "$root/install-simulation.txt" 2>&1
apt-get -c "$root/apt.conf" --print-uris --yes --download-only \
    --no-install-recommends --no-remove install "${packages[@]}" \
    > "$root/package-uris.txt" 2>&1
dpkg-query -W -f='${binary:Package}\t${Version}\t${Architecture}\n' > "$root/after.tsv"
cmp "$root/before.tsv" "$root/after.tsv"
python3 - "$root" "${packages[@]}" <<'PY'
import hashlib
import json
import pathlib
import re
import shlex
import sys

root = pathlib.Path(sys.argv[1])
archives = []
for line in (root / "package-uris.txt").read_text().splitlines():
    if not line.startswith("'"):
        continue
    url, filename, size, checksum = shlex.split(line)
    algorithm, digest = checksum.split(":", 1)
    if algorithm.upper() != "SHA256" or not re.fullmatch(r"[a-fA-F0-9]{64}", digest):
        raise ValueError(f"Expected SHA256 for {filename}")
    if not url.startswith("https://snapshot.ubuntu.com/ubuntu/20261024T000000Z/"):
        raise ValueError(f"Archive outside pinned snapshot: {url}")
    archives.append(dict(url=url, filename=filename, bytes=int(size), sha256=digest.lower()))
if not archives:
    raise ValueError("Dependency resolution returned no package archives")
changes = []
for line in (root / "install-simulation.txt").read_text().splitlines():
    if not line.startswith("Inst "):
        continue
    match = re.match(r"Inst (\S+)(?: \[([^\]]+)\])? \((\S+)", line)
    if not match:
        raise ValueError(f"Unrecognized package change: {line}")
    changes.append(dict(package=match[1], previousVersion=match[2], version=match[3]))
record = dict(
    schemaVersion=1,
    stage="resolved-not-installed",
    snapshot="20261024T000000Z",
    requestedPackages=sys.argv[2:],
    packageChanges=changes,
    archives=archives,
    totalArchiveBytes=sum(item["bytes"] for item in archives),
    baselineSha256=hashlib.sha256((root / "before.tsv").read_bytes()).hexdigest(),
    indexFiles=[
        dict(filename=p.name, sha256=hashlib.sha256(p.read_bytes()).hexdigest())
        for p in sorted((root / "lists").iterdir()) if p.is_file() and p.name != "lock"
    ],
    packagesInstalled=False,
)
(root / "dependency-lock.json").write_text(json.dumps(record, indent=2) + "\n")
print(f"RESOLVED_PACKAGE_CHANGES={len(changes)}")
print(f"RESOLVED_PACKAGE_ARCHIVES={len(archives)}")
print(f"TOTAL_ARCHIVE_BYTES={record['totalArchiveBytes']}")
print(f"BASELINE_SHA256={record['baselineSha256']}")
print(f"LOCK_SHA256={hashlib.sha256((root / 'dependency-lock.json').read_bytes()).hexdigest()}")
print("NO_PACKAGES_INSTALLED_OR_UPGRADED")
PY
