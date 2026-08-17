"""Print Kiosk agent (Phase 3) — runs on the kiosk controller under systemd.

Modules (spec §7):
  config     /etc/kiosk/config.yaml loading
  connection Socket.IO client to the cloud API (outbound-only WSS)
  keypad     USB 4x4 keypad OTP input (evdev)
  printer    CUPS/IPP printing + monitoring for the Epson L15150, SNMP ink
  display    local FastAPI status page for the Chromium kiosk screen
  jobs       download → tmpfs → print → shred pipeline
  updater    signed self-update
"""

__version__ = "0.1.0"
