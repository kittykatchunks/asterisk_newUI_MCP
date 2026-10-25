import hashlib
import json
import pathlib
import tarfile
import urllib.request


root = pathlib.Path("/home/asterisk-build/source-staging")
root.mkdir()
sources = [
    {
        "name": "asterisk",
        "filename": "asterisk-874768141f94bc03865cc746eee1c7669e3c46d5.tar.gz",
        "url": "https://codeload.github.com/asterisk/asterisk/tar.gz/874768141f94bc03865cc746eee1c7669e3c46d5",
        "revision": "874768141f94bc03865cc746eee1c7669e3c46d5",
        "expectedSha256": "991b89e3512924c61ce294d9e5ea816b54c1cfd8f723a2ab64de7a67baa3c6ea",
    },
    {
        "name": "pjproject",
        "filename": "pjproject-2.17.tar.bz2",
        "url": "https://raw.githubusercontent.com/asterisk/third-party/4d3b9cfdf9fe4f68d3674191707415faceec0ec6/pjproject/2.17/pjproject-2.17.tar.bz2",
        "revision": "4d3b9cfdf9fe4f68d3674191707415faceec0ec6",
        "expectedUpstreamMd5": "baacc87418a95107657039269bc71538",
        "expectedSha256": "04b2eb1f0f01aa0ad1945b167171843448a51aa6b7c3e806496d434f13a112b7",
    },
]
limit = 64 * 1024 * 1024
for source in sources:
    destination = root / source["filename"]
    total = 0
    sha256 = hashlib.sha256()
    md5 = hashlib.md5(usedforsecurity=False)
    with urllib.request.urlopen(source["url"], timeout=30) as response:
        response_length = response.headers.get("Content-Length")
        if response_length is not None and int(response_length) > limit:
            raise ValueError(f"Source Content-Length exceeds limit: {source['name']}")
        with destination.open("xb") as output:
            while chunk := response.read(65536):
                total += len(chunk)
                if total > limit:
                    raise ValueError(f"Source payload exceeds limit: {source['name']}")
                output.write(chunk)
                sha256.update(chunk)
                md5.update(chunk)
    if "expectedUpstreamMd5" in source and md5.hexdigest() != source["expectedUpstreamMd5"]:
        raise ValueError("PJPROJECT differs from the checksum pinned by Asterisk")
    if sha256.hexdigest() != source["expectedSha256"]:
        raise ValueError(f"Source differs from locked SHA256: {source['name']}")
    source.update(bytes=total, sha256=sha256.hexdigest())
    print(f"{source['name']} bytes={total} sha256={source['sha256']}", flush=True)

asterisk = root / "asterisk"
asterisk.mkdir()
with tarfile.open(root / sources[0]["filename"]) as archive:
    prefix = f"asterisk-{sources[0]['revision']}/"
    members = archive.getmembers()
    if sum(member.size for member in members) > 512 * 1024 * 1024:
        raise ValueError("Asterisk expanded size exceeds 512 MiB")
    for member in members:
        if not member.name.startswith(prefix) and member.name != prefix.rstrip("/"):
            raise ValueError(f"Unexpected archive root: {member.name}")
    archive.extractall(asterisk, filter="data")
tree = asterisk / prefix.rstrip("/")
for filename in ["configure", "configure.ac", "Makefile", "menuselect/Makefile"]:
    print(f"PINNED_SOURCE_FILE {filename} present={(tree / filename).is_file()}")
record = {
    "schemaVersion": 1,
    "stage": "downloaded-inspected-not-compiled",
    "maximumArchiveBytes": limit,
    "maximumAsteriskExpandedBytes": 512 * 1024 * 1024,
    "sources": sources,
    "asteriskSourceDirectory": str(tree),
    "nativeCompiled": False,
}
(root / "source-lock.json").write_text(json.dumps(record, indent=2) + "\n")
