import { Injectable, Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE } from './storage.constants';
import type { StorageService } from './storage.types';

/** Single place that deletes stored job files and nulls the fileKey (spec §5 rule 1). */
@Injectable()
export class FileCleanupService {
  private readonly logger = new Logger(FileCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE) private readonly storage: StorageService,
  ) {}

  async purge(jobId: string, fileKey: string | null): Promise<void> {
    if (fileKey) {
      try {
        await this.storage.delete(jobId, fileKey);
      } catch (err) {
        this.logger.error(`Failed deleting file for job ${jobId}: ${err}`);
      }
    }
    await this.prisma.job.updateMany({ where: { id: jobId }, data: { fileKey: null } });
  }
}
