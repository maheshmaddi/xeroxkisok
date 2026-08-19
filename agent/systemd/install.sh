#!/usr/bin/env bash
# Kiosk controller provisioning (Ubuntu Server 24.04, Intel N100).
# Sets up the driverless IPP CUPS queue for the Epson L15150, the agent user,
# tmpfs scratch space, Chromium kiosk mode, and the systemd service (spec §7/§10).
set -euo pipefail

KIOSK_ID="${1:-K001}"
PRINTER_IP="${2:-}"
QUEUE="${3:-L15150}"
APP_URL="${4:-https://app.example.in}"

[ -n "$PRINTER_IP" ] || { echo "usage: install.sh KIOSK_ID PRINTER_IP [QUEUE] [APP_URL]"; exit 1; }

echo "==> Installing packages"
apt-get update
apt-get install -y cups cups-ipp-utils python3-venv python3-pip poppler-utils chromium-browser unclutter xinit \
  libcups2-dev python3-dev gcc # pycups builds from source on x86_64 and arm64 (Raspberry Pi) alike

echo "==> Driverless IPP queue ($QUEUE → ipp://$PRINTER_IP)"
lpadmin -p "$QUEUE" -E -v "ipp://$PRINTER_IP/ipp/print" -m everywhere
lpadmin -p "$QUEUE" -o printer-is-shared=false
cupsenable "$QUEUE"
cupsaccept "$QUEUE"

echo "==> Agent user + directories"
id -u kiosk >/dev/null 2>&1 || useradd -r -m -s /usr/sbin/nologin kiosk
usermod -aG lp kiosk                 # CUPS access
usermod -aG input kiosk              # keypad evdev access
mkdir -p /opt/print-kiosk /etc/kiosk
cp -r "$(dirname "$0")"/../kiosk /opt/print-kiosk/kiosk
python3 -m venv /opt/print-kiosk/venv
/opt/print-kiosk/venv/bin/pip install -r "$(dirname "$0")"/../requirements-agent.txt

echo "==> tmpfs scratch (user files never touch disk, spec §7)"
grep -q '/dev/shm/kiosk' /etc/fstab || echo 'tmpfs /dev/shm/kiosk tmpfs rw,size=64m,mode=1700,uid=kiosk,gid=kiosk 0 0' >> /etc/fstab
mount /dev/shm/kiosk || true

echo "==> systemd service"
cp "$(dirname "$0")/kiosk-agent.service" /etc/systemd/system/
sed -i "s|PUBLIC_APP_URL=.*|PUBLIC_APP_URL=$APP_URL|" /etc/systemd/system/kiosk-agent.service
systemctl daemon-reload
systemctl enable kiosk-agent

echo "==> Chromium kiosk display (autologin tty1 → X → chromium on localhost:8080)"
cat > /etc/systemd/system/kiosk-display.service <<'UNIT'
[Unit]
Description=Kiosk status display (Chromium)
After=network-online.target kiosk-agent.service
[Service]
User=kiosk
Environment=DISPLAY=:0
ExecStartPre=/usr/bin/Xorg :0 -nocursor -background none
ExecStart=/usr/bin/chromium-browser --kiosk --noerrdialogs --disable-infobars --overscroll-history-navigation=0 --incognito http://127.0.0.1:8080
Restart=always
RestartSec=5
[Install]
WantedBy=graphical.target
UNIT
systemctl enable kiosk-display

echo
echo "Now: copy agent/config.example.yaml → /etc/kiosk/config.yaml, fill in"
echo "kiosk_secret (from the admin dashboard), then: systemctl start kiosk-agent kiosk-display"
