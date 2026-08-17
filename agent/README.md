# Kiosk Agent (Python)

Two runtimes share the same Socket.IO protocol (`/kiosk` namespace):

| | Phase 1–2 (local dev) | Phase 3 (kiosk controller) |
|---|---|---|
| Entry | `simulator/simulator.py` | `kiosk/main.py` under systemd |
| Printing | saves the PDF to `agent/printed/` | CUPS/IPP on the Epson L15150 |
| OTP input | CLI prompt / `--otp` / `--otp-file` | USB 4x4 keypad via evdev |
| Ink/status | hardcoded healthy heartbeat | SNMP + IPP marker-levels |
| Display | none | FastAPI + WebSocket on localhost:8080 |

## Simulator (local dev)

```bash
python -m pip install -r requirements.txt
python simulator/simulator.py --api http://localhost:4000 --kiosk K001 --secret dev-secret-001
```

Prompted for the OTP; `--otp 1234` or `--otp-file path.txt` for scripted runs,
`--fail-after N` simulates a printer failure after N pages (refund path).

## Real agent (Phase 3 — hardware)

Provision the Intel N100 controller (Ubuntu Server 24.04):

```bash
sudo systemd/install.sh K001 192.168.1.50 L15150 https://app.example.in
sudo cp config.example.yaml /etc/kiosk/config.yaml   # fill in the kiosk secret
sudo systemctl start kiosk-agent kiosk-display
```

What `install.sh` sets up: driverless IPP CUPS queue (`everywhere` model),
`kiosk` user with lp+input group access, tmpfs scratch at `/dev/shm/kiosk`,
hardened systemd units (`Restart=always`, `ProtectSystem=strict`, no inbound
ports beyond localhost:8080), and Chromium kiosk mode pointing at the local
status page.

Module map (spec §7): `connection.py` (Socket.IO + backoff + 30s heartbeats),
`keypad.py` (evdev digit buffer, `#` submit, `*` clear), `printer.py` (CUPS
options mapping, 2s job polling, IPP state reasons, SNMP ink with fallback,
180s no-progress failure detection → cancel + report), `display.py` (QR + OTP +
progress + error screens over WebSocket), `jobs.py` (download → tmpfs → print →
shred), `updater.py` (daily signed release check, sha256 + ed25519).

> Status: code-complete, **not yet validated against physical hardware** — the
> spec's Phase 3 acceptance (paper-out mid-job → refund, ink via SNMP, duplex
> color A3) must be run on the kiosk controller with the L15150 attached.
