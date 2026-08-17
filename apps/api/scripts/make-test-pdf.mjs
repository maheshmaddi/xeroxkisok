// Generates a simple N-page test PDF at <repo>/.local/test-5page.pdf
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pages = Number(process.argv[2] ?? 5);
if (!Number.isInteger(pages) || pages < 1) {
  console.error('Usage: node make-test-pdf.mjs [pages]');
  process.exit(1);
}

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
for (let i = 1; i <= pages; i++) {
  const page = doc.addPage([595.28, 841.89]); // A4 @ 72dpi
  page.drawText(`Print Kiosk — test PDF`, { x: 60, y: 760, size: 28, font, color: rgb(0.1, 0.1, 0.12) });
  page.drawText(`Page ${i} of ${pages}`, { x: 60, y: 720, size: 16, font });
  page.drawText(new Date().toISOString(), { x: 60, y: 690, size: 10, font, color: rgb(0.4, 0.4, 0.4) });
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.local');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `test-${pages}page.pdf`);
writeFileSync(out, await doc.save());
console.log(`Wrote ${out} (${pages} pages)`);
