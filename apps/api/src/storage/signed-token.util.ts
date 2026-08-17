import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal HMAC-signed, expiring tokens for kiosk file downloads
 * (stand-in for S3 presigned URLs in local dev). Format: `<expMs>.<hexsig>`.
 */
export function signFileToken(jobId: string, ttlMs: number, secret: string): string {
  const exp = Date.now() + ttlMs;
  const sig = createHmac('sha256', secret).update(`${jobId}.${exp}`).digest('hex');
  return `${exp}.${sig}`;
}

export function verifyFileToken(jobId: string, token: string | undefined, secret: string): boolean {
  if (!token) return false;
  const [expStr, sig] = token.split('.');
  const exp = Number(expStr);
  if (!Number.isInteger(exp) || Date.now() > exp || !sig) return false;
  const expected = createHmac('sha256', secret).update(`${jobId}.${exp}`).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
