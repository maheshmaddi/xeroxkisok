import { randomBytes } from 'node:crypto';
import type { Job, Payment } from '@prisma/client';
import type { PayIntent, PayProvider, RefundResult } from './payments.types';

/**
 * Mock provider (default in dev / Phase 1): "checkout" resolves instantly —
 * pay() itself performs the capture so the whole pipeline runs without keys.
 */
export class MockPayProvider implements PayProvider {
  readonly mode = 'mock' as const;

  async createOrder(job: Job, _payment: Payment | null): Promise<PayIntent> {
    void _payment;
    return { mode: 'mock', jobId: job.id, state: 'AWAITING_PAYMENT' };
  }

  async refund(payment: Payment): Promise<RefundResult> {
    void payment;
    return { refundId: `rfnd_mock_${randomBytes(8).toString('hex')}`, final: true };
  }

  verifyWebhookSignature(): boolean {
    return false; // mock mode never receives webhooks
  }
}
