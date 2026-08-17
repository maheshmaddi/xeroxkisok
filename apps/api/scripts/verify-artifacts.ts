/** Phase 4 geometry checks for composed photo artifacts (run via ts-node). */
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { renderPassportSheetPng, renderPhoto4x6Png } from '../src/images/image.util';

async function main() {
  mkdirSync('.local', { recursive: true });
  // A warm gradient "selfie" with a face-ish region for attention cropping.
  const svg = `<svg width="1600" height="2000" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fbbf24"/><stop offset="1" stop-color="#7c3aed"/>
    </linearGradient></defs>
    <rect width="1600" height="2000" fill="url(#g)"/>
    <ellipse cx="800" cy="820" rx="330" ry="420" fill="#fde3c8"/>
  </svg>`;
  const photo = await sharp(Buffer.from(svg)).jpeg().toBuffer();

  const sheet = await renderPassportSheetPng(photo);
  const sheetMeta = await sharp(sheet).metadata();

  const single = await renderPhoto4x6Png(photo, { zoom: 2, offsetX: 0.5, offsetY: 0.5 });
  const singleMeta = await sharp(single).metadata();

  // NB: sharp .stats() reads the INPUT, ignoring .extract() — materialize first.
  const region = async (buf: Buffer, left: number, top: number, size = 24) => {
    const cropped = await sharp(buf).extract({ left, top, width: size, height: size }).png().toBuffer();
    const st = await sharp(cropped).stats();
    return st.channels.slice(0, 3).map((c) => Math.round(c.mean));
  };

  // Gutters: passport layout starts at x=29,y=46 (413×531 cells, 29/46px gutters).
  const corner = await region(sheet, 0, 0);
  const midGutter = await region(sheet, 900, 0);
  const inCell = await region(sheet, 200, 300);

  console.log(
    JSON.stringify({
      sheet: { width: sheetMeta.width, height: sheetMeta.height },
      single: { width: singleMeta.width, height: singleMeta.height },
      cornerMeans: corner,
      midGutterMeans: midGutter,
      inCellMeans: inCell,
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
