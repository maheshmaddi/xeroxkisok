import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE } from '../storage/storage.constants';
import type { StorageService } from '../storage/storage.types';
import { Inject } from '@nestjs/common';

const UPLOAD_WINDOW_MIN = 60; // spec §5 rule 1
const OTP_EXPIRY_MIN = 30; // spec §5 rule 4

/**
 * Periodic cleanup enforcing the product's hard guarantees:
 *  1. user files never linger — deleted on terminal states or 60 min after upload
 *  2. paid jobs not claimed within the OTP window expire (refund fires in Phase 2)
 */
@Injectable()
export class SweepsService implements OnModuleInit {
  private readonly logger = new Logger(SweepsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE) private readonly storage: StorageService,
  ) {}

  onModuleInit() {
    void this.run(); // sweep once at boot, then on the interval
  }

  @Interval(5 * 60 * 1000)
  async run() {
    await this.sweepExpiredJobs();
    await this.sweepLeftoverFiles();
  }

  /** PAID/QUEUED jobs past their OTP expiry → EXPIRED (+ delete file). */
  private async sweepExpiredJobs() {
    const expired = await this.prisma.job.updateMany({
      where: {
        state: { in: ['PAID', 'QUEUED'] },
        otpExpiresAt: { lt: new Date() },
      },
      data: { state: 'EXPIRED' },
    });
    if (expired.count > 0) {
      // Phase 2: Razorpay refund initiation lands here.
      this.logger.log(`Expired ${expired.count} unclaimed paid job(s)`);
      const files = await this.prisma.job.findMany({
        where: { state: 'EXPIRED', fileKey: { not: null } },
        select: { id: true, fileKey: true },
      });
      for (const job of files) await this.deleteQuietly(job.id, job.fileKey!);
    }
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
      select: { id: true, fileKey: true },
    });
    for (const job of stale) await this.deleteQuietly(job.id, job.fileKey!);
    if (stale.length > 0) this.logger.log(`Swept ${stale.length} stored file(s) past retention`);
  }

  private async deleteQuietly(jobId: string, fileKey: string) {
    try {
      await this.storage.delete(jobId, fileKey);
    } catch (err) {
      this.logger.error(`Sweep: failed deleting file for job ${jobId}: ${err}`);
    }
    await this.prisma.job.updateMany({ where: { id: jobId }, data: { fileKey: null } });
  }
}

// Re-export the constant OTP expiry so tests/dev can align timings if needed.
export const SWEEP_CONSTANTS = { UPLOAD_WINDOW_MIN, OTP_EXPIRY_MIN };
