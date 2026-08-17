# Self-Service Print Kiosk — Complete Software Specification

> **Instructions for Claude Code:** Build this project phase by phase in the order given.
> Complete each phase's acceptance criteria before moving to the next.
> Ask before deviating from the stack or data model. Use TypeScript strict mode everywhere except the kiosk agent (Python).
>
> **Local dev rule:** Dev machines run **zero Docker** — SQLite for the DB, on-disk file storage via a StorageService adapter. Production: PostgreSQL 16 + Cloudflare R2. CI runs the suite against Postgres to catch drift.

---

## 1. Product Overview

A self-service document + photo printing kiosk (like a vending machine). Users scan a QR code on the kiosk, upload files from their phone browser, pay via UPI, receive a 4-digit OTP, enter it on the kiosk keypad, and collect their prints. No app install, no signup. Files are auto-deleted after printing.

**Hardware context (already decided, code against this):**
- Printer: **Epson EcoTank L15150** (A3 color inkjet, duplex, network via IPP/CUPS, ink levels via SNMP)
- Kiosk controller: Intel N100 mini PC running Ubuntu Server 24.04
- OTP input: USB 4x4 keypad (presents as HID keyboard)
- Status display: HDMI screen showing a fullscreen kiosk status page (Chromium kiosk mode)
- Connectivity: 4G router, outbound-only (no inbound ports on kiosk)

---

## 2. System Architecture

```
[User's phone browser]                [Admin browser]
   |  (web app)                          | (dashboard)
   v                                     v
+---------------------------------------------------+
|                 CLOUD BACKEND (API)               |
|  Next.js user app · NestJS API · Postgres · R2    |
|  Razorpay payments · WebSocket gateway            |
+---------------------------------------------------+
                        ^
                        | WSS (outbound from kiosk only)
                        v
+---------------------------------------------------+
|              KIOSK AGENT (Python, systemd)        |
|  keypad listener · CUPS/IPP printing · SNMP       |
|  local status page served to Chromium display     |
+---------------------------------------------------+
                        |
                        v  IPP (LAN)
                [Epson L15150 printer]
```

**Monorepo layout (pnpm workspaces + a Python package):**

```
print-kiosk/
├── apps/
│   ├── web/          # Next.js 14+ user-facing app (mobile-first)
│   ├── admin/        # Next.js admin dashboard
│   └── api/          # NestJS backend
├── agent/            # Python 3.11 kiosk agent (poetry or uv)
├── packages/
│   └── shared/       # shared TS types, pricing logic, zod schemas
├── .local/           # gitignored local-dev state: dev.db (SQLite) + uploads/
└── PRINT_KIOSK_SPEC.md
```

---

## 3. Tech Stack (fixed)

| Layer | Choice |
|---|---|
| User web app | Next.js (App Router), Tailwind, mobile-first |
| Admin dashboard | Next.js, Tailwind, recharts |
| API | NestJS, Prisma; PostgreSQL 16 (prod) / SQLite (local dev, no Docker) |
| File storage | Cloudflare R2 (prod); local dev: StorageService adapter writing to `.local/uploads` on disk |
| Payments | Razorpay (UPI-first checkout) — sandbox keys in dev |
| Realtime | Socket.IO (kiosk agents + admin live updates) |
| Kiosk agent | Python 3.11, pycups or IPP via `ipptool`/HTTP, pysnmp, evdev (keypad), FastAPI (local status page) |
| DOCX→PDF | LibreOffice headless (worker container in prod; native `soffice` binary in local dev) |
| PDF processing | pdf-lib / pdfjs (page count, preview thumbnails server-side via pdftoppm) |
| Auth (admin) | email + password, session cookie, single OWNER role for v1 |

### Local development (no Docker)

One command: `pnpm dev` starts web + admin + api concurrently.

- The API runs against SQLite (`.local/dev.db` via `schema.sqlite.prisma`, `prisma db push`) and the on-disk StorageService (`.local/uploads`).
- `.local/` is gitignored and swept by the same 60-min deletion cron as prod files.
- No Docker, no MinIO, no Postgres on dev machines. Docker is used only in CI (Postgres 16 migration + test run) to catch dev/prod drift.
- The Python simulator agent (Phase 1) is unchanged.

---

## 4. Data Model (Prisma)

