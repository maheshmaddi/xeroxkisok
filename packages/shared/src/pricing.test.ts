import { describe, expect, it } from 'vitest';
import { parsePageRange, priceDocument, pricePhoto, pricePrint, rupees } from './pricing';
import type { PricingRates } from './schemas';

const rates: PricingRates = {
  bwA4: 200,
  colorA4: 800,
  bwA3: 400,
  colorA3: 1500,
  photo4x6: 1500,
  passportSheet: 2000,
};

const doc = (over: Partial<Parameters<typeof priceDocument>[0]> = {}) => ({
  mode: 'document' as const,
  copies: 1,
  color: false,
  duplex: false,
  paperSize: 'A4' as const,
  ...over,
});

describe('parsePageRange', () => {
  it('defaults to all pages', () => {
    expect(parsePageRange(undefined, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(parsePageRange('', 5)).toEqual([1, 2, 3, 4, 5]);
    expect(parsePageRange(null, 3)).toEqual([1, 2, 3]);
  });

  it('expands ranges and single pages, dedupes and sorts', () => {
    expect(parsePageRange('1-3,5,2', 5)).toEqual([1, 2, 3, 5]);
    expect(parsePageRange('2', 5)).toEqual([2]);
    expect(parsePageRange('3-3', 5)).toEqual([3]);
  });

  it('rejects out-of-bounds, reversed, and garbage ranges', () => {
    expect(() => parsePageRange('0-2', 5)).toThrow();
    expect(() => parsePageRange('4-2', 5)).toThrow();
    expect(() => parsePageRange('1-9', 5)).toThrow();
    expect(() => parsePageRange('abc', 5)).toThrow();
    expect(() => parsePageRange('1,,2', 5)).toThrow();
  });
});

describe('priceDocument', () => {
  it('prices a simple B&W A4 job per side', () => {
    const r = priceDocument(doc(), 5, rates);
    expect(r.totalPaise).toBe(5 * 200);
    expect(r.sides).toBe(5);
    expect(r.sheets).toBe(5);
  });

  it('prices color A3 with copies', () => {
    const r = priceDocument(doc({ color: true, paperSize: 'A3', copies: 2 }), 5, rates);
    expect(r.totalPaise).toBe(5 * 2 * 1500);
    expect(r.sheets).toBe(10);
  });

  it('duplex halves sheets but keeps sides (per-side pricing)', () => {
    const r = priceDocument(doc({ duplex: true }), 5, rates);
    expect(r.sides).toBe(5);
    expect(r.sheets).toBe(3);
    expect(r.totalPaise).toBe(5 * 200);
  });

  it('prices only the selected page range', () => {
    const r = priceDocument(doc({ pageRange: '1-2,4' }), 5, rates);
    expect(r.totalPaise).toBe(3 * 200);
    expect(r.sheets).toBe(3);
  });

  it('rejects empty documents', () => {
    expect(() => priceDocument(doc(), 0, rates)).toThrow();
  });
});

describe('rupees', () => {
  it('formats paise', () => {
    expect(rupees(8000)).toBe('₹80');
    expect(rupees(2050)).toBe('₹20.50');
  });
});

describe('pricePhoto / pricePrint', () => {
  it('prices a 4x6 photo per sheet', () => {
    const r = pricePhoto({ mode: 'photo4x6', copies: 2 }, rates);
    expect(r.totalPaise).toBe(2 * rates.photo4x6);
    expect(r.sheets).toBe(2);
    expect(r.lines[0].label).toContain('4×6');
  });

  it('prices a passport sheet (8-up) per sheet', () => {
    const r = pricePhoto({ mode: 'passport', copies: 1 }, rates);
    expect(r.totalPaise).toBe(rates.passportSheet);
    expect(r.sheets).toBe(1);
  });

  it('dispatches document vs photo by mode', () => {
    expect(pricePrint({ mode: 'document', copies: 1, color: false, duplex: false, paperSize: 'A4' }, 5, rates).totalPaise).toBe(5 * 200);
    expect(pricePrint({ mode: 'passport', copies: 3 }, 1, rates).totalPaise).toBe(3 * rates.passportSheet);
  });
});
