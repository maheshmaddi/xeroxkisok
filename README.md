# Print Kiosk

Self-service document + photo printing kiosk. Users scan a QR code, upload from
their phone, pay via UPI (Razorpay; mock mode without keys), get a 4-digit OTP,
and collect prints. Spec: [`spec_doc/PRINT_KIOSK_SPEC.md`](spec_doc/PRINT_KIOSK_SPEC.md).

## Local development (no Docker)

Prereqs: Node 20+, pnpm 9/10, Python 3.11+ (agent), poppler (`pdftoppm`,
optional — previews), LibreOffice (`soffice`, optional — DOCX printing).

```bash
pnpm bootstrap    # install, build shared, push SQLite schema, seed kiosks K001–K003
pnpm dev          # web (3000) + admin (3001) + api (4000), SQLite + local-disk storage

# second terminal — simulator kiosk agent (prompts for the OTP)
python -m pip install -r agent/requirements.txt
python agent/simulator/simulator.py --api http://localhost:4000 --kiosk K001 --secret dev-secret-001
```

Then open `http://localhost:3000/?kiosk=K001` (admin: `http://localhost:3001`,
dev login `admin@local` / `admin-dev-123`).

## Test suites (API must be running)

| Command | Covers |
|---|---|
| `pnpm e2e` | Phase 1 acceptance — upload → price → mock pay → OTP → print → file deletion |
| `pnpm e2e:phase2` | payments: failure → auto-refund, expiry → refund, webhook signatures |
| `pnpm e2e:phase4` | photo 4×6 crop + passport sheet composition, DOCX branch |
| `pnpm e2e:razorpay` | live Razorpay test-key flow: real order, checkout signature confirm, tamper rejection |
| `pnpm load-test` | 20 concurrent jobs across 3 simulated kiosks |
| `pnpm chaos` | corrupt/0-byte/dropped uploads, OTP lockout, double pay, terminal-state audit |
| `pnpm test` | shared package pricing/range unit tests |

> The mock-mode suites (`e2e`, `e2e:phase2`, `e2e:phase4`, `load-test`, `chaos`)
> expect `PAYMENTS_MODE=mock` in `apps/api/.env` — real orders can't be captured
> without the checkout UI. `pnpm e2e:razorpay` runs against real test keys
> (`auto`/`razorpay` mode) by signing the checkout confirmation locally.

## Payments (Razorpay)

Put test keys in `apps/api/.env` (gitignored — never commit them):

```
RAZORPAY_KEY_ID=rzp_test_…
RAZORPAY_KEY_SECRET=…
PAYMENTS_MODE=auto        # auto = Razorpay when keys present; mock = instant capture
RAZORPAY_WEBHOOK_SECRET=… # must match the Razorpay dashboard webhook secret
```

Capture flows two ways: the browser calls `POST /jobs/:id/pay/confirm` after
checkout.js succeeds (signature verified with the key secret — works on
localhost), and `POST /webhooks/razorpay` handles `payment.captured` /
`refund.processed` in production. Set the webhook URL in the Razorpay
dashboard to `https://api.<your-domain>/webhooks/razorpay`.

## Phase status

1. ✅ Core pipeline (upload → mock-pay → OTP → simulator print → deletion)
2. ✅ Payments — Razorpay REST + webhook (keys unset = mock), auto-refund on
   failure/expiry, Payment audit rows. **Real-money flows need sandbox keys.**
3. ✅ Real kiosk agent code (CUPS/IPP, evdev keypad, SNMP ink, local display,
   systemd hardening, signed self-update) — **awaiting hardware validation**
   on the kiosk controller; see `agent/README.md`
4. ✅ Photo mode — 4×6 crop (server-side sharp), 8-up passport sheet on
   landscape 4×6 @300dpi, DOCX via LibreOffice when installed
5. ✅ Admin dashboard (login, revenue chart, kiosk detail + ink/paper, remote
   commands, refunds), Telegram alerts (log-only without a bot token),
   refill logging, load + chaos suites

## Layout

```
apps/web     Next.js user app (mobile-first flow: upload → settings → pay → OTP)
apps/admin   Next.js admin dashboard (owner login, overview, kiosks, refunds)
apps/api     NestJS API — jobs, payments/refunds, photos, admin, alerts, sweeps
agent/       Python kiosk agent (simulator/ for dev, kiosk/ for the controller)
packages/    shared TS: zod schemas, pricing, types
.local/      gitignored dev state (SQLite db + uploaded files)
```

Databases: SQLite locally (`prisma db push`, schema generated from the
canonical Postgres schema), PostgreSQL 16 + Cloudflare R2 in production.
CI (when added) must run migrations + tests against Postgres to catch drift.
