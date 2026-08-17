import { Controller, Get, NotFoundException, Param, Query, Res, StreamableFile, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE } from '../storage/storage.constants';
import type { StorageService } from '../storage/storage.types';
import { verifyFileToken } from '../storage/signed-token.util';
import { ConfigService } from '@nestjs/config';
import { Inject } from '@nestjs/common';

/** Kiosk agent file download (dev stand-in for a presigned R2 GET, 10-min token). */
@Controller('files')
export class FilesController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE) private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {}

  @Get(':jobId')
  async download(
    @Param('jobId') jobId: string,
    @Query('token') token: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const secret = this.config.get<string>('JWT_SECRET') ?? 'dev-jwt-secret-change-me';
    if (!verifyFileToken(jobId, token, secret)) {
      throw new UnauthorizedException('File link invalid or expired');
    }
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job?.fileKey) throw new NotFoundException('File no longer available');
    const buf = await this.storage.read(jobId, job.fileKey);
    res.set({
      'Content-Type': job.fileType === 'pdf' ? 'application/pdf' : 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${job.fileName.replace(/"/g, '')}"`,
    });
    return new StreamableFile(buf);
  }
}
