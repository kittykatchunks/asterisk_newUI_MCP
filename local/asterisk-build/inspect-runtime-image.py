import argparse
import gzip
import hashlib
import json
import pathlib
import tarfile


HERE = pathlib.Path(__file__).resolve().parent


def inspect_archive(archive, image_id):
    bundle = json.loads((HERE / "runtime-bundle-manifest.json").read_text())
    expected = {
        "opt/asterisk/" + entry["path"]: entry for entry in bundle["entries"]
    }
    expected["opt/asterisk/bundle-manifest.json"] = dict(
        sha256=hashlib.sha256((HERE / "runtime-bundle-manifest.json").read_bytes()).hexdigest(),
        bytes=(HERE / "runtime-bundle-manifest.json").stat().st_size,
        mode="0o644",
    )
    aliases = {
        "opt/asterisk/modules/" + pathlib.PurePosixPath(entry["path"]).name:
        "/opt/asterisk/" + entry["path"]
        for entry in bundle["entries"]
        if entry["path"].endswith(".so") and entry["path"].split("/")[0] in {
            "apps", "bridges", "cel", "channels", "codecs", "formats", "funcs", "pbx", "res"
        }
    }
    if len(aliases) != 41:
        raise ValueError("Expected 41 module aliases")
    entries = {}
    with tarfile.open(archive, "r:*") as saved:
        def member_bytes(name):
            stream = saved.extractfile(name)
            if stream is None:
                raise ValueError(f"Image archive member is not a file: {name}")
            with stream:
                return stream.read()

        manifests = json.loads(member_bytes("manifest.json"))
        if len(manifests) != 1:
            raise ValueError("Expected exactly one saved image")
        manifest = manifests[0]
        def descriptor_bytes(descriptor):
            algorithm, value = descriptor["digest"].split(":", 1)
            if algorithm != "sha256" or len(value) != 64:
                raise ValueError("Unsupported OCI descriptor digest")
            data = member_bytes("blobs/sha256/" + value)
            if len(data) != descriptor["size"] or hashlib.sha256(data).hexdigest() != value:
                raise ValueError("OCI descriptor content hash/size mismatch")
            return data

        index = json.loads(member_bytes("index.json"))
        roots = [item for item in index["manifests"] if item["digest"] == image_id]
        if len(roots) != 1:
            raise ValueError("Built image ID is not the saved OCI root descriptor")
        node = json.loads(descriptor_bytes(roots[0]))
        if "manifests" in node:
            candidates = [item for item in node["manifests"]
                          if item.get("platform", {}).get("os") == "linux"
                          and item.get("platform", {}).get("architecture") == "amd64"]
            if len(candidates) != 1:
                raise ValueError("Expected one Linux amd64 OCI image manifest")
            node = json.loads(descriptor_bytes(candidates[0]))
        config_bytes = descriptor_bytes(node["config"])
        if config_bytes != member_bytes(manifest["Config"]):
            raise ValueError("Legacy archive config differs from OCI-bound config")
        config = json.loads(config_bytes)
        if config["architecture"] != "amd64" or config["os"] != "linux":
            raise ValueError("Expected Linux amd64 image")
        recipe = (HERE / "runtime.Dockerfile").read_text().splitlines()
        settings = config["config"]
        for field, prefix in [("Entrypoint", "ENTRYPOINT "), ("Cmd", "CMD ")]:
            value = json.loads(next(line[len(prefix):] for line in recipe if line.startswith(prefix)))
            if settings[field] != value:
                raise ValueError(f"Image configuration differs from reviewed recipe: {field}")
        if (settings["User"] != "10001:10001" or settings["WorkingDir"] != "/opt/asterisk"
                or settings["StopSignal"] != "SIGTERM"):
            raise ValueError("Image user/working-directory/stop-signal mismatch")
        for line in recipe:
            if line.startswith("ENV ") and line[4:] not in settings["Env"]:
                raise ValueError(f"Image environment differs from reviewed recipe: {line}")
        if settings["Labels"]["org.asterisk.local.bundle-manifest-sha256"] != expected[
                "opt/asterisk/bundle-manifest.json"]["sha256"]:
            raise ValueError("Image manifest label mismatch")
        layers = manifest["Layers"]
        if (len(layers) != len(config["rootfs"]["diff_ids"])
                or layers != ["blobs/" + item["digest"].replace(":", "/") for item in node["layers"]]):
            raise ValueError("Layer/diff-ID inventory mismatch")
        for layer, expected_hash, descriptor in zip(layers, config["rootfs"]["diff_ids"], node["layers"]):
            stream = saved.extractfile(layer)
            if stream is None:
                raise ValueError("Missing image layer")
            with stream:
                actual_hash = hashlib.file_digest(stream, "sha256").hexdigest()
            if ("sha256:" + actual_hash != descriptor["digest"]
                    or saved.getmember(layer).size != descriptor["size"]):
                raise ValueError("Compressed OCI layer hash/size mismatch")
            media_type = descriptor["mediaType"]
            if media_type not in ("application/vnd.oci.image.layer.v1.tar+gzip",
                                  "application/vnd.oci.image.layer.v1.tar"):
                raise ValueError(f"Unsupported OCI layer media type: {media_type}")
            stream = saved.extractfile(layer)
            with stream:
                if media_type.endswith("+gzip"):
                    with gzip.GzipFile(fileobj=stream) as decoded:
                        actual_hash = hashlib.file_digest(decoded, "sha256").hexdigest()
                else:
                    actual_hash = hashlib.file_digest(stream, "sha256").hexdigest()
            if "sha256:" + actual_hash != expected_hash:
                raise ValueError("Uncompressed layer hash mismatch")
            stream = saved.extractfile(layer)
            with stream, tarfile.open(fileobj=stream, mode="r|*") as content:
                for item in content:
                    name = item.name.rstrip("/")
                    relative = pathlib.PurePosixPath(name)
                    if relative.is_absolute() or ".." in relative.parts or ".wh." in relative.name:
                        raise ValueError(f"Unexpected layer path or whiteout: {name}")
                    if item.isdir():
                        continue
                    if item.isfile():
                        source = content.extractfile(item)
                        with source:
                            sha256 = hashlib.file_digest(source, "sha256").hexdigest()
                        record = dict(kind="file", sha256=sha256, bytes=item.size,
                                      mode=oct(item.mode & 0o777), uid=item.uid, gid=item.gid)
                    elif item.issym():
                        record = dict(kind="symlink", target=item.linkname, uid=item.uid, gid=item.gid)
                    else:
                        raise ValueError(f"Unexpected layer entry type: {name}")
                    if name in entries:
                        raise ValueError(f"Overwritten image payload entry: {name}")
                    entries[name] = record
    if set(entries) != set(expected) | set(aliases):
        raise ValueError(f"Image inventory mismatch: missing={sorted((set(expected) | set(aliases)) - set(entries))}"
                         f" extra={sorted(set(entries) - set(expected) - set(aliases))}")
    for name, entry in expected.items():
        actual = entries[name]
        if (actual["kind"] != "file" or actual["uid"] != 10001 or actual["gid"] != 10001
                or any(actual[key] != entry[key] for key in ("sha256", "bytes", "mode"))):
            raise ValueError(f"Image payload content/ownership mismatch: {name}")
    for name, target in aliases.items():
        if entries[name] != dict(kind="symlink", target=target, uid=10001, gid=10001):
            raise ValueError(f"Image module alias mismatch: {name}")
    with archive.open("rb") as source:
        archive_hash = hashlib.file_digest(source, "sha256").hexdigest()
    return dict(
        schemaVersion=1, stage="local-image-payload-independently-verified",
        imageId=image_id, imageArchiveSha256=archive_hash,
        imageConfigSha256=hashlib.sha256(config_bytes).hexdigest(),
        bundleManifestSha256=expected["opt/asterisk/bundle-manifest.json"]["sha256"],
        payloadFilesVerified=len(expected), moduleAliasesVerified=len(aliases),
        imageLayersVerified=len(layers), allPayloadHashesSizesModesAndOwnershipVerified=True,
        exactNonDirectoryImageInventoryVerified=True, imageConfigurationMatchesRecipe=True,
        imageRuntimeExecuted=False,
        runtimeApplyAuthorized=False, existingPbxOperated=False,
        registryPushed=False, redistributionApproved=False, licenseClosureComplete=False,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=pathlib.Path, required=True)
    parser.add_argument("--image-id", required=True)
    parser.add_argument("--report", type=pathlib.Path, required=True)
    args = parser.parse_args()
    report = inspect_archive(args.archive, args.image_id)
    with args.report.open("x") as output:
        output.write(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
