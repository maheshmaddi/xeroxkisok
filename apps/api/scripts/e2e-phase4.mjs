/**
 * Phase 4 acceptance test (spec §10): photo upload → passport sheet correctly
 * laid out and printed; 4x6 crop pricing; DOCX handled (converted when
 * LibreOffice present, clear message when not).
 *
 * Prereqs: API running. Spawns the simulator itself.
 * Usage: node apps/api/scripts/e2e-phase4.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

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
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

async function makePhotoJpg() {
  // 1600×2000 "selfie": warm gradient with a face-ish ellipse so attention crop has something.
  const svg = `<svg width="1600" height="2000" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fbbf24"/><stop offset="1" stop-color="#7c3aed"/>
    </linearGradient></defs>
    <rect width="1600" height="2000" fill="url(#g)"/>
    <ellipse cx="800" cy="820" rx="330" ry="420" fill="#fde3c8"/>
    <circle cx="690" cy="760" r="34" fill="#1f2937"/><circle cx="910" cy="760" r="34" fill="#1f2937"/>
    <path d="M 660 1000 Q 800 1120 940 1000" stroke="#92400e" stroke-width="40" fill="none" stroke-linecap="round"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

async function driveToPriced(fileName, fileBuf, contentType) {
  const created = await api('/jobs', { method: 'POST', body: JSON.stringify({ kioskId: 'K001', fileName }) });
  const jobId = created.body.jobId;
  const token = new URL(created.body.upload.url).searchParams.get('token');
  await fetch(created.body.upload.url, { method: 'PUT', headers: { 'content-type': contentType }, body: fileBuf });
  const processed = await api(`/jobs/${jobId}/process`, { method: 'POST', token });
  return { jobId, token, processed };
}

async function waitForKioskOnline(timeoutMs = 30_000) {
  spawn('node', ['-e', `
    const { PrismaClient } = require('@prisma/client');
    const p = new PrismaClient();
    p.kiosk.update({ where: { id: 'K001' }, data: { status: 'OFFLINE' } })
      .then(() => p.$disconnect()).catch(() => {});
  `], { cwd: join(repoRoot, 'apps', 'api'), stdio: 'ignore' });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await api('/kiosks/K001/info');
    if (body?.status === 'ONLINE') return true;
    await sleep(500);
  }
  return false;
}

async function main() {
  console.log(`\nPhase 4 e2e — ${API}\n`);
  const printedDir = mkdtempSync(join(tmpdir(), 'pk4-printed-'));
  const otpFile = join(tmpdir(), `pk4-otp-${Date.now()}.txt`);
  const sim = spawn('python', [
    join(repoRoot, 'agent', 'simulator', 'simulator.py'),
    '--api', API, '--kiosk', 'K001', '--secret', 'dev-secret-001',
    '--otp-file', otpFile, '--out', printedDir,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  sim.stdout.on('data', (d) => process.stdout.write(`  [sim] ${d}`));
  sim.stderr.on('data', (d) => process.stdout.write(`  [sim!] ${d}`));

  try {
    check('simulator online', await waitForKioskOnline());
    const photo = await makePhotoJpg();

    // --- 1. Passport sheet end-to-end (spec acceptance: correctly laid-out sheet printed) ---
    {
      const { jobId, token, processed } = await driveToPriced('selfie.jpg', photo, 'image/jpeg');
      check('photo processes to 1 page', processed.status === 200 && processed.body.pages === 1);

      const priced = await api(`/jobs/${jobId}/price`, {
        method: 'POST', token,
        body: JSON.stringify({ mode: 'passport', copies: 1 }),
      });
      check('passport sheet priced ₹20', priced.status === 200 && priced.body.totalPaise === 2000, `paise=${priced.body.totalPaise}`);
      check('passport line item mentions 8 photos', /8 photos/.test(priced.body?.lines?.[0]?.label ?? ''), priced.body?.lines?.[0]?.label);

      await api(`/jobs/${jobId}/pay`, { method: 'POST', token });
      const st = await api(`/jobs/${jobId}/status`, { token });
      writeFileSync(otpFile, st.body.otp);

      const deadline = Date.now() + 90_000;
      let final;
      while (Date.now() < deadline) {
        const { body } = await api(`/jobs/${jobId}/status`, { token });
        final = body;
        if (['COMPLETED', 'FAILED', 'REFUNDED'].includes(body?.state)) break;
        await sleep(1000);
      }
      check('passport job COMPLETED', final?.state === 'COMPLETED', `state=${final?.state}`);

      const printed = readdirSync(printedDir).find((f) => f.startsWith(jobId));
      check('artifact printed', Boolean(printed), printed ?? 'missing');
      if (printed) {
        const artifact = await sharp(join(printedDir, printed)).metadata().catch(() => null);
        // Simulator saves the downloaded PDF; sharp can't read PDFs — verify via magic bytes + size.
        const { readFile } = await import('node:fs/promises');
        const bytes = await readFile(join(printedDir, printed));
        check('artifact is a PDF', bytes.subarray(0, 5).toString() === '%PDF-', bytes.subarray(0, 5).toString());
        check('artifact is substantial (composed 300dpi sheet)', bytes.length > 20_000, `${bytes.length} bytes`);
      }
      const uploads = readdirSync(join(repoRoot, '.local', 'uploads'));
      check('original + artifact deleted', uploads.length === 0, uploads.join(', '));
    }

    // --- 2. 4x6 photo with crop: priced correctly, artifact generated ---
    {
      const { jobId, token } = await driveToPriced('portrait.jpg', photo, 'image/jpeg');
      const priced = await api(`/jobs/${jobId}/price`, {
        method: 'POST', token,
        body: JSON.stringify({ mode: 'photo4x6', copies: 2, crop: { zoom: 1.6, offsetX: 0.5, offsetY: 0.4 } }),
      });
      check('4x6 crop priced 2×₹15', priced.status === 200 && priced.body.totalPaise === 3000, `paise=${priced.body.totalPaise}`);

      // Reject photo settings for PDF uploads (mode guard)
      const pdfJob = await api('/jobs', { method: 'POST', body: JSON.stringify({ kioskId: 'K001', fileName: 'x.pdf' }) });
      const pdfToken = new URL(pdfJob.body.upload.url).searchParams.get('token');
      const { PDFDocument } = await import('pdf-lib');
      const doc = await PDFDocument.create();
      doc.addPage([595, 842]);
      await fetch(pdfJob.body.upload.url, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: Buffer.from(await doc.save()) });
      await api(`/jobs/${pdfJob.body.jobId}/process`, { method: 'POST', token: pdfToken });
      const badMode = await api(`/jobs/${pdfJob.body.jobId}/price`, {
        method: 'POST', token: pdfToken,
        body: JSON.stringify({ mode: 'passport', copies: 1 }),
      });
      check('photo mode rejected for PDFs', badMode.status === 400, `status=${badMode.status}`);
    }

    // --- 3. DOCX: converted when LibreOffice available, clear message otherwise ---
    {
      // Minimal .docx (a valid zip with [Content_Types].xml — enough for the soffice branch decision)
      const { zipSync, strToU8 } = await import('fflate');
      const docx = zipSync({
        '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
      });
      const { jobId, token, processed } = await driveToPriced('notes.docx', Buffer.from(docx), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      if (processed.status === 200) {
        check('DOCX converted when LibreOffice present', processed.body.pages >= 1, `pages=${processed.body.pages}`);
      } else {
        check('DOCX gives a clear unavailable message', processed.status === 400 && /not available/i.test(processed.body?.message ?? ''), processed.body?.message);
      }
      console.log(`  (docx process → status ${processed.status}: ${processed.body?.message ?? processed.body?.pages})`);
    }

    // --- 4. Verify composed artifact geometry directly (passport grid on landscape 4x6) ---
    {
      const verify = spawnSyncTs('scripts/verify-artifacts.ts');
      const geo = JSON.parse(verify || '{}');
      check('passport sheet is 1800×1200 (landscape 4x6 @300dpi)', geo.sheet?.width === 1800 && geo.sheet?.height === 1200, JSON.stringify(geo.sheet));
      check('4x6 print is 1200×1800 (portrait @300dpi)', geo.single?.width === 1200 && geo.single?.height === 1800, JSON.stringify(geo.single));
      check('sheet gutters are white (grid borders)', (geo.cornerMeans ?? []).every((m) => m >= 245) && (geo.midGutterMeans ?? []).every((m) => m >= 245), `corner=${JSON.stringify(geo.cornerMeans)} mid=${JSON.stringify(geo.midGutterMeans)}`);
      check('cells contain photo content', (geo.inCellMeans ?? []).some((m, i) => Math.abs(m - (geo.cornerMeans ?? [])[i]) > 8), `inCell=${JSON.stringify(geo.inCellMeans)}`);
    }
  } finally {
    sim.kill();
  }

  console.log(failed.length === 0 ? '\nALL CHECKS PASSED ✅\n' : `\n${failed.length} CHECK(S) FAILED ❌ — ${failed.join(', ')}\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

function spawnSyncTs(scriptPath) {
  try {
    return execFileSync(
      process.execPath,
      [join(repoRoot, 'apps', 'api', 'node_modules', 'ts-node', 'dist', 'bin.js'), '--transpile-only', scriptPath],
      { cwd: join(repoRoot, 'apps', 'api'), encoding: 'utf8' },
    );
  } catch (err) {
    console.log(`  (artifact checker failed: ${err?.stderr ?? err})`);
    return '';
  }
}

main().catch((err) => {
  console.error('e2e crashed:', err);
  process.exit(1);
});
