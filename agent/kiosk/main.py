"""kiosk-agent entrypoint — wires connection, keypad, printer, display, jobs.

Run under systemd (kiosk-agent.service). Hard rules honored here (spec §7):
outbound-only networking, localhost-only display, no OTP acceptance while
offline, shred-on-finish file handling.
"""

from __future__ import annotations

import logging
import os
import signal
import threading

from . import __version__
from .config import AgentConfig, load_config
from .connection import KioskConnection
from .display import DisplayState, make_qr_data_url, run_display
from .jobs import JobRunner
from .printer import Printer
from . import updater

logging.basicConfig(
    level=os.environ.get("KIOSK_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
log = logging.getLogger("kiosk.main")


def main() -> None:
    config: AgentConfig = load_config()
    log.info("kiosk agent %s starting for %s", __version__, config.kiosk_id)

    updater.check_and_update(config)  # startup check; daily loop spawned below

    printer = Printer(config)
    app_url = os.environ.get("PUBLIC_APP_URL", "https://app.example.in")
    display_state = DisplayState(
        config,
        qr_data_url=make_qr_data_url(f"{app_url}/?kiosk={config.kiosk_id}"),
        kiosk_name=config.kiosk_id,
    )

    current_jobs: list[dict] = []
    job_lock = threading.Lock()

    def state_provider() -> dict:
        return printer.state()

    def on_job_queued(payload: dict) -> None:
        # Queue, don't drop: several customers may have paid back-to-back.
        # The keypad code identifies whose job it is (server-side matching).
        with job_lock:
            current_jobs.append(payload)
        display_state.set("enter-otp", f"{len(current_jobs)} job(s) waiting" if len(current_jobs) > 1 else "")
        display_state.broadcast()  # type: ignore[attr-defined]

    def on_keypad_submit(otp: str) -> None:
        nonlocal current_jobs
        with job_lock:
            waiting = len(current_jobs)
        if waiting == 0:
            return
        job_id = runner.run_by_code(otp)
        if job_id:
            with job_lock:
                current_jobs = [j for j in current_jobs if j.get("jobId") != job_id]

    def on_keypad_change(buffer: str) -> None:
        display_state.set("enter-otp", "•" * len(buffer))
        display_state.broadcast()  # type: ignore[attr-defined]

    def on_command(payload: dict) -> None:
        cmd = payload.get("type")
        log.info("remote command: %s", cmd)
        if cmd == "reboot_agent":
            os.kill(os.getpid(), signal.SIGTERM)
        elif cmd == "maintenance_on":
            display_state.set("error", "This kiosk is under maintenance. Sorry!", "Maintenance")
            display_state.broadcast()  # type: ignore[attr-defined]
        elif cmd == "maintenance_off":
            display_state.set("idle")
            display_state.broadcast()  # type: ignore[attr-defined]
        elif cmd == "test_print":
            test = pathlib_write_test_page()
            try:
                printer.test_print(str(test))
            finally:
                test.unlink(missing_ok=True)

    def pathlib_write_test_page() -> "pathlib.Path":
        import pathlib

        page = pathlib.Path(config.tmp_dir) / "test.txt"
        page.parent.mkdir(parents=True, exist_ok=True)
        page.write_text(f"Print kiosk {config.kiosk_id} — test print {__version__}\n")
        return page

    connection = KioskConnection(
        config,
        handlers={
            "on_job_queued": on_job_queued,
            "on_command": on_command,
            "state_provider": state_provider,
        },
    )
    runner = JobRunner(config, connection, printer, display_state)
    runner.has_pending = lambda: len(current_jobs) > 0  # display flips back to enter-otp
    runner.cleanup_tmp()

    # Keypad (evdev): if missing we log loudly — the kiosk is unusable for OTP.
    from .keypad import KeypadListener

    keypad = KeypadListener(on_keypad_submit, on_change=on_keypad_change)
    if not keypad.start():
        log.error("running without keypad — OTP entry will not work")

    threading.Thread(target=run_display, args=(display_state,), daemon=True, name="display").start()

    def daily_update() -> None:
        import time

        while True:
            time.sleep(24 * 3600)
            updater.check_and_update(config)

    threading.Thread(target=daily_update, daemon=True, name="updater").start()

    # Offline → display must say so and NEVER accept OTPs (spec §7 hard rules):
    connection.sio.on("disconnect", namespace="/kiosk")(lambda: _mark_offline(display_state))
    connection.sio.on("connect", namespace="/kiosk")(lambda: _mark_online(display_state))

    try:
        connection.connect()
    except Exception as exc:  # noqa: BLE001 — keep retrying per spec
        log.error("initial connect failed (%s); retrying in background", exc)
        connection.sio.connect(
            config.api_url,
            namespaces=["/kiosk"],
            auth={"kioskId": config.kiosk_id, "secret": config.kiosk_secret},
        )
    connection.run_forever()


def _mark_offline(state: DisplayState) -> None:
    state.offline = True
    state.set("error", "We are fixing this — please try again soon.", "Temporarily offline")
    state.broadcast()  # type: ignore[attr-defined]


def _mark_online(state: DisplayState) -> None:
    state.offline = False
    state.set("idle")
    state.broadcast()  # type: ignore[attr-defined]


if __name__ == "__main__":
    main()
