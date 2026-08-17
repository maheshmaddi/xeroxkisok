/**
 * Phase 5 chaos tests (spec §10): corrupt PDF, 0-byte upload, aborted upload,
 * OTP lockout after 5 wrong attempts, double-pay conflict, and a final
 * terminal-state audit (no stuck jobs, no lingering files).
 * Usage: node apps/api/scripts/chaos-test.mjs
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
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

async function makePdf(pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) doc.addPage([595.28, 841.89]).drawText(`chaos ${i}/${pages}`, { x: 60, y: 760, size: 22, font });
  return Buffer.from(await doc.save());
}

async function newJob(fileName) {
  const created = await api('/jobs', { method: 'POST', body: JSON.stringify({ kioskId: 'K001', fileName }) });
  return {
    jobId: created.body.jobId,
    token: new URL(created.body.upload.url).searchParams.get('token'),
    url: created.body.upload.url,
  };
}

function claimWithOtp(jobId, otp) {
  return new Promise((resolve) => {
    const socket = io(`${API}/kiosk`, { auth: { kioskId: 'K001', secret: 'dev-secret-001' }, transports: ['websocket'] });
    socket.on('connect', () => {
      socket.emit('job:claim', { jobId, otp }, (result) => {
        socket.close();
        resolve(result);
      });
    });
    socket.on('connect_error', () => resolve(null));
    setTimeout(() => resolve(null), 8000);
  });
}

async function main() {
  console.log(`\nChaos tests — ${API}\n`);

  // 1. Corrupt PDF: starts like a PDF, body is garbage.
  {
    const job = await newJob('corrupt.pdf');
    const garbage = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2048, 7)]);
    const put = await fetch(job.url, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: garbage });
    check('corrupt PDF upload accepted', put.ok, `status=${put.status}`);
    const processed = await api(`/jobs/${job.jobId}/process`, { method: 'POST', token: job.token });
    check('corrupt PDF rejected with a clear message', processed.status === 400 && /corrupt/i.test(processed.body?.message ?? ''), processed.body?.message);
    const st = await api(`/jobs/${job.jobId}/status`, { token: job.token });
    check('corrupt PDF job FAILED (terminal)', st.body?.state === 'FAILED' && st.body?.failReason === 'CORRUPT_PDF', `${st.body?.state}/${st.body?.failReason}`);
  }

  // 2. 0-byte upload.
  {
    const job = await newJob('empty.pdf');
    const put = await fetch(job.url, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: Buffer.alloc(0) });
    check('0-byte upload rejected', put.status === 400, `status=${put.status}`);
  }

  // 3. Connection killed mid-upload (4G drop simulation): the route never
  //    completes, so the job must have no file and be unprocessable.
  {
    const job = await newJob('aborted.pdf');
    const killed = await new Promise((resolve) => {
      const u = new URL(job.url);
      const req = http.request(
        { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'PUT', headers: { 'content-type': 'application/pdf', 'content-length': String(8 * 1024 * 1024) } },
        (res) => resolve(res.statusCode),
      );
      // Announce 8MB, send a chunk, then drop the connection.
      req.write(Buffer.alloc(256 * 1024, 1));
      setTimeout(() => req.destroy(new Error('simulated network drop')), 50);
      req.on('error', () => resolve('killed'));
    });
    check('upload connection dropped mid-transfer', killed === 'killed', `result=${killed}`);
    await sleep(500);
    const processed = await api(`/jobs/${job.jobId}/process`, { method: 'POST', token: job.token });
    check('aborted upload leaves job unprocessable (no file)', processed.status === 409, `status=${processed.status}`);
  }

  // 4. OTP lockout: 5 wrong attempts → LOCKED.
  {
    const job = await newJob('lockout.pdf');
    await fetch(job.url, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: await makePdf(2) });
    await api(`/jobs/${job.jobId}/process`, { method: 'POST', token: job.token });
    await api(`/jobs/${job.jobId}/price`, {
      method: 'POST', token: job.token,
      body: JSON.stringify({ mode: 'document', copies: 1, color: false, duplex: false, paperSize: 'A4' }),
    });
    await api(`/jobs/${job.jobId}/pay`, { method: 'POST', token: job.token });
    const st = await api(`/jobs/${job.jobId}/status`, { token: job.token });
    const otp = st.body?.otp;
    check('lockout job paid and OTP issued', /^\d{4}$/.test(otp ?? ''));

    let locked = false;
    let lastError = null;
    for (let i = 1; i <= 5; i++) {
      const wrong = await claimWithOtp(job.jobId, otp === '0000' ? '9999' : '0000');
      lastError = wrong?.error;
      if (wrong?.error === 'LOCKED') { locked = true; break; }
    }
    check('5 wrong OTPs lock the job', locked, `lastError=${lastError}`);
    const st2 = await api(`/jobs/${job.jobId}/status`, { token: job.token });
    check('status shows otpLocked', st2.body?.otpLocked === true);

    // Cleanup: backdate so the sweep refunds the locked job.
    spawn('node', ['-e', `
      const { PrismaClient } = require('@prisma/client');
      const p = new PrismaClient();
      p.job.update({ where: { id: '${job.jobId}' }, data: { otpExpiresAt: new Date(Date.now() - 60000) } })
        .then(() => p.$disconnect()).catch(() => {});
    `], { cwd: join(repoRoot, 'apps', 'api'), stdio: 'ignore' });
  }

  // 5. Double pay conflict.
  {
    const job = await newJob('double.pdf');
    await fetch(job.url, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: await makePdf(1) });
    await api(`/jobs/${job.jobId}/process`, { method: 'POST', token: job.token });
    await api(`/jobs/${job.jobId}/price`, {
      method: 'POST', token: job.token,
      body: JSON.stringify({ mode: 'document', copies: 1, color: false, duplex: false, paperSize: 'A4' }),
    });
    const first = await api(`/jobs/${job.jobId}/pay`, { method: 'POST', token: job.token });
    const second = await api(`/jobs/${job.jobId}/pay`, { method: 'POST', token: job.token });
    check('first pay ok, second pay 409', first.status === 200 && second.status === 409, `${first.status}/${second.status}`);

    // Cleanup: backdate so it expires into refund instead of lingering queued.
    spawn('node', ['-e', `
      const { PrismaClient } = require('@prisma/client');
      const p = new PrismaClient();
      p.job.update({ where: { id: '${job.jobId}' }, data: { otpExpiresAt: new Date(Date.now() - 60000) } })
        .then(() => p.$disconnect()).catch(() => {});
    `], { cwd: join(repoRoot, 'apps', 'api'), stdio: 'ignore' });
  }

  // 6. Wait for sweeps to settle, then audit: no stuck jobs, no lingering files.
  console.log('  waiting for sweeps to settle (~20s)…');
  await sleep(22_000);
  {
    const audit = spawn('node', ['-e', `
      const { PrismaClient } = require('@prisma/client');
      const p = new PrismaClient();
      (async () => {
        const stuck = await p.job.count({
          where: { state: { in: ['PAID', 'QUEUED'] }, otpExpiresAt: { lt: new Date() } },
        });
        const withFiles = await p.job.count({ where: { fileKey: { not: null }, state: { in: ['COMPLETED', 'FAILED', 'REFUNDED', 'EXPIRED'] } } });
        console.log(JSON.stringify({ stuck, withFiles }));
        await p.$disconnect();
      })();
    `], { cwd: join(repoRoot, 'apps', 'api'), stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    audit.stdout.on('data', (d) => (out += d));
    await new Promise((r) => audit.on('exit', r));
    const { stuck, withFiles } = JSON.parse(out || '{}');
    check('no stuck expired jobs remain', stuck === 0, `stuck=${stuck}`);
    check('no lingering files on terminal jobs', withFiles === 0, `withFiles=${withFiles}`);
    const uploads = readdirSync(join(repoRoot, '.local', 'uploads'));
    check('uploads dir empty at end', uploads.length === 0, uploads.join(', '));
  }

  console.log(failed.length === 0 ? '\nALL CHAOS CHECKS PASSED ✅\n' : `\n${failed.length} CHECK(S) FAILED ❌ — ${failed.join(', ')}\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('chaos test crashed:', err);
  process.exit(1);
});
