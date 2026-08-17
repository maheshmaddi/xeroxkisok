import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class LibreOfficeUnavailableError extends Error {
  constructor() {
    super('LibreOffice not installed');
  }
}

export class DocxConversionError extends Error {}

let sofficeAvailable: boolean | null = null;

export function hasSoffice(): boolean {
  if (sofficeAvailable === null) {
    const probe = spawnSync('soffice', ['--version'], { stdio: 'ignore' });
    sofficeAvailable = probe.error === undefined;
  }
  return sofficeAvailable;
}

/** DOCX → PDF via LibreOffice headless (spec §3; native binary locally, worker container in prod). */
export async function convertDocxToPdf(buf: Buffer, fileName: string): Promise<Buffer> {
  if (!hasSoffice()) throw new LibreOfficeUnavailableError();
  const dir = await mkdtemp(join(tmpdir(), 'pk-docx-'));
  try {
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.(docx|doc)$/i, '');
    const inPath = join(dir, `${safeName}.docx`);
    await writeFile(inPath, buf);
    await execFileAsync('soffice', [
      '--headless',
      '--norestore',
      '--convert-to',
      'pdf',
      '--outdir',
      dir,
      inPath,
    ]);
    const pdfs = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.pdf'));
    if (pdfs.length === 0) throw new DocxConversionError('no PDF produced');
    return readFile(join(dir, pdfs[0]));
  } catch (err) {
    if (err instanceof LibreOfficeUnavailableError) throw err;
    throw new DocxConversionError(err instanceof Error ? err.message : String(err));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
