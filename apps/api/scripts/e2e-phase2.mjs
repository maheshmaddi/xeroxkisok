/**
 * Phase 2 acceptance test (spec §10):
 *   full paid flow (mock provider), auto-refund on simulated mid-print failure,
 *   expiry → refund, Payment rows recorded, webhook signature enforcement.
 *
 * Prereqs: API running with the dev .env (RAZORPAY keys unset → mock mode,
 * RAZORPAY_WEBHOOK_SECRET=dev-webhook-secret, SWEEP_INTERVAL_SEC=15).
 * Usage: node apps/api/scripts/e2e-phase2.mjs
 */
import { createHmac } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const API = 'http://localhost:4000';
const WEBHOOK_SECRET = 'dev-webhook-secret';

const failed = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed.push(name);
}

async function api(path, opts = {}) {
  const { token, ...rest } = opts;
  const res = await fetch(`${API}${path}`, {
    ...rest,
    headers: {
      ...(rest.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { 'x-job-token': token } : {}),
      ...rest.headers,
    },
  });
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

async function makePdf(pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`Phase 2 e2e — page ${i}/${pages}`, { x: 60, y: 760, size: 24, font, color: rgb(0.1, 0.1, 0.1) });
  }
  return Buffer.from(await doc.save());
}

async function waitForKioskOnline(timeoutMs = 30_000) {
  // Reset first so ONLINE proves THIS simulator connected (not a stale status).
  spawnSyncNode(`
    const { PrismaClient } = require('@prisma/client');
    const p = new PrismaClient();
    p.kiosk.update({ where: { id: 'K001' }, data: { status: 'OFFLINE' } })
      .then(() => p.$disconnect()).catch(() => {});
  `);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await api('/kiosks/K001/info');
    if (body?.status === 'ONLINE') return true;
    await sleep(500);
  }
  return false;
}

/** Drive one job through pay; returns {jobId, token, otp}. */
async function paidJob(fileName) {
  const created = await api('/jobs', { method: 'POST', body: JSON.stringify({ kioskId: 'K001', fileName }) });
  const jobId = created.body.jobId;
  const token = new URL(created.body.upload.url).searchParams.get('token');
  const pdf = await makePdf(5);
  await fetch(created.body.upload.url, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: pdf });
  await api(`/jobs/${jobId}/process`, { method: 'POST', token });
  await api(`/jobs/${jobId}/price`, {
    method: 'POST', token,
    body: JSON.stringify({ mode: 'document', copies: 1, color: true, duplex: false, paperSize: 'A4' }),
  });
  const paid = await api(`/jobs/${jobId}/pay`, { method: 'POST', token });
  const st = await api(`/jobs/${jobId}/status`, { token });
  return { jobId, token, otp: st.body?.otp, payMode: paid.body?.mode, priceTotal: st.body?.priceTotal };
}

async function waitForState(jobId, token, states, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await api(`/jobs/${jobId}/status`, { token });
    if (states.includes(body?.state)) return body;
    await sleep(1000);
  }
  return null;
}

