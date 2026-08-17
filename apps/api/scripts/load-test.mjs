/**
 * Phase 5 load test (spec §10): 20 concurrent jobs across 3 simulated kiosks.
 * Verifies every job reaches COMPLETED and no files linger afterwards.
 * Usage: node apps/api/scripts/load-test.mjs [jobs=20]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const API = 'http://localhost:4000';
const KIOSKS = ['K001', 'K002', 'K003'];
const TOTAL = Number(process.argv[2] ?? 20);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`Load test — page ${i}/${pages}`, { x: 60, y: 760, size: 22, font });
  }
  return Buffer.from(await doc.save());
}

async function waitForKiosksOnline() {
  // Reset all three so ONLINE proves a fresh agent connection.
  spawn('node', ['-e', `
    const { PrismaClient } = require('@prisma/client');
    const p = new PrismaClient();
    Promise.all(['K001','K002','K003'].map(id => p.kiosk.update({ where: { id }, data: { status: 'OFFLINE' } })))
      .then(() => p.$disconnect()).catch(() => {});
  `], { cwd: join(repoRoot, 'apps', 'api'), stdio: 'ignore' });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const states = await Promise.all(KIOSKS.map(async (id) => (await api(`/kiosks/${id}/info`)).body?.status));
    if (states.every((s) => s === 'ONLINE')) return true;
    await sleep(500);
  }
  return false;
}

async function runJob(index, pdf, otpDir) {
  const kioskId = KIOSKS[index % KIOSKS.length];
  const created = await api('/jobs', { method: 'POST', body: JSON.stringify({ kioskId, fileName: `load-${index}.pdf` }) });
  const jobId = created.body.jobId;
  const token = new URL(created.body.upload.url).searchParams.get('token');
  const put = await fetch(created.body.upload.url, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: pdf });
  if (!put.ok) throw new Error(`job ${index}: upload failed ${put.status}`);
  const processed = await api(`/jobs/${jobId}/process`, { method: 'POST', token });
  if (processed.status !== 200) throw new Error(`job ${index}: process failed ${processed.status}`);
  const priced = await api(`/jobs/${jobId}/price`, {
    method: 'POST', token,
    body: JSON.stringify({ mode: 'document', copies: 1, color: index % 2 === 0, duplex: false, paperSize: 'A4' }),
  });
  if (priced.status !== 200) throw new Error(`job ${index}: price failed ${priced.status}`);
  const paid = await api(`/jobs/${jobId}/pay`, { method: 'POST', token });
  if (paid.status !== 200) throw new Error(`job ${index}: pay failed ${paid.status}`);
  const st = await api(`/jobs/${jobId}/status`, { token });
  // Per-job OTP file — the simulator picks it up by jobId (concurrency-safe).
  writeFileSync(join(otpDir, `${jobId}.txt`), st.body?.otp ?? '');
  return { jobId, token };
}

async function main() {
  console.log(`\nLoad test — ${TOTAL} jobs across ${KIOSKS.length} kiosks\n`);
  const printedDir = mkdtempSync(join(tmpdir(), 'pk-load-'));
  const otpDir = mkdtempSync(join(tmpdir(), 'pk-load-otp-'));

  const sims = KIOSKS.map((id) =>
    spawn('python', [
      join(repoRoot, 'agent', 'simulator', 'simulator.py'),
      '--api', API, '--kiosk', id, '--secret', 'dev-secret-001',
      '--otp-dir', otpDir, '--out', printedDir,
    ], { stdio: ['ignore', 'ignore', 'ignore'] }),
  );

  try {
    if (!(await waitForKiosksOnline())) throw new Error('simulators did not come online');

    const started = Date.now();
    const pdf = await makePdf(3);
    const jobs = await Promise.all(
      Array.from({ length: TOTAL }, (_, i) => runJob(i, pdf, otpDir).catch((err) => ({ error: err.message }))),
    );
    const failures = jobs.filter((j) => j.error);
    if (failures.length) throw new Error(`${failures.length} job(s) failed to start: ${failures.map((f) => f.error).join('; ')}`);
    console.log(`  ${TOTAL} jobs uploaded, priced, and paid in ${((Date.now() - started) / 1000).toFixed(1)}s — waiting for prints…`);

    const deadline = Date.now() + 180_000;
    let completed = 0;
    while (Date.now() < deadline) {
      const states = await Promise.all(
        jobs.map(async (j) => (await api(`/jobs/${j.jobId}/status`, { token: j.token })).body?.state),
      );
      completed = states.filter((s) => s === 'COMPLETED').length;
      process.stdout.write(`\r  completed ${completed}/${TOTAL}`);
      if (completed === TOTAL) break;
      await sleep(1000);
    }
    console.log('');

    const durationS = ((Date.now() - started) / 1000).toFixed(1);
    const printed = readdirSync(printedDir).length;
    const leftovers = readdirSync(join(repoRoot, '.local', 'uploads'));
    const allDone = completed === TOTAL;

    console.log(`\n  ${allDone ? 'PASS' : 'FAIL'}  all ${TOTAL} jobs COMPLETED in ${durationS}s`);
    console.log(`  ${printed === TOTAL ? 'PASS' : 'FAIL'}  ${printed}/${TOTAL} prints produced`);
    console.log(`  ${leftovers.length === 0 ? 'PASS' : 'FAIL'}  no files linger in uploads (${leftovers.length})`);

    if (!allDone || printed !== TOTAL || leftovers.length > 0) {
      process.exit(1);
    }
    console.log('\nLOAD TEST PASSED ✅\n');
  } finally {
    sims.forEach((sim) => sim.kill());
  }
}

main().catch((err) => {
  console.error('\nLOAD TEST FAILED ❌:', err);
  process.exit(1);
});
