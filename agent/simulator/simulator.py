#!/usr/bin/env python3
"""
Phase 1 simulator kiosk agent (spec §10 Phase 1).

Connects to the API's Socket.IO /kiosk namespace like the real agent will,
waits for queued jobs, claims them with the OTP (typed in, passed via --otp,
or delivered through --otp-file), downloads the file, "prints" it by saving
to the output dir, and reports progress/completion. Also sends heartbeats.

Usage:
  python simulator.py --api http://localhost:4000 --kiosk K001 --secret dev-secret-001
                      [--out ../printed] [--otp 1234 | --otp-file path.txt]
"""
import argparse
import pathlib
import socketio
import sys
import threading
import time
import urllib.request

ARGS = None


def log(msg: str) -> None:
    print(f"[sim] {msg}", flush=True)


sio = socketio.Client(logger=False, engineio_logger=False, reconnection=True)


@sio.event(namespace="/kiosk")
def connect():
    log(f"connected to {ARGS.api} (/kiosk) as kiosk {ARGS.kiosk} — waiting for jobs")


@sio.event(namespace="/kiosk")
def connect_error(data):
    log(f"connect error: {data} (check kiosk id/secret and that the API is running)")


def get_otp(job_id: str) -> str:
    if ARGS.otp:
        return ARGS.otp
    if ARGS.otp_dir:
        # Per-job OTP file: <dir>/<jobId>.txt — lets many jobs run concurrently.
        path = pathlib.Path(ARGS.otp_dir) / f"{job_id}.txt"
        deadline = time.time() + 300
        while time.time() < deadline:
            if path.exists():
                value = path.read_text(encoding="utf-8").strip()
                if value:
                    try:
                        path.unlink()
                    except OSError:
                        pass
                    return value
            time.sleep(0.25)
        raise TimeoutError(f"timed out waiting for OTP file for {job_id}")
    if ARGS.otp_file:
        path = pathlib.Path(ARGS.otp_file)
        deadline = time.time() + 120
        while time.time() < deadline:
            if path.exists():
                value = path.read_text(encoding="utf-8").strip()
                if value:
                    try:
                        path.unlink()
                    except OSError:
                        pass
                    return value
            time.sleep(0.5)
        raise TimeoutError("timed out waiting for the OTP file")
    return input("Enter the 4-digit OTP shown on the user's phone: ").strip()


@sio.on("job:queued", namespace="/kiosk")
def on_job_queued(payload):
    # Claim in a worker thread so queued jobs never block the event loop.
    threading.Thread(target=claim_job, args=(payload,), daemon=True).start()


def claim_job(payload: dict) -> None:
    job_id = payload.get("jobId")
    log(f"job queued: {job_id} ({payload.get('fileName')}, {payload.get('pages')} pages) — requesting OTP")
    try:
        otp = get_otp(job_id)
    except TimeoutError as exc:
        log(str(exc))
        return

    result: dict = {}

    def on_result(res):
        result.update(res or {})

    sio.emit("job:claim", {"jobId": job_id, "otp": otp}, namespace="/kiosk", callback=on_result)
    deadline = time.time() + 15
    while not result and time.time() < deadline:
        time.sleep(0.1)
    handle_claim(job_id, result or {})


def handle_claim(job_id: str, result) -> None:
    if not result or not result.get("ok"):
        error = (result or {}).get("error", "no response")
        log(f"claim REJECTED for {job_id}: {error}")
        if error == "LOCKED":
            log("too many wrong attempts — job is locked, user must contact support")
        return

    out_dir = pathlib.Path(ARGS.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / f"{job_id}.pdf"
    log(f"claim ok — downloading {result['fileUrl']}")
    urllib.request.urlretrieve(result["fileUrl"], dest)
    log(f"saved {dest}")

    pages = result.get("pages") or 1
    log(f'"printing" {pages} page(s)…')
    for page in range(1, pages + 1):
        sio.emit("job:progress", {"jobId": job_id, "page": page, "pages": pages}, namespace="/kiosk")
        time.sleep(0.3)
        if ARGS.fail_after and page >= ARGS.fail_after:
            sio.emit("job:failed", {"jobId": job_id, "reason": "SIMULATED_PRINTER_FAILURE"}, namespace="/kiosk")
            log(f"job {job_id} FAILED (simulated) after {page} page(s)")
            return

    sio.emit("job:completed", {"jobId": job_id}, namespace="/kiosk")
    log(f"job {job_id} COMPLETED — collect your prints")


def heartbeat_loop() -> None:
    while True:
        sio.emit(
            "heartbeat",
            {
                "printerState": "idle",
                "inkLevels": {"black": 80, "cyan": 70, "magenta": 70, "yellow": 70},
                "sheetsSinceRefill": 0,
                "agentVersion": "sim-0.1.0",
            },
            namespace="/kiosk",
        )
        time.sleep(30)


def main() -> None:
    global ARGS
    parser = argparse.ArgumentParser(description="Phase 1 print kiosk simulator agent")
    parser.add_argument("--api", default="http://localhost:4000")
    parser.add_argument("--kiosk", default="K001")
    parser.add_argument("--secret", default="dev-secret-001")
    parser.add_argument("--out", default=str(pathlib.Path(__file__).resolve().parent.parent / "printed"))
    parser.add_argument("--otp", help="OTP to use (skips prompting)")
    parser.add_argument("--otp-file", help="File the OTP will appear in (polled)")
    parser.add_argument("--otp-dir", help="Per-job OTP files appear here as <jobId>.txt (polled)")
    parser.add_argument("--fail-after", type=int, help="Simulate printer failure after N pages (0 = off)")
    ARGS = parser.parse_args()

    try:
        sio.connect(
            ARGS.api,
            namespaces=["/kiosk"],
            auth={"kioskId": ARGS.kiosk, "secret": ARGS.secret},
            wait=True,
        )
    except Exception as exc:  # noqa: BLE001
        sys.exit(f"could not connect to {ARGS.api}: {exc}")

    threading.Thread(target=heartbeat_loop, daemon=True).start()
    sio.wait()


if __name__ == "__main__":
    main()
