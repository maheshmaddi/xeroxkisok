/**
 * Phase 1 acceptance test (spec §10):
 *   upload a 5-page PDF in the web app API flow, enter OTP in the simulator
 *   agent, PDF appears in the simulator output dir, job COMPLETED, file
 *   deleted from local storage.
 *
 * Prereqs: API running (pnpm --filter @print-kiosk/api dev), DB seeded.
 * The script spawns the Python simulator itself.
 *
 * Usage: node apps/api/scripts/e2e-phase1.mjs [--api http://localhost:4000]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const API = flag('api', 'http://localhost:4000');
const KIOSK = flag('kiosk', 'K001');
const SECRET = flag('secret', 'dev-secret-001');

const printedDir = join(repoRoot, 'agent', 'printed');
const uploadsDir = join(repoRoot, '.local', 'uploads');
const otpFile = join(repoRoot, '.local', 'otp-e2e.txt');
const failed = [];

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

async function waitForKioskOnline(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await api(`/kiosks/${KIOSK}/info`);
    if (body?.status === 'ONLINE') return true;
    await sleep(500);
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeTestPdf(pages = 5) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`Print Kiosk — e2e test`, { x: 60, y: 760, size: 28, font, color: rgb(0.1, 0.1, 0.12) });
    page.drawText(`Page ${i} of ${pages}`, { x: 60, y: 720, size: 16, font });
  }
  return Buffer.from(await doc.save());
}

async function main() {
  rmSync(printedDir, { recursive: true, force: true });
  mkdirSync(printedDir, { recursive: true });
  rmSync(otpFile, { force: true });

  console.log(`\nPhase 1 e2e — API ${API}, kiosk ${KIOSK}\n`);

  // 0. Spawn the simulator agent (connects to /kiosk namespace, waits for OTP file)
  const sim = spawn('python', [
    join(repoRoot, 'agent', 'simulator', 'simulator.py'),
    '--api', API, '--kiosk', KIOSK, '--secret', SECRET,
    '--otp-file', otpFile, '--out', printedDir,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  sim.stdout.on('data', (d) => process.stdout.write(`  [sim] ${d}`));
  sim.stderr.on('data', (d) => process.stdout.write(`  [sim!] ${d}`));

  try {
    check('simulator connects and kiosk shows ONLINE', await waitForKioskOnline());

    // 1. Create job
    const created = await api('/jobs', {
      method: 'POST',
      body: JSON.stringify({ kioskId: KIOSK, fileName: 'test-5page.pdf' }),
    });
    check('POST /jobs returns 201 + upload target', created.status === 201 && created.body.upload?.url, `state=${created.status}`);
    const { jobId, upload } = created.body;
    const token = new URL(upload.url).searchParams.get('token');

    // Security: wrong token must not see the job
    const badToken = await api(`/jobs/${jobId}/status`, { token: 'deadbeef' });
    check('status with wrong token → 404', badToken.status === 404);

    // 2. Upload 5-page PDF
    const pdf = await makeTestPdf(5);
    const put = await fetch(upload.url, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: pdf });
    check('PUT file accepted', put.ok, `status=${put.status}`);

    // 3. Process → page count
    const processed = await api(`/jobs/${jobId}/process`, { method: 'POST', token });
    check('process returns 5 pages', processed.status === 200 && processed.body.pages === 5, JSON.stringify(processed.body).slice(0, 80));

    // 4. Price (2 copies, color, A4 → 5×2×₹8 = ₹80)
    const priced = await api(`/jobs/${jobId}/price`, {
      method: 'POST', token,
      body: JSON.stringify({ mode: 'document', copies: 2, color: true, duplex: false, paperSize: 'A4' }),
    });
    check('price = ₹80 (8000 paise)', priced.status === 200 && priced.body.totalPaise === 8000, `got ${priced.body.totalPaise}`);

    // 5. Mock pay
    const paid = await api(`/jobs/${jobId}/pay`, { method: 'POST', token });
    check('pay → QUEUED', paid.status === 200 && paid.body.state === 'QUEUED');

    // 6. Reveal OTP once, hand it to the simulator via the otp file
    const st1 = await api(`/jobs/${jobId}/status`, { token });
    const otp = st1.body?.otp;
    check('status reveals a 4-digit OTP', typeof otp === 'string' && /^\d{4}$/.test(otp));
    writeFileSync(otpFile, otp);
    const st2 = await api(`/jobs/${jobId}/status`, { token });
    check('OTP revealed exactly once', st2.body?.otp === undefined);

    // 7. Wait for the simulator to claim, download, "print", and complete
    let final;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const { body } = await api(`/jobs/${jobId}/status`, { token });
      final = body;
      if (['COMPLETED', 'FAILED', 'EXPIRED'].includes(body?.state)) break;
      await sleep(1000);
    }
    check('job reaches COMPLETED', final?.state === 'COMPLETED', `state=${final?.state} reason=${final?.failReason}`);
    check('printedAt set', Boolean(final?.printedAt));

    // 8. Hard deletion guarantee
    await sleep(1500); // allow the completion handler's file delete to settle
    const leftovers = existsSync(uploadsDir) ? readdirSync(uploadsDir).filter((f) => f === `${jobId}.bin`) : [];
    check('file deleted from .local/uploads', leftovers.length === 0);

    const printed = existsSync(printedDir) ? readdirSync(printedDir) : [];
    check('PDF appeared in simulator output dir', printed.some((f) => f.startsWith(jobId)), printed.join(', '));
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