```prisma
model Kiosk {
  id            String   @id            // "K001"
  name          String                  // "ABC College, Gate 2"
  secretKey     String                  // agent auth token (hashed)
  printerIp     String
  pricingId     String
  pricing       PricingProfile @relation(fields: [pricingId], references: [id])
  status        KioskStatus @default(OFFLINE) // ONLINE | OFFLINE | ERROR | MAINTENANCE
  lastSeenAt    DateTime?
  inkLevels     Json?                   // {black: 80, cyan: 65, ...} from SNMP
  sheetsSinceRefill Int @default(0)
  paperCapacity Int @default(500)
  jobs          Job[]
}

model PricingProfile {
  id        String @id @default(cuid())
  name      String
  bwA4      Int    // paise per side, e.g. 200 = ₹2
  colorA4   Int
  bwA3      Int
  colorA3   Int
  photo4x6  Int
  passportSheet Int // 8-up passport photos on 4x6
  kiosks    Kiosk[]
}

model Job {
  id          String   @id @default(cuid())
  kioskId     String
  kiosk       Kiosk    @relation(fields: [kioskId], references: [id])
  fileKey     String?  // R2 object key (null after deletion)
  fileName    String
  fileType    String   // pdf | docx | jpg | png
  pages       Int
  settings    Json     // {copies, color: bool, duplex: bool, paperSize, pageRange, mode: "document"|"photo4x6"|"passport"}
  priceTotal  Int      // paise
  otpHash     String?
  otpExpiresAt DateTime?
  state       JobState @default(UPLOADED)
  // UPLOADED | PRICED | AWAITING_PAYMENT | PAID | QUEUED | PRINTING | COMPLETED | FAILED | REFUNDED | EXPIRED
  failReason  String?
  payment     Payment?
  createdAt   DateTime @default(now())
  printedAt   DateTime?
}

model Payment {
  id              String @id @default(cuid())
  jobId           String @unique
  job             Job    @relation(fields: [jobId], references: [id])
  razorpayOrderId String
  razorpayPaymentId String?
  amount          Int
  status          String // created | captured | refund_initiated | refunded
  refundId        String?
}

model ConsumableEvent {
  id        String   @id @default(cuid())
  kioskId   String
  type      String   // PAPER_REFILL | INK_REFILL | SNAPSHOT
  data      Json
  createdAt DateTime @default(now())
}
```

**SQLite compatibility (local dev):** Prisma's SQLite connector does not support `Json` fields or `enum` types, so the schema above uses the lowest common denominator — valid on both providers:

- `Json` fields (`Kiosk.inkLevels`, `Job.settings`, `ConsumableEvent.data`) are `String` columns storing serialized JSON; parse + validate with zod schemas in `packages/shared` at the service boundary.
- `JobState` / `KioskStatus` are `String` columns; allowed values are TS unions + zod enums in `packages/shared`, enforced by application code.
- Two Prisma schema files (Prisma cannot switch `provider` via env var): canonical `apps/api/prisma/schema.prisma` (`postgresql`, source of migrations for prod/CI) and `schema.sqlite.prisma` (`sqlite`, local dev via `prisma db push` — no migration files locally).
- CI applies the Postgres migrations and runs the full test suite against PostgreSQL 16 to catch dialect drift. Docker appears only in CI, never on dev machines.

---

## 5. API Surface (NestJS)

### Public (user app)
- `POST /jobs` — create job for kiosk `{kioskId}`; returns an upload URL from the StorageService: presigned PUT to R2 in prod, a local API route (`PUT /jobs/:id/file`) in dev. The client uses whatever URL the API returns — identical client logic in both modes.
- `POST /jobs/:id/process` — after upload: convert DOCX→PDF if needed, count pages, generate up to 3 preview thumbnails, return page count + previews
- `POST /jobs/:id/price` — body: settings; validates settings against kiosk capability, returns itemized price
- `POST /jobs/:id/pay` — creates Razorpay order, returns order details for checkout
- `POST /webhooks/razorpay` — verify signature; on `payment.captured`: mark PAID, generate OTP (store hash only), set 30-min expiry, push job to kiosk via socket, return OTP to user app via `GET /jobs/:id/status`
- `GET /jobs/:id/status` — polled by user app; returns state + OTP (only once, only to the session that created the job)

### Kiosk agent (auth: kiosk id + secret key header)
- Socket.IO namespace `/kiosk`: events `job:queued`, `job:claim` (agent sends OTP attempt → server verifies hash, returns signed file URL), `job:progress`, `job:completed`, `job:failed`, `heartbeat` (every 30s with ink/paper/printer status)
- `POST /kiosks/:id/refill` — field staff logs paper/ink refill (resets sheet counter)

### Admin
- CRUD kiosks + pricing profiles
- `GET /admin/overview` — revenue today/week, jobs, kiosk statuses
- `GET /admin/kiosks/:id` — detail: live status, ink, paper estimate, recent jobs, error log
- `POST /admin/jobs/:id/refund` — manual refund
- `POST /admin/kiosks/:id/command` — remote: reboot agent, test print, maintenance mode

