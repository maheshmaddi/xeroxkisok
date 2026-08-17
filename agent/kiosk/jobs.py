"""Job execution: download → tmpfs → print → shred (spec §7 jobs.py).

User files NEVER touch persistent disk: they land in tmpfs (/dev/shm/kiosk)
and are shred-deleted immediately after success or failure.
"""

from __future__ import annotations

import logging
import os
import pathlib
import shutil
import urllib.request

from .config import AgentConfig
from .connection import KioskConnection
from .display import DisplayState
from .printer import PrintFailure, Printer

log = logging.getLogger("kiosk.jobs")


class JobRunner:
    def __init__(self, config: AgentConfig, connection: KioskConnection, printer: Printer, display: DisplayState):
        self.config = config
        self.conn = connection
        self.printer = printer
        self.display = display

    # ------------------------------------------------------------- claiming
    def claim(self, job: dict, otp: str):
        """Send the OTP typed on the keypad; returns claim result or None."""
        result: dict = {}

        def cb(res):
            result.update(res or {})

        self.conn.emit("job:claim", {"jobId": job["jobId"], "otp": otp}, callback=cb)
        # python-socketio delivers the ack on its event loop; wait briefly.
        import time

        deadline = time.time() + 10
        while not result and time.time() < deadline:
            time.sleep(0.05)
        return result or None

    # ------------------------------------------------------------- pipeline
    def run(self, job: dict, otp: str) -> None:
        claim = self.claim(job, otp)
        if not claim or not claim.get("ok"):
            error = (claim or {}).get("error", "CLAIM_FAILED")
            log.warning("claim rejected for %s: %s", job.get("jobId"), error)
            if error == "LOCKED":
                self.display.set("error", "Too many wrong codes — please contact support.", "Locked")
            elif error == "OTP_EXPIRED":
                self.display.set("error", "That code expired. Refund is on its way.", "Code expired")
            else:
                self.display.set("error", "Wrong code — check your phone and try again.", "Try again")
                self.display.broadcast()  # type: ignore[attr-defined]
            self.display.broadcast()  # type: ignore[attr-defined]
            return

        job_id = claim["jobId"]
        local = self._download(job_id, claim["fileUrl"])
        try:
            settings = claim.get("settings") or {}
            settings.setdefault("copies", claim.get("copies", 1))
            settings.setdefault("pages", claim.get("pages", 1))

            def progress(page: int, total: int) -> None:
                self.display.set("printing", f"page {page} of {total}")
                self.display.broadcast()  # type: ignore[attr-defined]
                self.conn.emit("job:progress", {"jobId": job_id, "page": page, "pages": total})

            self.printer.print_file(str(local), claim.get("fileName", job_id), settings, on_progress=progress)
            self.conn.emit("job:completed", {"jobId": job_id})
            self.display.set("collect")
            self.display.broadcast()  # type: ignore[attr-defined]
            log.info("job %s completed", job_id)
        except PrintFailure as failure:
            self.conn.emit("job:failed", {"jobId": job_id, "reason": failure.reason})
            self.display.set("error", "Printing failed — your payment will be refunded.", "Print failed")
            self.display.broadcast()  # type: ignore[attr-defined]
            log.error("job %s failed: %s (%s)", job_id, failure.reason, failure.detail)
        finally:
            self._shred(local)
            import time

            time.sleep(8)  # let the user read "collect your prints"
            self.display.set("idle")
            self.display.broadcast()  # type: ignore[attr-defined]

    # --------------------------------------------------------------- helpers
    def _download(self, job_id: str, url: str) -> pathlib.Path:
        target_dir = pathlib.Path(self.config.tmp_dir)
        target_dir.mkdir(parents=True, exist_ok=True)  # tmpfs; sized via tmpfs mount
        local = target_dir / f"{job_id}.file"
        log.info("downloading %s → %s", url, local)
        urllib.request.urlretrieve(url, local)
        return local

    def _shred(self, path: pathlib.Path) -> None:
        """Overwrite then remove — user files never linger (spec §7 hard rules)."""
        try:
            size = path.stat().st_size
            with open(path, "ba+") as fh:
                for _ in range(2):
                    fh.seek(0)
                    fh.write(os.urandom(min(size, 8 * 1024 * 1024)))
                    fh.flush()
                    os.fsync(fh.fileno())
            path.unlink()
            log.info("shredded %s", path)
        except FileNotFoundError:
            pass
        except Exception:  # noqa: BLE001
            log.warning("shred failed for %s — forcing removal", path, exc_info=True)
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass

    def cleanup_tmp(self) -> None:
        """On startup: anything left in tmpfs from a crash is gone on reboot,
        but clear it anyway to reclaim space."""
        target_dir = pathlib.Path(self.config.tmp_dir)
        if target_dir.exists():
            shutil.rmtree(target_dir, ignore_errors=True)
