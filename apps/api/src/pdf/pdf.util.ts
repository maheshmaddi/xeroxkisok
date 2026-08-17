import { execFile, spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface PdfDocument {
  numPages: number;
  destroy: () => Promise<void>;
}

interface PdfjsModule {
  getDocument: (src: Record<string, unknown>) => { promise: Promise<PdfDocument> };
}

let pdfjsPromise: Promise<PdfjsModule> | null = null;

// ESM-only in pdfjs-dist v4; loaded lazily so the API boots without it.
function loadPdfjs(): Promise<PdfjsModule> {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<PdfjsModule>;
  return pdfjsPromise;
}

export class PasswordProtectedPdfError extends Error {
  constructor() {
    super('password-protected PDF');
  }
}

export class CorruptPdfError extends Error {
  constructor() {
    super('unreadable PDF');
  }
}

/** Page count via pdfjs (pure JS — no native deps, works everywhere). */
export async function inspectPdf(buf: Buffer): Promise<number> {
  const pdfjs = await loadPdfjs();
  let doc: PdfDocument;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buf), // copy: pdfjs may detach the buffer
      isEvalSupported: false,
      useSystemFonts: false,
      verbosity: 0,
    }).promise;
  } catch (err: any) {
    if (err?.name === 'PasswordException') throw new PasswordProtectedPdfError();
    throw new CorruptPdfError();
  }
  try {
    return doc.numPages;
  } finally {
    await doc.destroy();
  }
}

let pdftoppmAvailable: boolean | null = null;

function hasPdftoppm(): boolean {
  if (pdftoppmAvailable === null) {
    const probe = spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' });
    pdftoppmAvailable = probe.error === undefined;
  }
  return pdftoppmAvailable;
}

/**
 * Up to 3 first-page thumbnails as data URLs, via poppler's pdftoppm.
 * Returns [] when poppler isn't installed (local dev on Windows etc.);
 * the production container ships poppler per spec §3.
 */
export async function renderPdfPreviews(buf: Buffer, jobId: string): Promise<string[]> {
  if (!hasPdftoppm()) return [];
  const dir = join(tmpdir(), `pk-preview-${jobId}`);
  try {
    await mkdir(dir, { recursive: true });
    const pdfPath = join(dir, 'doc.pdf');
    await writeFile(pdfPath, buf);
    await execFileAsync('pdftoppm', ['-png', '-l', '3', '-scale-to', '360', pdfPath, join(dir, 'p')]);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.png')).sort();
    const pngs = await Promise.all(files.map((f) => readFile(join(dir, f))));
    return pngs.map((b) => `data:image/png;base64,${b.toString('base64')}`);
  } catch {
    return []; // preview generation is best-effort; never fail the job over it
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
