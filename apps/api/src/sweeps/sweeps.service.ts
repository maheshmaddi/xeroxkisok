import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE } from '../storage/storage.constants';
import type { StorageService } from '../storage/storage.types';
import { FileCleanupService } from '../storage/file-cleanup.service';
import { RefundsService } from '../payments/refunds.service';
import { AlertsService } from '../alerts/alerts.service';

const UPLOAD_WINDOW_MIN = 60; // spec §5 rule 1
const SWEEP_INTERVAL_SEC = Number(process.env.SWEEP_INTERVAL_SEC ?? 300);

/**
 * Periodic cleanup enforcing the product's hard guarantees:
 *  1. user files never linger — deleted on terminal states or 60 min after upload
 *  2. paid jobs not claimed within the OTP window expire → auto-refund (spec §5 rules 2+4)
 */
@Injectable()
export class SweepsService implements OnModuleInit {
  private readonly logger = new Logger(SweepsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE) private readonly storage: StorageService,
    private readonly cleanup: FileCleanupService,
    private readonly refunds: RefundsService,
    private readonly alerts: AlertsService,
  ) {}

  onModuleInit() {
    void this.run(); // sweep once at boot, then on the interval
  }

  @Interval(SWEEP_INTERVAL_SEC * 1000)
  async run() {
    await this.sweepExpiredJobs();
    await this.sweepLeftoverFiles();
    await this.alerts.evaluate(); // spec §8 alert thresholds ride the sweep cadence
  }

  /** Daily 9 PM revenue summary (spec §8). */
  @Cron('0 21 * * *')
  async daily() {
    await this.alerts.dailySummary();
  }

  /** PAID/QUEUED jobs past their OTP expiry → refund (REFUNDED, or EXPIRED/FAILED awaiting the refund webhook). */
  private async sweepExpiredJobs() {
    const stale = await this.prisma.job.findMany({
      where: {
        state: { in: ['PAID', 'QUEUED'] },
        otpExpiresAt: { lt: new Date() },
      },
      select: { id: true },
    });
    for (const job of stale) {
      const refunded = await this.refunds.refundFailedJob(job.id, 'OTP_EXPIRED');
      if (!refunded) {
        // refund couldn't start (or webhook pending) — keep an inspectable terminal-ish state
        await this.prisma.job.update({ where: { id: job.id }, data: { state: 'EXPIRED', failReason: 'OTP_EXPIRED' } });
        const full = await this.prisma.job.findUnique({ where: { id: job.id }, select: { fileKey: true, printKey: true } });
        await this.cleanup.purge(job.id, full?.fileKey ?? null, full?.printKey ?? null);
      }
    }
    if (stale.length > 0) this.logger.log(`Expiry sweep processed ${stale.length} unclaimed paid job(s)`);
  }

  /** Files whose job reached a terminal state, or outlived the upload window. */
  private async sweepLeftoverFiles() {
    const cutoff = new Date(Date.now() - UPLOAD_WINDOW_MIN * 60 * 1000);
    const stale = await this.prisma.job.findMany({
      where: {
        fileKey: { not: null },
        OR: [
          { state: { in: ['COMPLETED', 'FAILED', 'EXPIRED', 'REFUNDED'] } },
          { createdAt: { lt: cutoff } },
        ],
      },
      select: { id: true, fileKey: true, printKey: true },
    });
    for (const job of stale) await this.cleanup.purge(job.id, job.fileKey!, job.printKey);
    if (stale.length > 0) this.logger.log(`Swept ${stale.length} stored file(s) past retention`);
  }
}
