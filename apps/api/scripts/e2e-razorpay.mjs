/**
 * Razorpay integration test (test keys): real order creation, real checkout
 * signature verification via /pay/confirm, full print pipeline, refund path
 * left to the mock suites (real refunds need a completed checkout UI).
 *
 * Reads RAZORPAY_KEY_SECRET from apps/api/.env to sign the confirm payload —
 * exactly what checkout.js does in the browser after a successful payment.
 * Usage: node apps/api/scripts/e2e-razorpay.mjs
 */
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const API = 'http://localhost:4000';

const failed = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed.push(name);
}

function env(name) {
  const match = readFileSync(join(repoRoot, 'apps', 'api', '.env'), 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1).trim() : undefined;
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
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function main() {
  const keySecret = env('RAZORPAY_KEY_SECRET');
  const mode = env('PAYMENTS_MODE') ?? 'auto';
  console.log(`\nRazorpay integration — PAYMENTS_MODE=${mode}\n`);
  if (!keySecret) {
    console.log('FAIL  RAZORPAY_KEY_SECRET not set in apps/api/.env\n');
    process.exit(1);
  }

  const printedDir = mkdtempSync(join(tmpdir(), 'pk-rzp-'));
  const otpFile = join(tmpdir(), `pk-rzp-otp-${Date.now()}.txt`);
  const sim = spawn('python', [
    join(repoRoot, 'agent', 'simulator', 'simulator.py'),
    '--api', API, '--kiosk', 'K001', '--secret', 'dev-secret-001',
    '--otp-file', otpFile, '--out', printedDir,
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  try {
    // Simulator online
    spawn('node', ['-e', `
      const { PrismaClient } = require('@prisma/client');
      const p = new PrismaClient();
      p.kiosk.update({ where: { id: 'K001' }, data: { status: 'OFFLINE' } })
        .then(() => p.$disconnect()).catch(() => {});
    `], { cwd: join(repoRoot, 'apps', 'api'), stdio: 'ignore' });
    let online = false;
    for (let i = 0; i < 30 && !online; i++) {
      online = (await api('/kiosks/K001/info')).body?.status === 'ONLINE';
      if (!online) await sleep(500);
    }
    check('simulator online', online);

    // Job → priced ₹10 (1 page color... keep 1 page B&W @₹2 → ₹2; use color 1 page = ₹8)
    const doc = await PDFDocument.create();
    doc.addPage([595.28, 841.89]).drawText('razorpay integration', { x: 60, y: 760, size: 24, font: await doc.embedFont(StandardFonts.Helvetica) });
    const pdf = Buffer.from(await doc.save());

    const created = await api('/jobs', { method: 'POST', body: JSON.stringify({ kioskId: 'K001', fileName: 'rzp-test.pdf' }) });
    const jobId = created.body.jobId;
    const token = new URL(created.body.upload.url).searchParams.get('token');
    await fetch(created.body.upload.url, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: pdf });
    await api(`/jobs/${jobId}/process`, { method: 'POST', token });
    await api(`/jobs/${jobId}/price`, {
      method: 'POST', token,
      body: JSON.stringify({ mode: 'document', copies: 1, color: true, duplex: false, paperSize: 'A4' }),
    });

    // Real order creation against api.razorpay.com
    const paid = await api(`/jobs/${jobId}/pay`, { method: 'POST', token });
    check('pay returns razorpay mode with real order', paid.status === 200 && paid.body?.mode === 'razorpay' && /^order_/.test(paid.body?.orderId ?? ''), JSON.stringify(paid.body).slice(0, 90));

    // Confirm with a checkout-style signature (what checkout.js posts after success)
    const paymentId = `pay_test_${Date.now().toString(36)}`;
    const signature = createHmac('sha256', keySecret).update(`${paid.body.orderId}|${paymentId}`).digest('hex');
    const confirmed = await api(`/jobs/${jobId}/pay/confirm`, {
      method: 'POST', token,
      body: JSON.stringify({ razorpay_order_id: paid.body.orderId, razorpay_payment_id: paymentId, razorpay_signature: signature }),
    });
    check('checkout signature accepted → QUEUED', confirmed.status === 200 && confirmed.body?.state === 'QUEUED', `status=${confirmed.status}`);

    // Tampered signature must be rejected on a fresh job
    {
      const c2 = await api('/jobs', { method: 'POST', body: JSON.stringify({ kioskId: 'K001', fileName: 'rzp-bad.pdf' }) });
      const t2 = new URL(c2.body.upload.url).searchParams.get('token');
      await fetch(c2.body.upload.url, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: pdf });
      await api(`/jobs/${c2.body.jobId}/process`, { method: 'POST', token: t2 });
      await api(`/jobs/${c2.body.jobId}/price`, {
        method: 'POST', token: t2,
        body: JSON.stringify({ mode: 'document', copies: 1, color: false, duplex: false, paperSize: 'A4' }),
      });
      const p2 = await api(`/jobs/${c2.body.jobId}/pay`, { method: 'POST', token: t2 });
      const bad = await api(`/jobs/${c2.body.jobId}/pay/confirm`, {
        method: 'POST', token: t2,
        body: JSON.stringify({ razorpay_order_id: p2.body.orderId, razorpay_payment_id: 'pay_test_evil', razorpay_signature: 'deadbeef' }),
      });
      check('tampered checkout signature rejected (400)', bad.status === 400, `status=${bad.status}`);
      // Let it expire-refund via sweep instead of lingering.
      spawn('node', ['-e', `
        const { PrismaClient } = require('@prisma/client');
        const p = new PrismaClient();
        p.job.update({ where: { id: '${c2.body.jobId}' }, data: { otpExpiresAt: new Date(Date.now() - 60000) } })
          .then(() => p.$disconnect()).catch(() => {});
      `], { cwd: join(repoRoot, 'apps', 'api'), stdio: 'ignore' });
    }

    // Full pipeline: OTP → simulator claim → print → completed
    const st = await api(`/jobs/${jobId}/status`, { token });
    check('OTP revealed after confirm', /^\d{4}$/.test(st.body?.otp ?? ''));
    writeFileSync(otpFile, st.body.otp);

    let final;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const { body } = await api(`/jobs/${jobId}/status`, { token });
      final = body;
      if (['COMPLETED', 'FAILED', 'REFUNDED'].includes(body?.state)) break;
      await sleep(1000);
    }
    check('razorpay-paid job prints and completes', final?.state === 'COMPLETED', `state=${final?.state}`);
    const printed = readdirSync(printedDir).some((f) => f.startsWith(jobId));
    check('print produced', printed);
    const uploads = readdirSync(join(repoRoot, '.local', 'uploads'));
    check('file deleted after completion', uploads.length === 0, uploads.join(', '));
  } finally {
    sim.kill();
  }

  console.log(failed.length === 0 ? '\nALL CHECKS PASSED ✅\n' : `\n${failed.length} CHECK(S) FAILED ❌ — ${failed.join(', ')}\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('e2e crashed:', err);
  process.exit(1);
});
