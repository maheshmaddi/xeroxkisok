import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PAY_PROVIDER } from './payments.constants';
import type { PayProvider } from './payments.types';
import { FileCleanupService } from '../storage/file-cleanup.service';
import { Inject } from '@nestjs/common';

/**
 * Spec §5 rule 2: any PAID/QUEUED/PRINTING job that transitions to FAILED
 * (and EXPIRED jobs per rule 4) must be refunded automatically.
 */
@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAY_PROVIDER) private readonly provider: PayProvider,
    private readonly cleanup: FileCleanupService,
  ) {}

  /** Returns true when the job ended in REFUNDED (or was already refunded). */
  async refundFailedJob(jobId: string, reason: string): Promise<boolean> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId }, include: { payment: true } });
    if (!job) return false;

    if (job.state === 'REFUNDED') return true;
    if (!job.payment) return false; // failed before payment — nothing to refund
    if (job.payment.status !== 'captured') return false;

    try {
      const { refundId, final } = await this.provider.refund(job.payment);
      await this.prisma.payment.update({
        where: { id: job.payment.id },
        data: {
          refundId,
          status: final ? 'refunded' : 'refund_initiated',
        },
      });
      if (final) {
        await this.prisma.job.update({
          where: { id: job.id },
          data: { state: 'REFUNDED', failReason: reason },
        });
        await this.cleanup.purge(job.id, job.fileKey, job.printKey);
        this.logger.log(`Job ${job.id} → REFUNDED (${refundId}, reason: ${reason})`);
        return true;
      }
      // Razorpay path: stay FAILED until the refund.processed webhook lands.
      await this.prisma.job.update({ where: { id: job.id }, data: { state: 'FAILED', failReason: reason } });
      this.logger.log(`Job ${job.id} refund initiated (${refundId}); awaiting refund.processed webhook`);
      return false;
    } catch (err) {
      this.logger.error(`Refund failed for job ${job.id} (will retry on next sweep): ${err}`);
      return false;
    }
  }

  /** Webhook refund.processed → finalize. */
  async markRefundProcessed(paymentId: string, refundId: string): Promise<void> {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId }, include: { job: true } });
    if (!payment || payment.status === 'refunded') return;
    await this.prisma.payment.update({ where: { id: paymentId }, data: { status: 'refunded', refundId } });
    if (payment.job && ['FAILED', 'REFUNDED'].includes(payment.job.state)) {
      await this.prisma.job.update({
        where: { id: payment.job.id },
        data: { state: 'REFUNDED' },
      });
      await this.cleanup.purge(payment.job.id, payment.job.fileKey, payment.job.printKey);
      this.logger.log(`Job ${payment.job.id} refund finalized → REFUNDED`);
    }
  }
}
