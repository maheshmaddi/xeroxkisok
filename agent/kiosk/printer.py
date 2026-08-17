"""Printing + monitoring for the Epson EcoTank L15150 (spec §7 printer.py).

- Prints through CUPS with the driverless IPP `everywhere` queue.
- Option mapping: color / duplex / media size / copies.
- Monitors the CUPS job every 2s and the printer via IPP Get-Printer-Attributes
  (pycups getPrinterAttributes) for jam/paper-out/marker states.
- Ink: SNMP poll (Epson private MIB, OIDs configurable) with IPP marker-levels
  fallback when SNMP is unreliable.
- Failure detection: no page progress for 180s or printer-state-reasons error
  → cancel CUPS job → report failure.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Callable

import cups

from .config import AgentConfig

log = logging.getLogger("kiosk.printer")

# IPP printer-state-reason keywords that mean "cannot print" for us.
FATAL_REASONS = ("media-jam", "media-empty", "cover-open", "toner-empty", "spool-area-full")

MEDIA = {
    "A4": "iso_a4_210x297mm",
    "A3": "iso_a3_297x420mm",
    "4x6": "na_index-4x6_4x6in",
}


class PrintFailure(Exception):
    def __init__(self, reason: str, detail: str = ""):
        super().__init__(detail or reason)
        self.reason = reason
        self.detail = detail or reason


def build_cups_options(settings: dict) -> dict:
    """Map job settings to CUPS/IPP options (spec §7 option mapping)."""
    options: dict[str, str] = {
        "copies": str(settings.get("copies", 1)),
        "print-color-mode": "color" if settings.get("color") else "monochrome",
        "sides": "two-sided-long-edge" if settings.get("duplex") else "one-sided",
    }
    if settings.get("mode") in ("photo4x6", "passport"):
        # Photo modes print a pre-composed 4x6 artifact (server-side, Phase 4):
        # color, simplex, one physical sheet per artifact copy.
        options["media"] = MEDIA["4x6"]
        options["print-color-mode"] = "color"
        options["sides"] = "one-sided"
    else:
        options["media"] = MEDIA.get(settings.get("paperSize", "A4"), MEDIA["A4"])
    if settings.get("pageRange"):
        options["page-ranges"] = str(settings["pageRange"])
    return options


class Printer:
    def __init__(self, config: AgentConfig):
        self.config = config
        self._snmp_lock = threading.Lock()
        self._ink: dict[str, int] = {}
        self._sheets_since_refill = 0

    # ------------------------------------------------------------------ ink
    def ink_levels(self) -> dict[str, int]:
        """SNMP ink tanks (configurable Epson OIDs); IPP marker-levels fallback."""
        with self._snmp_lock:
            cached = dict(self._ink) if self._ink else {}
        if cached:
            return cached
        levels = self._snmp_levels() or self._ipp_marker_levels() or {}
        if levels:
            with self._snmp_lock:
                self._ink = dict(levels)
        return dict(levels)

    def _snmp_levels(self) -> dict[str, int] | None:
        try:
            from pysnmp.hlapi import (
                CommunityData,
                ContextData,
                ObjectIdentity,
                ObjectType,
                SnmpEngine,
                UdpTransportTarget,
                getCmd,
            )
        except ImportError:
            return None
        try:
            engine = SnmpEngine()
            community = CommunityData("public", mpModel=0)
            target = UdpTransportTarget((self.config.printer_ip, 161), timeout=2, retries=1)
            out: dict[str, int] = {}
            for name, oid in self.config.snmp_oids.items():
                iterator = getCmd(
                    engine, community, target, ContextData(), ObjectType(ObjectIdentity(oid))
                )
                error, _, _, var_binds = next(iterator)
                if error:
                    log.debug("SNMP error for %s: %s", name, error)
                    return None
                for vb in var_binds:
                    value = int(vb[1])
                    out[name] = max(0, min(100, value))
            return out or None
        except Exception:  # noqa: BLE001 — SNMP is best-effort
            log.debug("SNMP ink query failed", exc_info=True)
            return None

    def _ipp_marker_levels(self) -> dict[str, int] | None:
        try:
            attrs = cups.Connection().getPrinterAttributes(name=self.config.printer_queue_name)
            names = [str(n).lower() for n in (attrs.get("marker-names") or [])]
            levels = [int(v) for v in (attrs.get("marker-levels") or [])]
            if not names or len(names) != len(levels):
                return None
            out = {}
            for name, level in zip(names, levels):
                for color in ("black", "cyan", "magenta", "yellow"):
                    if color[:3] in name or (color == "black" and ("k" == name.strip() or "bk" in name)):
                        out[color] = level
            return out or None
        except Exception:  # noqa: BLE001
            return None

    # ------------------------------------------------------------- heartbeat
    def state(self) -> dict:
        reasons: list[str] = []
        try:
            attrs = cups.Connection().getPrinterAttributes(name=self.config.printer_queue_name)
            reasons = [
                str(r) for r in (attrs.get("printer-state-reasons") or []) if str(r) != "none"
            ]
        except Exception:  # noqa: BLE001
            reasons = ["unreachable"]
        error = any(r in FATAL_REASONS or r == "unreachable" for r in reasons)
        return {
            "printerState": "error" if error else "idle",
            "printerStateReasons": reasons,
            "inkLevels": self.ink_levels(),
            "sheetsSinceRefill": self._sheets_since_refill,
        }

    # ------------------------------------------------------------- printing
    def count_sheets(self, pages: int, settings: dict) -> int:
        duplex = settings.get("duplex") and settings.get("mode", "document") == "document"
        per_copy = (pages + 1) // 2 if duplex else pages
        return per_copy * int(settings.get("copies", 1))

    def print_file(
        self,
        path: str,
        title: str,
        settings: dict,
        on_progress: Callable[[int, int], None] | None = None,
    ) -> int:
        """Submit to CUPS and monitor until completion; raises PrintFailure."""
        conn = cups.Connection()
        options = build_cups_options(settings)
        try:
            cups_job = conn.printFile(self.config.printer_queue_name, path, title, options)
        except Exception as exc:  # noqa: BLE001
            raise PrintFailure("CUPS_SUBMIT_FAILED", str(exc)) from exc

        log.info("CUPS job %s submitted (%s)", cups_job, options)
        total = int(settings.get("copies", 1)) * (settings.get("pages", 1) or 1)
        last_marker: tuple[int, int] = (-1, -1)
        last_progress_ts = time.monotonic()

        while True:
            time.sleep(2)
            try:
                jobs = conn.getJobs(
                    which_jobs="not-completed",
                    my_jobs=False,
                    requested_attributes=["job-id", "job-k-octets", "job-impressions-completed"],
                )
            except Exception as exc:  # noqa: BLE001
                raise PrintFailure("CUPS_UNREACHABLE", str(exc)) from exc

            attrs = next((j for j in jobs if j.get("job-id") == cups_job), None)
            if attrs is None:
                break  # left the active queue — final state checked below

            marker = (int(attrs.get("job-k-octets", 0)), int(attrs.get("job-impressions-completed", 0)))
            if marker != last_marker and marker != (0, 0):
                last_marker = marker
                last_progress_ts = time.monotonic()
                if on_progress and marker[1] > 0:
                    on_progress(min(marker[1], total), total)

            if time.monotonic() - last_progress_ts > self.config.print_progress_timeout:
                self._cancel(conn, cups_job)
                raise PrintFailure("NO_PAGE_PROGRESS", f"no progress for {self.config.print_progress_timeout}s")

            fatal = self._fatal_printer_reasons(conn)
            if fatal:
                self._cancel(conn, cups_job)
                raise PrintFailure("PRINTER_ERROR", ",".join(fatal))

        try:
            completed = conn.getJobs(which_jobs="completed", my_jobs=False, limit=50)
        except Exception:  # noqa: BLE001
            completed = []
        if any(
            j.get("job-id") == cups_job and str(j.get("job-state", "")).lower() in ("canceled", "aborted")
            for j in completed
        ):
            raise PrintFailure("CUPS_JOB_ABORTED", f"cups job {cups_job} aborted/canceled")

        self._sheets_since_refill += self.count_sheets(settings.get("pages", 1) or 1, settings)
        if on_progress:
            on_progress(total, total)
        return cups_job

    def test_print(self, path: str) -> int:
        return self.print_file(
            path, "kiosk-test-print",
            {"copies": 1, "color": False, "duplex": False, "paperSize": "A4", "pages": 1},
        )

    # --------------------------------------------------------------- private
    def _fatal_printer_reasons(self, conn: cups.Connection) -> list[str]:
        try:
            attrs = conn.getPrinterAttributes(name=self.config.printer_queue_name)
            reasons = [str(r) for r in (attrs.get("printer-state-reasons") or [])]
            return [r for r in reasons if r in FATAL_REASONS]
        except Exception:  # noqa: BLE001
            return []

    def _cancel(self, conn: cups.Connection, cups_job: int) -> None:
        try:
            conn.cancelJob(cups_job)
        except Exception:  # noqa: BLE001
            log.warning("failed to cancel CUPS job %s", cups_job, exc_info=True)
