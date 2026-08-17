import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE } from '../storage/storage.constants';
import type { StorageService } from '../storage/storage.types';
import { Inject } from '@nestjs/common';

const OTP_MAX_ATTEMPTS = 5;

/**
 * Socket.IO namespace `/kiosk` — the kiosk agents' outbound WSS channel
 * (spec §5). Auth is per-kiosk: { kioskId, secret } in the handshake.
 */
@WebSocketGateway({ namespace: '/kiosk', cors: { origin: '*' } })
export class KioskGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(KioskGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE) private readonly storage: StorageService,
  ) {}

  async handleConnection(client: Socket) {
    const { kioskId, secret } = (client.handshake.auth ?? {}) as { kioskId?: string; secret?: string };
    const kiosk = kioskId ? await this.prisma.kiosk.findUnique({ where: { id: kioskId } }) : null;
    if (!kiosk || typeof secret !== 'string' || !bcrypt.compareSync(secret, kiosk.secretKey)) {
      this.logger.warn(`Rejected kiosk socket auth for "${kioskId ?? '?'}"`);
      client.disconnect(true);
      return;
    }
    client.data.kioskId = kiosk.id;
    await client.join(kiosk.id);
    await this.prisma.kiosk.update({ where: { id: kiosk.id }, data: { status: 'ONLINE', lastSeenAt: new Date() } });
    this.logger.log(`Kiosk ${kiosk.id} connected (${client.id})`);
  }

  async handleDisconnect(client: Socket) {
    const kioskId = client.data?.kioskId as string | undefined;
    if (!kioskId) return;
    this.logger.log(`Kiosk ${kioskId} socket closed (${client.id})`);
    // Only mark OFFLINE once no other socket for this kiosk remains.
    setTimeout(async () => {
      try {
        const sockets = await this.server.in(kioskId).fetchSockets();
        if (sockets.length === 0) {
          await this.prisma.kiosk.update({ where: { id: kioskId }, data: { status: 'OFFLINE' } });
          this.logger.log(`Kiosk ${kioskId} is OFFLINE`);
        }
      } catch {
        /* server shutting down */
      }
    }, 2000);
  }

  /** Push a paid job to the kiosk that must print it. */
  emitJobQueued(kioskId: string, job: { id: string; fileName: string; fileType: string; pages: number; settings: string | null; priceTotal: number }) {
    this.server.to(kioskId).emit('job:queued', {
      jobId: job.id,
      fileName: job.fileName,
      fileType: job.fileType,
      pages: job.pages,
      settings: job.settings ? JSON.parse(job.settings) : null,
      priceTotal: job.priceTotal,
    });
  }

  @SubscribeMessage('job:claim')
  async onClaim(@ConnectedSocket() client: Socket, @MessageBody() body: { jobId?: string; otp?: string }) {
    const kioskId = client.data?.kioskId as string | undefined;
    const job = body?.jobId
      ? await this.prisma.job.findUnique({ where: { id: body.jobId }, include: { kiosk: true } })
      : null;

    if (!job || !kioskId || job.kioskId !== kioskId) return { ok: false, error: 'NOT_FOUND' };
    if (job.otpAttempts >= OTP_MAX_ATTEMPTS) return { ok: false, jobId: job.id, error: 'LOCKED' };
    if (job.state !== 'QUEUED') return { ok: false, jobId: job.id, error: 'NOT_CLAIMABLE' };
    if (!job.otpHash || !job.otpExpiresAt || job.otpExpiresAt < new Date()) {
      return { ok: false, jobId: job.id, error: 'OTP_EXPIRED' };
    }

    const otpOk = typeof body.otp === 'string' && bcrypt.compareSync(body.otp, job.otpHash);
    if (!otpOk) {
      const attempts = job.otpAttempts + 1;
      await this.prisma.job.update({ where: { id: job.id }, data: { otpAttempts: attempts } });
      this.logger.warn(`Kiosk ${kioskId}: bad OTP for job ${job.id} (attempt ${attempts}/${OTP_MAX_ATTEMPTS})`);
      return { ok: false, jobId: job.id, error: attempts >= OTP_MAX_ATTEMPTS ? 'LOCKED' : 'BAD_OTP' };
    }

    // Single-use: clear the hash and move to PRINTING before handing out the file.
    await this.prisma.job.update({ where: { id: job.id }, data: { state: 'PRINTING', otpHash: null } });
    const fileUrl = job.fileKey ? await this.storage.downloadUrl(job.id, job.fileKey) : null;
    if (!fileUrl) return { ok: false, jobId: job.id, error: 'FILE_GONE' };

    this.logger.log(`Kiosk ${kioskId} claimed job ${job.id} → PRINTING`);
    return {
      ok: true,
      jobId: job.id,
      fileUrl,
      fileName: job.fileName,
      fileType: job.fileType,
      pages: job.pages,
      settings: job.settings ? JSON.parse(job.settings) : null,
      copies: job.settings ? (JSON.parse(job.settings) as { copies?: number }).copies ?? 1 : 1,
    };
  }

  @SubscribeMessage('job:progress')
  async onProgress(@ConnectedSocket() client: Socket, @MessageBody() body: { jobId?: string; page?: number; pages?: number }) {
    if (!body?.jobId) return;
    this.logger.log(
      `Kiosk ${client.data?.kioskId}: job ${body.jobId} printing page ${body.page ?? '?'}/${body.pages ?? '?'}`,
    );
  }

  @SubscribeMessage('job:completed')
  async onCompleted(@ConnectedSocket() client: Socket, @MessageBody() body: { jobId?: string }) {
    const job = await this.claimOwnedPrintingJob(client, body?.jobId);
    if (!job) return;
    await this.prisma.job.update({
      where: { id: job.id },
      data: { state: 'COMPLETED', printedAt: new Date(), otpHash: null },
    });
    await this.deleteFile(job.id, job.fileKey);
    this.logger.log(`Job ${job.id} COMPLETED — file deleted (hard guarantee, spec §5 rule 1)`);
  }

  @SubscribeMessage('job:failed')
  async onFailed(@ConnectedSocket() client: Socket, @MessageBody() body: { jobId?: string; reason?: string }) {
    const job = await this.claimOwnedPrintingJob(client, body?.jobId);
    if (!job) return;
    await this.prisma.job.update({
      where: { id: job.id },
      data: { state: 'FAILED', failReason: body?.reason ?? 'PRINT_FAILED' },
    });
    await this.deleteFile(job.id, job.fileKey);
    // Phase 2: Razorpay auto-refund fires here (spec §5 rule 2).
    this.logger.warn(`Job ${job.id} FAILED (${body?.reason ?? 'PRINT_FAILED'}) — file deleted`);
  }

  @SubscribeMessage('heartbeat')
  async onHeartbeat(@ConnectedSocket() client: Socket, @MessageBody() body: { printerState?: string; inkLevels?: unknown; sheetsSinceRefill?: number; agentVersion?: string }) {
    const kioskId = client.data?.kioskId as string | undefined;
    if (!kioskId) return;
    await this.prisma.kiosk.update({
      where: { id: kioskId },
      data: {
        lastSeenAt: new Date(),
        status: 'ONLINE',
        ...(body?.inkLevels ? { inkLevels: JSON.stringify(body.inkLevels) } : {}),
        ...(typeof body?.sheetsSinceRefill === 'number' ? { sheetsSinceRefill: body.sheetsSinceRefill } : {}),
      },
    });
  }

  private async claimOwnedPrintingJob(client: Socket, jobId: string | undefined) {
    const kioskId = client.data?.kioskId as string | undefined;
    if (!jobId || !kioskId) return null;
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job || job.kioskId !== kioskId || job.state !== 'PRINTING') return null;
    return job;
  }

  private async deleteFile(jobId: string, fileKey: string | null) {
    if (!fileKey) return;
    try {
      await this.storage.delete(jobId, fileKey);
    } catch (err) {
      this.logger.error(`Failed deleting file for job ${jobId}: ${err}`);
    }
    await this.prisma.job.update({ where: { id: jobId }, data: { fileKey: null } });
  }
}
