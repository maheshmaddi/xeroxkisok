"""Socket.IO connection to the cloud API with exponential backoff (spec §7).

Outbound-only: the agent connects to the API's /kiosk namespace and never
listens on any port except localhost for the display.
"""

from __future__ import annotations

import logging
import threading
import time

import socketio

from . import __version__
from .config import AgentConfig

log = logging.getLogger("kiosk.connection")


class KioskConnection:
    def __init__(self, config: AgentConfig, handlers: dict):
        """
        handlers: callables invoked by the connection:
          on_job_queued(payload)              → begin claim/print flow
          on_command(payload)                 → remote admin command
          state_provider() -> dict            → heartbeat extras (ink, printer…)
        """
        self.config = config
        self.handlers = handlers
        self.sio = socketio.Client(logger=False, engineio_logger=False, reconnection=True)
        self._backoff = 1
        self._register()

    def _register(self) -> None:
        sio, ns = self.sio, "/kiosk"

        @sio.event(namespace=ns)
        def connect():
            self._backoff = 1
            log.info("connected to %s as kiosk %s", self.config.api_url, self.config.kiosk_id)

        @sio.event(namespace=ns)
        def disconnect():
            log.warning("disconnected from API — display should show offline; retrying")

        @sio.event(namespace=ns)
        def connect_error(data):
            # python-socketio retries automatically; we just track backoff for
            # anything that needs it (none today) and keep the log calm.
            wait = min(self._backoff, 60)
            self._backoff = min(self._backoff * 2, 60)
            log.warning("connect error (%s); next retry in ~%ss", data, wait)

        @sio.on("job:queued", namespace=ns)
        def on_job_queeded(payload):
            self.handlers["on_job_queued"](payload)

        @sio.on("kiosk:command", namespace=ns)
        def on_command(payload):
            self.handlers["on_command"](payload)

    def connect(self) -> None:
        self.sio.connect(
            self.config.api_url,
            namespaces=["/kiosk"],
            auth={"kioskId": self.config.kiosk_id, "secret": self.config.kiosk_secret},
            wait=True,
            retry=True,
        )

    def run_forever(self) -> None:
        """Heartbeat loop — call from a daemon thread (spec: every 30s)."""

        def beat():
            while True:
                try:
                    extras = self.handlers["state_provider"]()
                    self.sio.emit(
                        "heartbeat",
                        {"agentVersion": __version__, **extras},
                        namespace="/kiosk",
                    )
                except Exception:  # noqa: BLE001 — never kill the heartbeat loop
                    log.exception("heartbeat failed")
                time.sleep(self.config.heartbeat_seconds)

        threading.Thread(target=beat, daemon=True, name="heartbeat").start()
        self.sio.wait()

    def emit(self, event: str, data: dict, callback=None) -> None:
        self.sio.emit(event, data, namespace="/kiosk", callback=callback)
