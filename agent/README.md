# Kiosk Agent (Python)

## Phase 1 — simulator

`simulator/simulator.py` acts as a kiosk: connects to the API over Socket.IO,
claims queued jobs with the OTP, downloads the file, and "prints" it by
saving to `agent/printed/`. The real agent (CUPS/IPP, keypad, SNMP, local
status display) is built in Phase 3 against the same events.

```bash
python -m pip install -r requirements.txt

python simulator/simulator.py \
  --api http://localhost:4000 \
  --kiosk K001 \
  --secret dev-secret-001
```

You'll be prompted for the 4-digit OTP shown in the web app. For scripted
runs use `--otp 1234` or `--otp-file path.txt` (the file is polled and
consumed once the OTP appears).
