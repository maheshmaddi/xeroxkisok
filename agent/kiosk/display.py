"""Local status page served on localhost:8080 for the Chromium kiosk screen
(spec §7 display.py). FastAPI + WebSocket; the agent pushes state updates.

Shows: big QR ("Scan to print"), OTP entry state ("Enter OTP •••4"), live
progress ("Printing page 3 of 10"), collection and error messages.
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse

from .config import AgentConfig

log = logging.getLogger("kiosk.display")

PAGE_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kiosk</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; height:100vh; background:#0f172a; color:#f8fafc;
         font-family: system-ui, sans-serif; display:flex; flex-direction:column;
         align-items:center; justify-content:center; gap:2rem; text-align:center; }
  #qr { background:#fff; padding:16px; border-radius:16px; }
  #qr img { width:min(38vh,320px); height:auto; display:block; }
  h1 { font-size:clamp(2rem,7vh,4rem); margin:0; font-weight:800; }
  p  { font-size:clamp(1.2rem,3.5vh,2rem); margin:0; color:#cbd5e1; }
  #otp { font-size:clamp(4rem,18vh,9rem); letter-spacing:0.35em; font-weight:800; }
  .error h1 { color:#f87171; }
  .hidden { display:none; }
</style></head>
<body>
  <div id="idle">
    <div id="qr"><img id="qrimg" alt="Scan to print QR"></div>
    <h1>Scan to print</h1>
    <p id="kioskname"></p>
  </div>
  <div id="enterotp" class="hidden"><h1>Enter your code</h1><p>on the keypad below</p></div>
  <div id="otp" class="hidden"></div>
  <div id="printing" class="hidden"><h1>Printing…</h1><p id="progress"></p></div>
  <div id="collect" class="hidden"><h1>Collect your prints 🎉</h1></div>
  <div id="error" class="hidden error"><h1 id="errtitle">Printer problem</h1><p id="errdetail"></p></div>
<script>
const ws = new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws');
const screens = ['idle','enterotp','printing','collect','error'].map(id=>document.getElementById(id));
function show(id){ screens.forEach(s=>s.classList.add('hidden')); if(id) document.getElementById(id).classList.remove('hidden'); }
ws.onmessage = (ev) => {
  const st = JSON.parse(ev.data);
  if (st.qrDataUrl) document.getElementById('qrimg').src = st.qrDataUrl;
  if (st.kioskName) document.getElementById('kioskname').textContent = st.kioskName;
  if (st.offline) { show('error'); document.getElementById('errtitle').textContent='Temporarily offline';
      document.getElementById('errdetail').textContent='We are fixing this — please try again soon.'; return; }
  if (st.phase === 'idle') show('idle');
  else if (st.phase === 'enter-otp') show('enterotp');
  else if (st.phase === 'printing') { show('printing'); document.getElementById('progress').textContent = st.detail || ''; }
  else if (st.phase === 'collect') show('collect');
  else if (st.phase === 'error') { show('error'); document.getElementById('errtitle').textContent = st.title || 'Printer problem';
      document.getElementById('errdetail').textContent = st.detail || ''; }
};
ws.onclose = () => setTimeout(()=>location.reload(), 3000);
</script></body></html>"""


class DisplayState:
    """Thread-safe-ish state hub between agent threads and the WS loop."""

    def __init__(self, config: AgentConfig, qr_data_url: str, kiosk_name: str):
        self.config = config
        self.qr_data_url = qr_data_url
        self.kiosk_name = kiosk_name
        self.phase = "idle"
        self.detail = ""
        self.title = ""
        self.offline = False

    def snapshot(self) -> dict:
        return {
            "phase": self.phase,
            "detail": self.detail,
            "title": self.title,
            "offline": self.offline,
            "qrDataUrl": self.qr_data_url,
            "kioskName": self.kiosk_name,
        }

    def set(self, phase: str, detail: str = "", title: str = "") -> None:
        self.phase, self.detail, self.title = phase, detail, title


def make_qr_data_url(payload: str) -> str:
    import qrcode

    img = qrcode.make(payload, box_size=10, border=2)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def build_app(state: DisplayState) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    clients: set[WebSocket] = set()
    loop: asyncio.AbstractEventLoop | None = None

    @app.on_event("startup")
    async def _grab_loop():
        nonlocal loop
        loop = asyncio.get_running_loop()

    def broadcast() -> None:
        """Called from agent (non-async) threads to push state to all screens."""
        if loop is None:
            return
        data = state.snapshot()

        async def send():
            dead = []
            for ws in clients:
                try:
                    await ws.send_json(data)
                except Exception:  # noqa: BLE001
                    dead.append(ws)
            for ws in dead:
                clients.discard(ws)

        try:
            asyncio.run_coroutine_threadsafe(send(), loop)
        except RuntimeError:
            pass

    state.broadcast = broadcast  # type: ignore[attr-defined]

    @app.get("/", response_class=HTMLResponse)
    async def index():
        return PAGE_HTML

    @app.websocket("/ws")
    async def ws_endpoint(websocket: WebSocket):
        await websocket.accept()
        clients.add(websocket)
        try:
            await websocket.send_json(state.snapshot())
            while True:
                await websocket.receive_text()  # keepalive; ignore content
        except WebSocketDisconnect:
            clients.discard(websocket)

    return app


def run_display(state: DisplayState) -> None:
    """Blocking — run in its own thread. Localhost only (spec §7 hard rules)."""
    import uvicorn

    app = build_app(state)
    uvicorn.run(app, host="127.0.0.1", port=state.config.display_port, log_level="warning")