### Critical backend rules
1. **File deletion:** delete the stored object via the StorageService (R2 delete in prod, disk delete in `.local/uploads` in dev) + null `fileKey` immediately on COMPLETED, FAILED, or 60 min after upload (cron sweep). This is a hard product guarantee.
2. **Auto-refund:** any PAID/QUEUED/PRINTING job that transitions to FAILED triggers Razorpay refund automatically; state → REFUNDED.
3. **OTP:** 4 digits, hashed (bcrypt), single-use, bound to kiosk + job, 30-min expiry. 5 wrong attempts → job locked, user must contact support (show support WhatsApp number).
4. **Expiry:** PAID jobs not claimed within 30 min → EXPIRED → auto-refund.
5. **Price integrity:** price is computed server-side only; the client never sends an amount.

---

## 6. User Web App — Screens & Flow

Mobile-first. URL: `https://app.BRAND.in/?kiosk=K001` (from QR).

1. **Landing** — kiosk name/location, "Upload to print" button, price card. If kiosk OFFLINE/ERROR → show "This kiosk is temporarily unavailable" and nearest alternative.
2. **Upload** — file picker (PDF/DOCX/JPG/PNG, ≤50MB). Progress bar. Reject password-protected PDFs with a clear message.
3. **Settings** —
   - Document mode: copies (1–50), B&W/color toggle, single/duplex, paper A4/A3, page range
   - Photo mode (auto-offered for images): 4x6 print with crop tool, or Passport sheet (8 copies, 35×45mm each, auto-layout with white border; use canvas/sharp)
   - Live price updates on every change
4. **Preview & Pay** — first-page thumbnail, itemized price, Razorpay UPI checkout
5. **OTP screen** — big 4-digit OTP, countdown timer, instructions ("Enter this on the kiosk keypad"). Poll status → transitions to "Printing…" → "Done! Collect your prints" or "Failed — refund initiated, amount returns in 3–5 days".

Edge cases to handle explicitly: corrupt PDF, 0-page file, upload timeout on 4G, user closes browser (job status recoverable via link in the page URL — no login, use unguessable job token in URL).

---

## 7. Kiosk Agent (Python) — the critical component

Runs as systemd service `kiosk-agent.service` with `Restart=always`. Config in `/etc/kiosk/config.yaml` (kiosk id, secret, API url, printer IP).

### Modules
- **`connection.py`** — Socket.IO client with exponential backoff reconnect. Heartbeat every 30s: `{printerState, inkLevels, sheetsSinceRefill, agentVersion}`.
- **`keypad.py`** — evdev listener on the USB keypad. Buffers 4 digits, `#` = submit, `*` = clear. On submit → emit `job:claim {otp}` → server validates → returns signed file URL or rejection.
- **`printer.py`** — printing + monitoring for the L15150:
  - Print via CUPS: queue configured with `everywhere` (driverless IPP) driver. Options mapping:
    - color: `print-color-mode=color|monochrome`
    - duplex: `sides=two-sided-long-edge|one-sided`
    - size: `media=iso_a4_210x297mm|iso_a3_297x420mm` (photo: `media=custom` or 4x6 media if tray configured)
    - copies: `copies=N`
  - Monitor CUPS job state every 2s while printing; also query printer via IPP `Get-Printer-Attributes` for `printer-state-reasons` (media-jam, media-empty, marker-supply-low).
  - SNMP (pysnmp) poll every 60s for ink tank levels (Epson private MIB; if unreliable, fall back to IPP marker-levels attributes).
  - **Failure detection:** job in `processing` with no page progress for 180s, or printer-state-reasons contains an error → cancel CUPS job → report `job:failed {reason}` → agent shows failure on display.
- **`display.py`** — local FastAPI serving a fullscreen status page (Chromium in kiosk mode points to `http://localhost:8080`): shows big QR + "Scan to print", and during a job: "Enter OTP" / "Printing page 3 of 10" / "Collect your prints!" / error messages. WebSocket from agent to page for live updates.
- **`jobs.py`** — download file to tmpfs (`/dev/shm/kiosk`), print, then `shred`-delete immediately after completion/failure. Never write user files to persistent disk.
- **`updater.py`** — on startup and daily: check API for new agent version, download signed release, restart service.

### Agent hard rules
- Outbound connections only. No listening ports except localhost:8080.
- If backend unreachable: display "Temporarily offline" and keep retrying. Never accept OTPs offline.
- Count sheets printed (pages ÷ 2 if duplex × copies) and include in heartbeat for paper estimation.

---

## 8. Admin Dashboard

