import { createHmac, timingSafeEqual } from 'node:crypto';

/** Signed session cookie for the single OWNER admin (spec §3 auth row). */
export const ADMIN_COOKIE = 'pk_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function createSessionToken(email: string, secret: string): string {
  const exp = Date.now() + SESSION_TTL_MS;
  const sig = createHmac('sha256', secret).update(`admin:${email}:${exp}`).digest('hex');
  return `${exp}.${sig}`;
}

export function verifySessionToken(token: string | undefined, email: string, secret: string): boolean {
  if (!token) return false;
  const [expStr, sig] = token.split('.');
  const exp = Number(expStr);
  if (!Number.isInteger(exp) || Date.now() > exp || !sig) return false;
  const expected = createHmac('sha256', secret).update(`admin:${email}:${exp}`).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Minimal cookie reader (avoids the cookie-parser dependency). */
export function readCookie(req: { headers: { cookie?: string } }, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}