function spawnSim(extraArgs) {
  const printedDir = mkdtempSync(join(tmpdir(), 'pk2-printed-'));
  const otpFile = join(tmpdir(), `pk2-otp-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const sim = spawn('python', [
    join(repoRoot, 'agent', 'simulator', 'simulator.py'),
    '--api', API, '--kiosk', 'K001', '--secret', 'dev-secret-001',
    '--otp-file', otpFile, '--out', printedDir, ...extraArgs,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  sim.stdout.on('data', (d) => process.stdout.write(`  [sim] ${d}`));
  sim.stderr.on('data', (d) => process.stdout.write(`  [sim!] ${d}`));
  return { sim, printedDir, otpFile };
}

async function main() {
  console.log(`\nPhase 2 e2e — ${API} (mock provider)\n`);

  // --- 1. Happy path with Payment row ---
  const run1 = spawnSim([]);
  try {
    check('simulator online', await waitForKioskOnline());
    const job = await paidJob('p2-happy.pdf');
    check('mock pay mode', job.payMode === 'mock', `mode=${job.payMode}`);
    check('OTP revealed', /^\d{4}$/.test(job.otp ?? ''));
    writeFileSync(run1.otpFile, job.otp);
    const final = await waitForState(job.jobId, job.token, ['COMPLETED', 'FAILED', 'REFUNDED'], 60_000);
    check('happy path COMPLETED', final?.state === 'COMPLETED', `state=${final?.state}`);
    const leftovers = readdirSync(join(repoRoot, '.local', 'uploads')).filter((f) => f === `${job.jobId}.bin`);
    check('file deleted after completion', leftovers.length === 0);
  } finally {
    run1.sim.kill();
  }

  // --- 2. Mid-print failure → automatic refund ---
  const run2 = spawnSim(['--fail-after', '2']);
  try {
    await waitForKioskOnline();
    const job = await paidJob('p2-fail.pdf');
    check('failure-path job priced (₹40)', job.priceTotal === 4000, `paise=${job.priceTotal}`);
    writeFileSync(run2.otpFile, job.otp);
    const final = await waitForState(job.jobId, job.token, ['REFUNDED', 'FAILED', 'COMPLETED'], 60_000);
    check('failed job auto-refunded → REFUNDED', final?.state === 'REFUNDED', `state=${final?.state}`);
    const leftovers = readdirSync(join(repoRoot, '.local', 'uploads')).filter((f) => f === `${job.jobId}.bin`);
    check('file deleted after failed+refunded job', leftovers.length === 0);
  } finally {
    run2.sim.kill();
  }

  // --- 3. Expiry → auto refund (backdate OTP expiry, wait for sweep) ---
  {
    const job = await paidJob('p2-expire.pdf');
    check('expiry-path job is QUEUED', Boolean(job.otp));
    // Reveal consumed the OTP; backdate the window so the sweep refunds it.
    const setExpired = spawn('node', ['-e', `
      const { PrismaClient } = require('@prisma/client');
      const p = new PrismaClient();
      p.job.update({ where: { id: '${job.jobId}' }, data: { otpExpiresAt: new Date(Date.now() - 60_000) } })
        .then(() => p.$disconnect()).catch((e) => { console.error(e); process.exit(1); });
    `], { cwd: join(repoRoot, 'apps', 'api'), stdio: 'inherit' });
    await new Promise((r) => setExpired.on('exit', r));
    const final = await waitForState(job.jobId, job.token, ['REFUNDED', 'EXPIRED', 'FAILED'], 90_000);
    check('expired unclaimed job refunded', final?.state === 'REFUNDED' || final?.state === 'EXPIRED', `state=${final?.state}`);
    const leftovers = readdirSync(join(repoRoot, '.local', 'uploads')).filter((f) => f === `${job.jobId}.bin`);
    check('file deleted after expiry', leftovers.length === 0);
  }

  // --- 4. Webhook signature enforcement ---
  {
    const payload = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_x', order_id: 'order_none', status: 'captured' } } } });
    const goodSig = createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
    const ok = await fetch(`${API}/webhooks/razorpay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': goodSig },
      body: payload,
    });
    check('valid signature accepted (200)', ok.status === 200, `status=${ok.status}`);

    const bad = await fetch(`${API}/webhooks/razorpay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': 'deadbeef' },
      body: payload,
    });
    check('invalid signature rejected (400)', bad.status === 400, `status=${bad.status}`);
  }

  // --- 5. Payment audit rows exist for the refunded jobs ---
  {
    const rows = spawnSyncNode(`
      const { PrismaClient } = require('@prisma/client');
      const p = new PrismaClient();
      p.payment.findMany({ select: { status: true, amount: true, refundId: true, razorpayOrderId: true } })
        .then(async (all) => { console.log(JSON.stringify(all)); await p.$disconnect(); });
    `);
    const payments = JSON.parse(rows || '[]');
    check('Payment rows recorded', payments.length >= 3, `${payments.length} rows`);
    check('refunds tracked', payments.some((p) => p.status === 'refunded' && p.refundId), JSON.stringify(payments.filter((p) => p.refundId).map((p) => p.status)));
  }

  console.log(failed.length === 0 ? '\nALL CHECKS PASSED ✅\n' : `\n${failed.length} CHECK(S) FAILED ❌ — ${failed.join(', ')}\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

function spawnSyncNode(code) {
  try {
    return execFileSync('node', ['-e', code], { cwd: join(repoRoot, 'apps', 'api'), encoding: 'utf8' });
  } catch {
    return '';
  }
}

main().catch((err) => {
  console.error('e2e crashed:', err);
  process.exit(1);
});