- **Overview:** kiosks map/list with live status dots, today's revenue, jobs, failure rate.
- **Kiosk detail:** ink level bars, estimated paper remaining (capacity − sheetsSinceRefill), job history, error timeline, buttons: test print, reboot, maintenance mode.
- **Alerts (WhatsApp via Meta Cloud API or Telegram bot — implement Telegram first, simpler):**
  - Kiosk offline > 5 min
  - Ink any color < 20%
  - Paper estimate < 50 sheets
  - Job failure rate > 20% in an hour
  - Daily 9 PM revenue summary
- **Refunds page:** all failed/refunded jobs with Razorpay refund status.

---

## 9. Security Checklist

- [ ] All traffic HTTPS/WSS; HSTS on web apps
- [ ] Presigned R2 URLs expire in 10 min; objects private
- [ ] Job status URL uses 128-bit random token; OTP never in URLs or logs
- [ ] Razorpay webhook signature verification mandatory
- [ ] Kiosk agent authenticates with per-kiosk secret; secrets rotatable from admin
- [ ] Rate limits: 10 uploads/hour/IP, 5 OTP attempts/job
- [ ] User files: encrypted at rest (R2 default), deleted per rules in §5; log deletion events
- [ ] No PII collected from users (no phone/email required); Razorpay handles payment KYC
- [ ] Agent machine: full-disk encryption, SSH key-only via Tailscale for maintenance

---

## 10. Build Phases & Acceptance Criteria

### Phase 1 — Core pipeline (local dev, no payments)
Monorepo scaffold, local dev stack (SQLite via `prisma db push` + StorageService on-disk adapter — no Docker), Prisma schema + Postgres migrations, job upload → page count → mock-pay button → OTP generation → a **simulator agent** (Python, prints to PDF via CUPS-PDF) claims OTP and "prints".
✅ *Accept:* upload a 5-page PDF in the web app, enter OTP in simulator CLI, PDF appears in output dir, job COMPLETED, file deleted from `.local/uploads`.

Local prerequisites: Node 20+, pnpm, Python 3.11, poppler (`pdftoppm` on PATH). No Docker.

### Phase 2 — Payments + real pricing
Razorpay sandbox integration end-to-end, webhook, auto-refund on simulated failure, 30-min expiry sweep, pricing profiles.
✅ *Accept:* full paid flow in sandbox; killing the simulator mid-print results in automatic refund and correct states.

### Phase 3 — Real printer integration
Agent against the physical L15150: driverless IPP queue setup script, all option mappings (color/duplex/A3), IPP status monitoring, jam/paper-out detection (test by removing paper mid-job), SNMP/IPP ink levels, tmpfs file handling + shred, keypad via evdev, Chromium status display.
✅ *Accept:* pull the paper tray mid-job → job FAILED + refund within 60s; ink levels visible in heartbeat; duplex color A3 prints correctly.

### Phase 4 — Photo mode + DOCX
LibreOffice headless for DOCX→PDF (local dev: native `soffice` binary on PATH; containerized worker is a prod deployment option); 4x6 crop UI; passport sheet generator (8× 35×45mm with borders, 300 DPI); photo pricing.
✅ *Accept:* upload a phone photo, get a correctly laid-out passport sheet printed.

### Phase 5 — Admin + alerts + hardening
Dashboard, Telegram alerts, refill logging, remote commands, agent auto-update, systemd hardening, load test (20 concurrent jobs across 3 simulated kiosks), chaos tests (kill network mid-download, corrupt PDF, password PDF, 0-byte file).
✅ *Accept:* all chaos tests end in a terminal state (COMPLETED/FAILED+REFUNDED/EXPIRED) with correct user messaging; no stuck jobs.

---

## 11. Environment Variables (document in .env.example)

```
# Dev (local, no Docker)
DATABASE_URL="file:./.local/dev.db"
STORAGE_DRIVER=local
LOCAL_STORAGE_DIR=.local/uploads

# Prod
DATABASE_URL=postgres://…
STORAGE_DRIVER=r2
S3_ENDPOINT= S3_BUCKET= S3_ACCESS_KEY= S3_SECRET_KEY=   # prod only
RAZORPAY_KEY_ID= RAZORPAY_KEY_SECRET= RAZORPAY_WEBHOOK_SECRET=
JWT_SECRET= ADMIN_EMAIL= ADMIN_PASSWORD_HASH=
TELEGRAM_BOT_TOKEN= TELEGRAM_CHAT_ID=
PUBLIC_APP_URL= API_URL=
```

Agent config (`/etc/kiosk/config.yaml`): `kiosk_id, kiosk_secret, api_url, printer_ip, printer_queue_name`.

## 12. Out of Scope for v1 (do not build yet)
User accounts, wallet/credits, scanning/photocopy of physical documents, multi-language UI (structure strings for i18n but ship English + one Indian language later), franchise multi-tenant admin, iOS/Android native apps.
