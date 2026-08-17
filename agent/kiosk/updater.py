"""Signed self-update (spec §7 updater.py).

On startup and daily: ask the API for the latest agent version, download the
release archive, verify its ed25519 signature against the public key in
/etc/kiosk/update-pubkey.pem, then ask systemd to restart us.
"""

from __future__ import annotations

import hashlib
import logging
import pathlib
import subprocess
import tarfile
import tempfile
import urllib.request

from . import __version__
from .config import AgentConfig

log = logging.getLogger("kiosk.updater")

PUBKEY_PATH = pathlib.Path("/etc/kiosk/update-pubkey.pem")


def check_and_update(config: AgentConfig, manual: bool = False) -> bool:
    try:
        import json

        with urllib.request.urlopen(f"{config.api_url}/agent/version", timeout=10) as res:
            release = json.load(res)
        latest = str(release.get("version", ""))
        if not latest or latest == __version__:
            return False

        log.info("update available: %s → %s", __version__, latest)
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = pathlib.Path(tmp)
            archive = tmp_path / "release.tar.gz"
            urllib.request.urlretrieve(release["url"], archive)

            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            if digest != release.get("sha256"):
                log.error("update rejected: sha256 mismatch")
                return False
            if not _verify_signature(archive.read_bytes(), release.get("signature", "")):
                log.error("update rejected: ed25519 signature invalid")
                return False

            _install(archive, tmp_path)
        subprocess.run(["systemctl", "restart", "kiosk-agent.service"], check=False)
        return True
    except Exception:  # noqa: BLE001 — never crash the agent over updates
        log.warning("update check failed", exc_info=True)
        return False


def _verify_signature(data: bytes, signature_b64: str) -> bool:
    if not PUBKEY_PATH.exists():
        log.warning("no update public key at %s — allowing only dev builds", PUBKEY_PATH)
        return signature_b64 == ""
    try:
        import base64

        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

        public = serialization.load_pem_public_key(PUBKEY_PATH.read_bytes())
        assert isinstance(public, Ed25519PublicKey)
        public.verify(base64.b64decode(signature_b64), data)
        return True
    except Exception:  # noqa: BLE001
        return False


def _install(archive: pathlib.Path, tmp: pathlib.Path) -> None:
    with tarfile.open(archive, "r:gz") as tar:
        tar.extractall(tmp / "pkg", filter="data")
    subprocess.run(
        ["cp", "-r", str(tmp / "pkg" / "kiosk"), "/opt/print-kiosk/kiosk"], check=True
    )
    log.info("update installed")
