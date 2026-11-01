#!/usr/bin/python3
"""Root-owned, forced SSH receiver. Read only a release archive from stdin."""
import fcntl
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import uuid

BASE = Path("/opt/alidjone")
RELEASES = BASE / "releases"
NODE = "/opt/alidjone-runtime/bin/node"
SERVICE = "alidjone.service"
ALLOWED = {"server", "lib", "public", "scripts", "tests", "deploy",
           "package.json", "package-lock.json", "README.md", "REVISION"}
REQUIRED = {"server/server.mjs", "server/auth.mjs", "server/store.mjs",
            "lib/warehouse.mjs", "lib/finance.mjs", "public/index.html",
            "public/app.js", "public/style.css", "package.json", "REVISION"}
MAX_ARCHIVE = 20 * 1024 * 1024
MAX_CONTENT = 80 * 1024 * 1024


def extract_release(archive, destination):
    """Reject traversal, links, devices, duplicate names and oversized releases."""
    files, total = set(), 0
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        if len(members) > 2000:
            raise ValueError("Too many archive members")
        for member in members:
            raw = member.name
            while raw.startswith("./"):
                raw = raw[2:]
            if raw in ("", ".") and member.isdir():
                continue
            path = PurePosixPath(raw)
            if (path.is_absolute() or ".." in path.parts or not path.parts
                    or path.parts[0] not in ALLOWED):
                raise ValueError("Invalid archive path")
            if not (member.isfile() or member.isdir()):
                raise ValueError("Only regular files and directories are allowed")
            target = destination.joinpath(*path.parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True, mode=0o755)
                continue
            name = str(path)
            if name in files or member.size < 0:
                raise ValueError("Duplicate or invalid archive member")
            files.add(name)
            total += member.size
            if total > MAX_CONTENT:
                raise ValueError("Unpacked release exceeds size limit")
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            with bundle.extractfile(member) as source, target.open("xb") as output:
                shutil.copyfileobj(source, output)
            target.chmod(0o644)
    if not REQUIRED.issubset(files):
        raise ValueError("Required release files are missing")
    revision = (destination / "REVISION").read_text().strip()
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("Invalid release revision")
    return revision


def run(*args, **kwargs):
    subprocess.run(args, check=True, timeout=120, **kwargs)


def switch_release(target):
    temporary = BASE / (".current-" + uuid.uuid4().hex)
    try:
        temporary.symlink_to(target)
        os.replace(temporary, BASE / "current")
    finally:
        temporary.unlink(missing_ok=True)


def wait_healthy(revision=None):
    for _ in range(40):
        try:
            with urllib.request.urlopen("http://127.0.0.1:5180/healthz", timeout=2) as response:
                result = json.load(response)
            if result.get("ok") is True and (revision is None or result.get("revision") == revision):
                return
        except (OSError, ValueError):
            pass
        time.sleep(0.5)
    raise RuntimeError("Release failed its health/revision check")


def activate_release(release, previous, revision):
    try:
        switch_release(release)
        run("systemctl", "restart", SERVICE)
        wait_healthy(revision)
    except BaseException:
        print("Deployment failed; restoring previous release", file=sys.stderr)
        switch_release(previous)
        run("systemctl", "restart", SERVICE)
        wait_healthy()
        raise


def main():
    if os.geteuid() != 0:
        raise RuntimeError("Receiver must run via the restricted sudo rule")
    os.umask(0o022)
    with open("/run/lock/alidjone-deploy.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        RELEASES.mkdir(parents=True, exist_ok=True)
        previous = (BASE / "current").resolve(strict=True)
        with tempfile.TemporaryDirectory(prefix="alidjone-upload-") as upload:
            archive = Path(upload) / "release.tar.gz"
            size = 0
            with archive.open("wb") as output:
                while chunk := sys.stdin.buffer.read(64 * 1024):
                    size += len(chunk)
                    if size > MAX_ARCHIVE:
                        raise ValueError("Release archive exceeds size limit")
                    output.write(chunk)
            stage = Path(tempfile.mkdtemp(prefix=".staging-", dir=RELEASES))
            try:
                revision = extract_release(archive, stage)
                release = RELEASES / (revision + "-" + uuid.uuid4().hex[:12])
                stage.rename(release)
            except BaseException:
                shutil.rmtree(stage, ignore_errors=True)
                raise
        release.chmod(0o755)
        # Validate the actual uploaded code without access to production storage.
        # No uploaded code is ever executed as root.
        tests = sorted(str(path) for path in (release / "tests").glob("*.test.mjs"))
        if not tests:
            raise RuntimeError("Release contains no tests")
        run("/usr/sbin/runuser", "-u", "nobody", "--", NODE, "--test", *tests,
            cwd=release, env={"PATH": "/opt/alidjone-runtime/bin:/usr/bin:/bin", "TZ": "UTC"})
        run("systemctl", "start", "alidjone-backup.service")
        result = subprocess.check_output(
            ["systemctl", "show", "alidjone-backup.service", "--property=Result", "--value"], text=True).strip()
        if result != "success":
            raise RuntimeError("Pre-deployment backup failed")
        activate_release(release, previous, revision)
        print(json.dumps({"deployed": revision, "release": str(release), "previous": str(previous)}))


if __name__ == "__main__":
    main()
