import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';

/** 4x6 media at 300 DPI (spec §10 Phase 4). */
const DPI = 300;
const W_PORTRAIT = 4 * DPI; // 1200
const H_PORTRAIT = 6 * DPI; // 1800
const W_LANDSCAPE = H_PORTRAIT; // 1800
const H_LANDSCAPE = W_PORTRAIT; // 1200

// Passport photo 35×45mm at 300 DPI.
const PASSPORT_W = Math.round((35 / 25.4) * DPI); // 413
const PASSPORT_H = Math.round((45 / 25.4) * DPI); // 531
/** 8 copies of 35×45mm only fit on a 4×6 sheet in LANDSCAPE: 4 cols × 2 rows. */
const PASSPORT_COLS = 4;
const PASSPORT_ROWS = 2;

export class CropOutOfBoundsError extends Error {}

interface Crop {
  zoom: number;
  offsetX: number;
  offsetY: number;
}

/** Extract the source window for a 2:3 (4x6 portrait) crop with zoom/pan. */
function cropWindow(width: number, height: number, crop: Crop | null | undefined) {
  const targetAR = W_PORTRAIT / H_PORTRAIT; // 2:3
  let cw: number, ch: number; // largest 2:3 rect covering the image
  if (width / height > targetAR) {
    ch = height;
    cw = ch * targetAR;
  } else {
    cw = width;
    ch = cw / targetAR;
  }
  const zoom = crop?.zoom ?? 1;
  const winW = Math.max(1, Math.floor(Math.min(width, cw / zoom)));
  const winH = Math.max(1, Math.floor(Math.min(height, ch / zoom)));
  const slackX = width - winW;
  const slackY = height - winH;
  const norm = (v: number | undefined, dflt: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : dflt;
  return {
    left: Math.round(slackX * norm(crop?.offsetX, slackX > 0 ? 0.5 : 0)),
    top: Math.round(slackY * norm(crop?.offsetY, slackY > 0 ? 0.35 : 0)), // slight head bias
    width: winW,
    height: winH,
  };
}

/** 4×6 portrait print-ready PNG with the user's zoom/pan crop applied. */
export async function renderPhoto4x6Png(buf: Buffer, crop: Crop | null | undefined): Promise<Buffer> {
  const meta = await sharp(buf).rotate().metadata();
  if (!meta.width || !meta.height) throw new Error('unreadable image');
  const win = cropWindow(meta.width, meta.height, crop);
  return sharp(buf)
    .rotate()
    .extract(win)
    .resize(W_PORTRAIT, H_PORTRAIT, { fit: 'cover' })
    .png()
    .toBuffer();
}

/** Landscape 4×6 PNG with a 4×2 grid of 35×45mm passport photos, white borders. */
export async function renderPassportSheetPng(buf: Buffer): Promise<Buffer> {
  const cells = await Promise.all(
    Array.from({ length: PASSPORT_COLS * PASSPORT_ROWS }, () =>
      sharp(buf)
        .rotate()
        .resize(PASSPORT_W, PASSPORT_H, { fit: 'cover', position: sharp.strategy.attention })
        .png()
        .toBuffer(),
    ),
  );

  const gutterX = Math.floor((W_LANDSCAPE - PASSPORT_COLS * PASSPORT_W) / (PASSPORT_COLS + 1));
  const gutterY = Math.floor((H_LANDSCAPE - PASSPORT_ROWS * PASSPORT_H) / (PASSPORT_ROWS + 1));

  const composites = cells.map((input, i) => {
    const col = i % PASSPORT_COLS;
    const row = Math.floor(i / PASSPORT_COLS);
    return {
      input,
      left: gutterX + col * (PASSPORT_W + gutterX),
      top: gutterY + row * (PASSPORT_H + gutterY),
    };
  });

  return sharp({
    create: {
      width: W_LANDSCAPE,
      height: H_LANDSCAPE,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();
}

/** Wrap a full-bleed PNG in a one-page PDF at the given 4x6 orientation (72dpi points). */
export async function pngToPdf4x6(png: Buffer, orientation: 'portrait' | 'landscape'): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page =
    orientation === 'portrait' ? doc.addPage([4 * 72, 6 * 72]) : doc.addPage([6 * 72, 4 * 72]);
  const embedded = await doc.embedPng(png);
  page.drawImage(embedded, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  return Buffer.from(await doc.save());
}

/** The print artifact the kiosk prints for photo jobs (PDF, one 4x6 page). */
export async function composePhotoArtifact(
  buf: Buffer,
  settings: { mode: 'photo4x6' | 'passport'; crop?: Crop | null },
): Promise<Buffer> {
  if (settings.mode === 'photo4x6') {
    return pngToPdf4x6(await renderPhoto4x6Png(buf, settings.crop), 'portrait');
  }
  return pngToPdf4x6(await renderPassportSheetPng(buf), 'landscape');
}
