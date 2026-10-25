import gzip
import hashlib
import importlib.util
import io
import json
import pathlib
import tarfile
import tempfile
import unittest
from unittest.mock import patch


ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "inspect_runtime_image", ROOT / "local/asterisk-build/inspect-runtime-image.py")
inspector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspector)


class ImageInspectionTests(unittest.TestCase):
    def archive(self, directory, defect=None):
        here = pathlib.Path(directory)
        record = dict(entries=[
            dict(path=f"apps/module_{index}.so", bytes=7, mode="0o755",
                 sha256=hashlib.sha256(b"fixture").hexdigest())
            for index in range(41)
        ])
        manifest_path = here / "runtime-bundle-manifest.json"
        manifest_path.write_text(json.dumps(record))
        manifest_bytes = manifest_path.read_bytes()
        manifest_hash = hashlib.sha256(manifest_bytes).hexdigest()
        recipe_path = ROOT / "local/asterisk-build/runtime.Dockerfile"
        (here / "runtime.Dockerfile").write_bytes(recipe_path.read_bytes())
        recipe = recipe_path.read_text().splitlines()
        entrypoint = json.loads(next(line[11:] for line in recipe if line.startswith("ENTRYPOINT ")))
        command = json.loads(next(line[4:] for line in recipe if line.startswith("CMD ")))
        payload = io.BytesIO()
        with tarfile.open(fileobj=payload, mode="w") as layer:
            for entry in record["entries"] + [dict(path="bundle-manifest.json", mode="0o644")]:
                name = "opt/asterisk/" + entry["path"]
                data = manifest_bytes if entry["path"] == "bundle-manifest.json" else b"fixture"
                if defect == "content" and name.endswith("module_0.so"):
                    data = b"altered"
                member = tarfile.TarInfo(name)
                member.mode = int(entry["mode"], 8)
                member.uid = member.gid = 10001
                if defect == "owner":
                    member.uid = 0
                if defect == "mode":
                    member.mode = 0o600
                member.size = len(data)
                layer.addfile(member, io.BytesIO(data))
            for index in range(41):
                member = tarfile.TarInfo(f"opt/asterisk/modules/module_{index}.so")
                member.type = tarfile.SYMTYPE
                member.linkname = f"/opt/asterisk/apps/module_{index}.so"
                member.uid = member.gid = 10001
                if defect == "alias":
                    member.linkname = "/outside"
                layer.addfile(member)
            if defect in ("extra", "whiteout", "traversal", "hardlink", "duplicate"):
                name = {
                    "extra": "unexpected",
                    "whiteout": "opt/asterisk/.wh.module",
                    "traversal": "../outside",
                    "hardlink": "opt/asterisk/hard",
                    "duplicate": "opt/asterisk/apps/module_0.so",
                }[defect]
                member = tarfile.TarInfo(name)
                if defect == "hardlink":
                    member.type = tarfile.LNKTYPE
                    member.linkname = "opt/asterisk/apps/module_0.so"
                layer.addfile(member)
        uncompressed = payload.getvalue()
        compressed = gzip.compress(uncompressed, mtime=0)
        blobs = {}

        def blob(data, media):
            value = hashlib.sha256(data).hexdigest()
            blobs["blobs/sha256/" + value] = data
            return dict(mediaType=media, digest="sha256:" + value, size=len(data))

        config = dict(
            architecture="amd64", os="linux",
            config=dict(
                Entrypoint=entrypoint, Cmd=command, User="10001:10001",
                WorkingDir="/opt/asterisk", StopSignal="SIGTERM",
                Env=[line[4:] for line in recipe if line.startswith("ENV ")],
                Labels={"org.asterisk.local.bundle-manifest-sha256": manifest_hash}),
            rootfs=dict(type="layers", diff_ids=["sha256:" + hashlib.sha256(uncompressed).hexdigest()]))
        if defect == "config":
            config["config"]["User"] = "0"
        if defect == "diff-id":
            config["rootfs"]["diff_ids"] = ["sha256:" + "0" * 64]
        config_descriptor = blob(json.dumps(config).encode(), "application/vnd.oci.image.config.v1+json")
        layer_descriptor = blob(compressed, "application/vnd.oci.image.layer.v1.tar+gzip")
        if defect == "layer-size":
            layer_descriptor["size"] += 1
        image = dict(schemaVersion=2, mediaType="application/vnd.oci.image.manifest.v1+json",
                     config=config_descriptor, layers=[layer_descriptor])
        image_descriptor = blob(json.dumps(image).encode(), "application/vnd.oci.image.manifest.v1+json")
        image_descriptor["platform"] = dict(os="linux", architecture="amd64")
        root = blob(json.dumps(dict(schemaVersion=2, manifests=[image_descriptor])).encode(),
                    "application/vnd.oci.image.index.v1+json")
        legacy = [dict(Config="blobs/" + config_descriptor["digest"].replace(":", "/"),
                       Layers=["blobs/" + layer_descriptor["digest"].replace(":", "/")])]
        blobs["manifest.json"] = json.dumps(legacy).encode()
        blobs["index.json"] = json.dumps(dict(schemaVersion=2, manifests=[root])).encode()
        if defect == "descriptor":
            blobs["blobs/" + image_descriptor["digest"].replace(":", "/")] = b"tampered"
        archive = here / "image.tar"
        with tarfile.open(archive, "w") as saved:
            for name, data in blobs.items():
                member = tarfile.TarInfo(name)
                member.size = len(data)
                saved.addfile(member, io.BytesIO(data))
        return archive, root["digest"]

    def test_complete_oci_identity_layers_payload_aliases_and_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            archive, image_id = self.archive(directory)
            with patch.object(inspector, "HERE", pathlib.Path(directory)):
                result = inspector.inspect_archive(archive, image_id)
            self.assertEqual(result["payloadFilesVerified"], 42)
            self.assertEqual(result["moduleAliasesVerified"], 41)
            self.assertTrue(result["imageConfigurationMatchesRecipe"])
            self.assertFalse(result["imageRuntimeExecuted"])
            self.assertFalse(result["registryPushed"])

    def test_payload_content_permissions_ownership_and_alias_tampering(self):
        for defect in ["content", "mode", "owner", "alias"]:
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as directory:
                archive, image_id = self.archive(directory, defect)
                with patch.object(inspector, "HERE", pathlib.Path(directory)):
                    with self.assertRaisesRegex(ValueError, "payload content|alias"):
                        inspector.inspect_archive(archive, image_id)

    def test_exact_inventory_paths_whiteouts_types_and_overwrites(self):
        for defect in ["extra", "whiteout", "traversal", "hardlink", "duplicate"]:
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as directory:
                archive, image_id = self.archive(directory, defect)
                with patch.object(inspector, "HERE", pathlib.Path(directory)):
                    with self.assertRaises(ValueError):
                        inspector.inspect_archive(archive, image_id)

    def test_oci_hash_size_diff_id_and_config_mismatch(self):
        for defect in ["descriptor", "layer-size", "diff-id", "config"]:
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as directory:
                archive, image_id = self.archive(directory, defect)
                with patch.object(inspector, "HERE", pathlib.Path(directory)):
                    with self.assertRaises(ValueError):
                        inspector.inspect_archive(archive, image_id)

    def test_image_identity_cannot_be_substituted(self):
        with tempfile.TemporaryDirectory() as directory:
            archive, _ = self.archive(directory)
            with patch.object(inspector, "HERE", pathlib.Path(directory)):
                with self.assertRaisesRegex(ValueError, "root descriptor"):
                    inspector.inspect_archive(archive, "sha256:" + "0" * 64)


if __name__ == "__main__":
    unittest.main()
