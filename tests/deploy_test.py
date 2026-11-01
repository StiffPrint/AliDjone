import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "receiver", Path(__file__).resolve().parents[1] / "deploy/receive-release.py")
receiver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiver)


class DeploymentTests(unittest.TestCase):
    def archive(self, directory, members):
        archive = directory / "release.tar.gz"
        with tarfile.open(archive, "w:gz") as bundle:
            for name, content, kind in members:
                member = tarfile.TarInfo(name)
                member.type = kind
                if kind == tarfile.REGTYPE:
                    member.size = len(content)
                    bundle.addfile(member, io.BytesIO(content))
                else:
                    member.linkname = "/etc/passwd"
                    bundle.addfile(member)
        return archive

    def test_valid_archive_requires_revision_and_all_runtime_files(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            members = [(name, b"a" * 40 if name == "REVISION" else b"ok", tarfile.REGTYPE)
                       for name in receiver.REQUIRED]
            archive = self.archive(directory, members)
            destination = directory / "extracted"
            destination.mkdir()
            self.assertEqual(receiver.extract_release(archive, destination), "a" * 40)
            self.assertTrue((destination / "server/server.mjs").is_file())

    def test_unsafe_archives_are_rejected(self):
        bad_cases = [
            [("../escaped", b"bad", tarfile.REGTYPE)],
            [("/etc/passwd", b"bad", tarfile.REGTYPE)],
            [("data/warehouse.sqlite", b"bad", tarfile.REGTYPE)],
            [("public/link", b"", tarfile.SYMTYPE)],
            [("public/link", b"", tarfile.LNKTYPE)],
            [("public/device", b"", tarfile.CHRTYPE)],
            [("public/app.js", b"one", tarfile.REGTYPE), ("public/app.js", b"two", tarfile.REGTYPE)],
            [("REVISION", b"not-a-sha", tarfile.REGTYPE)],
        ]
        for members in bad_cases:
            with self.subTest(members=members), tempfile.TemporaryDirectory() as temp:
                directory = Path(temp)
                archive = self.archive(directory, members)
                destination = directory / "extracted"
                destination.mkdir()
                with self.assertRaises(ValueError):
                    receiver.extract_release(archive, destination)

    def test_failed_health_check_restores_previous_symlink(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            old, new = base / "old", base / "new"
            old.mkdir(); new.mkdir()
            (base / "current").symlink_to(old)
            with patch.object(receiver, "BASE", base), patch.object(receiver, "run") as run, \
                 patch.object(receiver, "wait_healthy", side_effect=[RuntimeError("unhealthy"), None]) as health:
                with self.assertRaisesRegex(RuntimeError, "unhealthy"):
                    receiver.activate_release(new, old, "a" * 40)
                self.assertEqual((base / "current").resolve(), old)
                self.assertEqual(run.call_count, 2)
                self.assertEqual(health.call_count, 2)

    def test_successful_health_check_keeps_new_release(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            old, new = base / "old", base / "new"
            old.mkdir(); new.mkdir()
            (base / "current").symlink_to(old)
            with patch.object(receiver, "BASE", base), patch.object(receiver, "run"), \
                 patch.object(receiver, "wait_healthy") as health:
                receiver.activate_release(new, old, "b" * 40)
                self.assertEqual((base / "current").resolve(), new)
                health.assert_called_once_with("b" * 40)


if __name__ == "__main__":
    unittest.main()
