# Print Kiosk

Self-service document + photo printing kiosk. Users scan a QR code, upload from
their phone, pay via UPI (mock in Phase 1), get a 4-digit OTP, and collect
prints. Spec: [`spec_doc/PRINT_KIOSK_SPEC.md`](spec_doc/PRINT_KIOSK_SPEC.md).

## Local development (no Docker)

Prereqs: Node 20+, pnpm 9/10, Python 3.11+ (agent), poppler (`pdftoppm`, optional
— preview thumbnails are skipped without it).

```bash
pnpm bootstrap    # install, build shared, push SQLite schema, seed dev kiosk K001
pnpm dev          # web (3000) + admin (3001) + api (4000), SQLite + local-disk storage

# in a second terminal — the simulator kiosk agent
python -m pip install -r agent/requirements.txt
python agent/simulator/simulator.py --api http://localhost:4000 --kiosk K001 --secret dev-secret-001
```

Then open `http://localhost:3000/?kiosk=K001`, upload
`node apps/api/scripts/make-test-pdf.mjs`'s output (or any PDF), configure,
mock-pay, and type the OTP into the simulator prompt. The "print" lands in
`agent/printed/`.

## Phase 1 end-to-end acceptance

With the API running:

```bash
pnpm e2e          # spawns the simulator itself and walks the full flow
```

## Layout

```
apps/web     Next.js user app (mobile-first flow)
apps/admin   Next.js admin dashboard (placeholder until Phase 5)
apps/api     NestJS API — jobs pipeline, pricing, OTP, Socket.IO /kiosk, sweeps
agent/       Python kiosk agent (Phase 1: simulator; Phase 3: real hardware)
packages/    shared TS: zod schemas, pricing, types
.local/      gitignored dev state (SQLite db + uploaded files)
```

Databases: SQLite locally (`prisma db push`, schema generated from the
canonical Postgres schema), PostgreSQL 16 + Cloudflare R2 in production.
CI (when added) must run migrations + tests against Postgres to catch drift.
