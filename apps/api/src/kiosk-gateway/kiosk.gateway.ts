import { Inject, Logger } from '@nestjs/common';
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
import { FileCleanupService } from '../storage/file-cleanup.service';
import { RefundsService } from '../payments/refunds.service';

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
    private readonly cleanup: FileCleanupService,
    private readonly refunds: RefundsService,
  ) {}

  async handleConnection(client: Socket) {
    // socket.io does not await async connection handlers, so per-message
    // handlers below await this promise before trusting client.data.kioskId.
    client.data.ready = this.authenticate(client);
  }

  private async authenticate(client: Socket) {
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

    // Catch-up: a job may have been queued while this kiosk was offline.
    const pending = await this.prisma.job.findMany({
      where: { kioskId: kiosk.id, state: 'QUEUED', otpExpiresAt: { gt: new Date() } },
    });
    for (const job of pending) {
      this.logger.log(`Re-emitting queued job ${job.id} to kiosk ${kiosk.id} after reconnect`);
      this.emitJobQueued(kiosk.id, job);
    }
  }

  /** Resolves once this socket's auth finished; undefined kioskId means rejected. */
  private async ready(client: Socket): Promise<string | undefined> {
    await client.data?.ready?.catch(() => undefined);
    return client.data?.kioskId as string | undefined;
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

  /** Remote command from the admin dashboard (Phase 5). */
  emitKioskCommand(kioskId: string, command: { type: 'test_print' | 'reboot_agent' | 'maintenance_on' | 'maintenance_off' }) {
    this.server.to(kioskId).emit('kiosk:command', command);
  }

  /**
   * Kiosk claims a paid job with the OTP typed on the keypad.
   * jobId optional: without it the code itself selects the job — the server
   * matches the digits against every waiting job of this kiosk (spec-style
   * multi-customer flow; agents that know the jobId may still send it).
   */
  @SubscribeMessage('job:claim')
  async onClaim(@ConnectedSocket() client: Socket, @MessageBody() body: { jobId?: string; otp?: string }) {
    const kioskId = await this.ready(client);
    if (!kioskId) return { ok: false, error: 'NOT_FOUND' };
    const otp = typeof body?.otp === 'string' ? body.otp : '';

    let job: { id: string; kioskId: string; state: string; otpHash: string | null; otpExpiresAt: Date | null; otpAttempts: number; fileKey: string | null; printKey: string | null; fileName: string; fileType: string; pages: number; settings: string | null } | null = null;
    let otpVerified = false;

    if (body?.jobId) {
      const found = await this.prisma.job.findUnique({ where: { id: body.jobId } });
      if (!found || found.kioskId !== kioskId) return { ok: false, error: 'NOT_FOUND' };
      job = found;
    } else {
      // Code-only claim: active codes are unique per kiosk (markPaidAndQueue
      // re-rolls collisions), so the digits identify exactly one job.
      const candidates = await this.prisma.job.findMany({
        where: {
          kioskId,
          state: 'QUEUED',
          otpExpiresAt: { gt: new Date() },
          otpHash: { not: null },
          otpAttempts: { lt: OTP_MAX_ATTEMPTS },
        },
        orderBy: { createdAt: 'asc' },
      });
      job = candidates.find((c) => bcrypt.compareSync(otp, c.otpHash!)) ?? null;
      otpVerified = Boolean(job);
      if (!job) {
        // Wrong digits: charge the oldest waiting job's attempt budget
        // (deterministic; identical to the jobId path in the single-job case).
        const chargeable = candidates[0];
        if (!chargeable) return { ok: false, error: 'NOT_FOUND' };
        const attempts = chargeable.otpAttempts + 1;
        await this.prisma.job.update({ where: { id: chargeable.id }, data: { otpAttempts: attempts } });
        this.logger.warn(
          `Kiosk ${kioskId}: code-only bad OTP (job ${chargeable.id} attempt ${attempts}/${OTP_MAX_ATTEMPTS})`,
        );
        return { ok: false, jobId: chargeable.id, error: attempts >= OTP_MAX_ATTEMPTS ? 'LOCKED' : 'BAD_OTP' };
      }
    }

    if (job.otpAttempts >= OTP_MAX_ATTEMPTS) return { ok: false, jobId: job.id, error: 'LOCKED' };
    if (job.state !== 'QUEUED') return { ok: false, jobId: job.id, error: 'NOT_CLAIMABLE' };
    if (!job.otpHash || !job.otpExpiresAt || job.otpExpiresAt < new Date()) {
      return { ok: false, jobId: job.id, error: 'OTP_EXPIRED' };
    }

    if (!otpVerified) {
      const otpOk = bcrypt.compareSync(otp, job.otpHash);
      if (!otpOk) {
        const attempts = job.otpAttempts + 1;
        await this.prisma.job.update({ where: { id: job.id }, data: { otpAttempts: attempts } });
        this.logger.warn(`Kiosk ${kioskId}: bad OTP for job ${job.id} (attempt ${attempts}/${OTP_MAX_ATTEMPTS})`);
        return { ok: false, jobId: job.id, error: attempts >= OTP_MAX_ATTEMPTS ? 'LOCKED' : 'BAD_OTP' };
      }
    }

    // Single-use: clear the hash and move to PRINTING before handing out the file.
    await this.prisma.job.update({ where: { id: job.id }, data: { state: 'PRINTING', otpHash: null } });
    const usePrintArtifact = Boolean(job.printKey);
    const key = job.printKey ?? job.fileKey;
    const fileUrl = key ? await this.storage.downloadUrl(job.id, usePrintArtifact ? 'print' : 'file') : null;
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
    await this.cleanup.purge(job.id, job.fileKey, job.printKey);
    this.logger.log(`Job ${job.id} COMPLETED — file deleted (hard guarantee, spec §5 rule 1)`);
  }

  @SubscribeMessage('job:failed')
  async onFailed(@ConnectedSocket() client: Socket, @MessageBody() body: { jobId?: string; reason?: string }) {
    const job = await this.claimOwnedPrintingJob(client, body?.jobId);
    if (!job) return;
    const reason = body?.reason ?? 'PRINT_FAILED';
    // Spec §5 rule 2: paid job failing → automatic refund; no payment → plain FAILED.
    const refunded = await this.refunds.refundFailedJob(job.id, reason);
    if (!refunded) {
      await this.prisma.job.update({ where: { id: job.id }, data: { state: 'FAILED', failReason: reason } });
      await this.cleanup.purge(job.id, job.fileKey, job.printKey);
    }
    this.logger.warn(`Job ${job.id} failed at kiosk (${reason}) — refunded=${refunded}`);
  }

  @SubscribeMessage('heartbeat')
  async onHeartbeat(@ConnectedSocket() client: Socket, @MessageBody() body: { printerState?: string; inkLevels?: unknown; sheetsSinceRefill?: number; agentVersion?: string }) {
    const kioskId = await this.ready(client);
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
    const kioskId = await this.ready(client);
    if (!jobId || !kioskId) return null;
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job || job.kioskId !== kioskId || job.state !== 'PRINTING') return null;
    return job;
  }
}
