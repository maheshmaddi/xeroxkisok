import { createHmac, timingSafeEqual } from 'node:crypto';

/** Razorpay webhook signatures: HMAC-SHA256 of the raw body with the webhook secret. */
export function verifyRazorpaySignature(rawBody: string, signature: string | undefined, webhookSecret: string): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
