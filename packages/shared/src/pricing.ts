import type { DocumentSettings, PhotoSettings, PriceResult, PricingRates } from './schemas';

/** Expand a "1-3,7" style range against the document's total page count. */
export function parsePageRange(range: string | null | undefined, totalPages: number): number[] {
  if (range === undefined || range === null || range.trim() === '') {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const pages = new Set<number>();
  for (const part of range.split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) throw new Error(`Invalid page range near "${part.trim()}"`);
    const from = parseInt(m[1], 10);
    const to = m[2] ? parseInt(m[2], 10) : from;
    if (from < 1 || to < from || to > totalPages) {
      throw new Error(`Page range "${part.trim()}" is outside 1..${totalPages}`);
    }
    for (let p = from; p <= to; p++) pages.add(p);
  }
  const list = [...pages].sort((a, b) => a - b);
  if (list.length === 0) throw new Error('Page range selects no pages');
  return list;
}

/**
 * Document pricing. Rates are per printed side (spec §4 PricingProfile),
 * so duplex reduces sheets but not sides.
 */
export function priceDocument(
  settings: DocumentSettings,
  totalPages: number,
  rates: PricingRates,
): PriceResult {
  if (totalPages < 1) throw new Error('Cannot price a document with no pages');
  const selected = parsePageRange(settings.pageRange, totalPages);
  const rate =
    settings.paperSize === 'A3'
      ? settings.color
        ? rates.colorA3
        : rates.bwA3
      : settings.color
        ? rates.colorA4
        : rates.bwA4;
  const sides = selected.length * settings.copies;
  const sheetsPerCopy = settings.duplex ? Math.ceil(selected.length / 2) : selected.length;
  const sheets = sheetsPerCopy * settings.copies;
  const totalPaise = rate * sides;
  return {
    totalPaise,
    sides,
    sheets,
    lines: [
      {
        label: `${settings.color ? 'Color' : 'B&W'} ${settings.paperSize} · ${selected.length} page${selected.length > 1 ? 's' : ''} × ${settings.copies} cop${settings.copies > 1 ? 'ies' : 'y'}${settings.duplex ? ' · duplex' : ''}`,
        qty: sides,
        unitPaise: rate,
        totalPaise,
      },
    ],
  };
}

export function rupees(paise: number): string {
  const whole = paise % 100 === 0;
  return `₹${(paise / 100).toFixed(whole ? 0 : 2)}`;
}

/** Photo modes price per finished sheet (4x6 print or 8-up passport sheet). */
export function pricePhoto(settings: PhotoSettings, rates: PricingRates): PriceResult {
  const rate = settings.mode === 'photo4x6' ? rates.photo4x6 : rates.passportSheet;
  const label =
    settings.mode === 'photo4x6'
      ? `4×6 photo print × ${settings.copies}`
      : `Passport sheet — 8 photos of 35×45mm × ${settings.copies}`;
  const totalPaise = rate * settings.copies;
  return {
    totalPaise,
    sides: settings.copies,
    sheets: settings.copies,
    lines: [{ label, qty: settings.copies, unitPaise: rate, totalPaise }],
  };
}

/** Dispatch pricing for any print mode (spec §5: computed server-side only). */
export function pricePrint(
  settings: DocumentSettings | PhotoSettings,
  totalPages: number,
  rates: PricingRates,
): PriceResult {
  return settings.mode === 'document'
    ? priceDocument(settings, totalPages, rates)
    : pricePhoto(settings, rates);
}
