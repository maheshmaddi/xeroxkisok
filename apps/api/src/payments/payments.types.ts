import type { Job, Payment } from '@prisma/client';

/** What POST /jobs/:id/pay hands the client to complete payment. */
export type PayIntent =
  | { mode: 'mock'; jobId: string; state: string }
  | { mode: 'razorpay'; jobId: string; orderId: string; keyId: string; amountPaise: number };

export interface RefundResult {
  refundId: string;
  /** true when the refund is final without waiting for a webhook. */
  final: boolean;
}

export interface PayProvider {
  readonly mode: 'mock' | 'razorpay';

  /** Create (or reuse) an order for a job awaiting payment. */
  createOrder(job: Job, payment: Payment | null): Promise<PayIntent>;

  /** Initiate a full refund of a captured payment. */
  refund(payment: Payment): Promise<RefundResult>;

  /** Razorpay webhook signature check (mock provider never receives any). */
  verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean;
}
