import { createHmac, timingSafeEqual } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Job, Payment } from '@prisma/client';
import type { PayIntent, PayProvider, RefundResult } from './payments.types';
import { verifyRazorpaySignature } from './webhook-signature.util';

const RZP_API = 'https://api.razorpay.com/v1';

export class RazorpayProviderError extends Error {}

/**
 * Razorpay integration over the REST API (no SDK): UPI-first checkout order
 * creation, webhook signature verification, refunds. Requires sandbox/prod
 * keys in RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET (spec §3, §5).
 */
export class RazorpayProvider implements PayProvider {
  readonly mode = 'razorpay' as const;
  private readonly logger = new Logger(RazorpayProvider.name);

  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly webhookSecret: string,
  ) {}

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const auth = Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64');
    const res = await fetch(`${RZP_API}${path}`, {
      ...init,
      headers: {
        authorization: `Basic ${auth}`,
        'content-type': 'application/json',
        ...init?.headers,
      },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const desc = (body as any)?.error?.description ?? res.statusText;
      this.logger.error(`Razorpay ${path} failed: ${desc}`);
      throw new RazorpayProviderError(`Razorpay call failed: ${desc}`);
    }
    return body as T;
  }

  async createOrder(job: Job, payment: Payment | null): Promise<PayIntent> {
    if (payment?.status === 'created' && payment.razorpayOrderId) {
      return { mode: 'razorpay', jobId: job.id, orderId: payment.razorpayOrderId, keyId: this.keyId, amountPaise: payment.amount };
    }
    const order = await this.call<{ id: string }>('/orders', {
      method: 'POST',
      body: JSON.stringify({
        amount: job.priceTotal,
        currency: 'INR',
        receipt: job.id,
        notes: { jobId: job.id },
      }),
    });
    return { mode: 'razorpay', jobId: job.id, orderId: order.id, keyId: this.keyId, amountPaise: job.priceTotal };
  }

  async refund(payment: Payment): Promise<RefundResult> {
    if (!payment.razorpayPaymentId) throw new RazorpayProviderError('No captured payment id to refund');
    const refund = await this.call<{ id: string }>(`/payments/${payment.razorpayPaymentId}/refund`, {
      method: 'POST',
      body: JSON.stringify({ amount: payment.amount }),
    });
    return { refundId: refund.id, final: false }; // refund.processed webhook finalizes
  }

  verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean {
    return verifyRazorpaySignature(rawBody, signature, this.webhookSecret);
  }
}
