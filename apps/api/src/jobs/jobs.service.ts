import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { randomBytes, randomInt } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import {
  CreateJobSchema,
  MAX_FILE_BYTES,
  PrintSettingsSchema,
  pricePrint,
  type PriceResult,
} from '@print-kiosk/shared';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE } from '../storage/storage.constants';
import type { StorageService } from '../storage/storage.types';
import { CorruptPdfError, inspectPdf, PasswordProtectedPdfError, renderPdfPreviews } from '../pdf/pdf.util';
import { convertDocxToPdf, DocxConversionError, LibreOfficeUnavailableError } from '../pdf/docx.util';
import { composePhotoArtifact } from '../images/image.util';
import { KioskGateway } from '../kiosk-gateway/kiosk.gateway';
import { PAY_PROVIDER } from '../payments/payments.constants';
import type { PayIntent, PayProvider } from '../payments/payments.types';

const OTP_TTL_MIN = Number(process.env.OTP_TTL_MIN ?? 30);
const OTP_MAX_ATTEMPTS = 5;

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  /**
   * OTP plaintext registry. The DB stores only the bcrypt hash (spec §5), so
   * the digits live in-memory between pay() and the first /status reveal.
   * Single API instance in v1; if the process restarts inside that window the
   * OTP is unrecoverable and the job walks the EXPIRED → refund path.
   */
  private readonly pendingOtps = new Map<string, { digits: string; expiresAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE) private readonly storage: StorageService,
    private readonly gateway: KioskGateway,
    @Inject(PAY_PROVIDER) private readonly payProvider: PayProvider,
  ) {}

  // POST /jobs
  async create(body: unknown) {
    const parsed = CreateJobSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message ?? 'Invalid request');

    const kiosk = await this.prisma.kiosk.findUnique({ where: { id: parsed.data.kioskId } });
    if (!kiosk) throw new BadRequestException(`Unknown kiosk "${parsed.data.kioskId}"`);

    const ext = parsed.data.fileName.split('.').pop()?.toLowerCase() ?? '';
    const fileType = ext === 'jpeg' ? 'jpg' : ext;
    if (!['pdf', 'docx', 'jpg', 'png'].includes(fileType)) {
      throw new BadRequestException('Only PDF, DOCX, JPG and PNG files are supported');
    }

    const job = await this.prisma.job.create({
      data: {
        kioskId: kiosk.id,
        fileName: parsed.data.fileName,
        fileType,
        accessToken: randomBytes(16).toString('hex'), // 128-bit (spec §9)
      },
    });
    const upload = await this.storage.uploadTarget(job.id, job.accessToken);
    return { jobId: job.id, upload };
  }

  // PUT /jobs/:id/file (local-dev storage driver)
  async saveUpload(jobId: string, token: string | undefined, body: unknown) {
    const job = await this.getByToken(jobId, token);
    if (job.state !== 'UPLOADED') throw new ConflictException('This job already has a file');
    if (!Buffer.isBuffer(body) || body.length === 0) throw new BadRequestException('Empty upload body');
    if (body.length > MAX_FILE_BYTES) throw new BadRequestException('File exceeds the 50MB limit');
    const fileKey = await this.storage.saveUpload(jobId, body);
    await this.prisma.job.update({ where: { id: jobId }, data: { fileKey } });
    return { ok: true };
  }

  // POST /jobs/:id/process — page count + previews; terminal failure on bad files
  async process(jobId: string, token: string | undefined) {
    const job = await this.getByToken(jobId, token);
    if (job.state !== 'UPLOADED' || !job.fileKey) {
      throw new ConflictException('Job is not awaiting a freshly uploaded file');
    }

    const buf = await this.storage.read(jobId, job.fileKey);
    let pages: number;

    if (job.fileType === 'docx') {
      // DOCX → PDF via LibreOffice headless (Phase 4); the converted PDF is
      // stored as the print artifact the kiosk will print.
      let converted: Buffer;
      try {
        converted = await convertDocxToPdf(buf, job.fileName);
      } catch (err) {
        if (err instanceof LibreOfficeUnavailableError) {
          throw await this.fail(
            job.id,
            'LIBREOFFICE_UNAVAILABLE',
            'DOCX printing is not available on this server yet — please upload a PDF for now.',
          );
        }
        if (err instanceof DocxConversionError) {
          throw await this.fail(job.id, 'DOCX_CONVERSION_FAILED', 'This document could not be converted. Please upload a PDF.');
        }
        throw err;
      }
      try {
        pages = await inspectPdf(converted);
      } catch {
        throw await this.fail(job.id, 'CORRUPT_DOCX', 'This document could not be read — the file may be corrupt.');
      }
      if (pages < 1) throw await this.fail(job.id, 'EMPTY_DOCX', 'This document has no pages.');
      const printKey = await this.storage.saveArtifact(job.id, converted, 'print.pdf');
      await this.prisma.job.update({ where: { id: job.id }, data: { pages, printKey, state: 'PRICED' } });
      return { pages, previews: [] };
    }

    if (job.fileType === 'pdf') {
      try {
        pages = await inspectPdf(buf);
      } catch (err) {
        if (err instanceof PasswordProtectedPdfError) {
          throw await this.fail(job.id, 'PASSWORD_PROTECTED_PDF', 'This PDF is password-protected. Remove the password and upload again.');
        }
        if (err instanceof CorruptPdfError) {
          throw await this.fail(job.id, 'CORRUPT_PDF', 'This PDF could not be read — the file may be corrupt.');
        }
        throw err;
      }
      if (pages < 1) {
        throw await this.fail(job.id, 'EMPTY_PDF', 'This PDF has no pages.');
      }
    } else {
      pages = 1; // images: single "page"; photo modes compose a 4x6 sheet at pricing
    }

    await this.prisma.job.update({ where: { id: job.id }, data: { pages, state: 'PRICED' } });
    const previews = job.fileType === 'pdf' ? await renderPdfPreviews(buf, job.id) : [];
    return { pages, previews };
  }

  // POST /jobs/:id/price — server-side pricing only (spec §5 rule 5)
  async price(jobId: string, token: string | undefined, body: unknown): Promise<PriceResult & { jobId: string }> {
    const job = await this.getByToken(jobId, token);
    if (job.state !== 'PRICED') throw new ConflictException('Process the file before pricing');

    const parsed = PrintSettingsSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message ?? 'Invalid print settings');
    const settings = parsed.data;

    if (settings.mode !== 'document' && job.fileType === 'pdf') {
      throw new BadRequestException('Photo modes apply to image uploads, not PDFs');
    }
    if (settings.mode === 'document' && job.fileType !== 'pdf' && !job.printKey) {
      throw new BadRequestException('This file must be printed as a photo');
    }

    let result: PriceResult;
    try {
      result = pricePrint(settings, job.pages, job.kiosk.pricing);
    } catch (err: any) {
      throw new BadRequestException(err?.message ?? 'Invalid print settings');
    }

    let printKey = job.printKey;
    if (settings.mode !== 'document' && job.fileKey) {
      // Compose the print-ready 4x6 artifact now (settings known); the kiosk
      // downloads this instead of the raw photo.
      try {
        const original = await this.storage.read(job.id, job.fileKey);
        const artifact = await composePhotoArtifact(original, settings);
        printKey = await this.storage.saveArtifact(job.id, artifact, 'print.pdf');
      } catch (err: any) {
        this.logger.error(`Photo composition failed for job ${job.id}: ${err?.message}`);
        throw new BadRequestException('This image could not be processed — try a different photo.');
      }
    }

    await this.prisma.job.update({
      where: { id: job.id },
      data: { settings: JSON.stringify(settings), priceTotal: result.totalPaise, printKey, state: 'AWAITING_PAYMENT' },
    });
    return { jobId: job.id, ...result };
  }

  /**
   * POST /jobs/:id/pay — mock mode captures instantly (Phase 1 behavior);
   * Razorpay mode creates an order and returns checkout details (spec §5).
   */
  async pay(jobId: string, token: string | undefined): Promise<PayIntent> {
    const job = await this.getByToken(jobId, token);
    if (job.state !== 'AWAITING_PAYMENT') throw new ConflictException('Job is not awaiting payment');

    if (this.payProvider.mode === 'mock') {
      const payment = await this.prisma.payment.create({
        data: {
          jobId: job.id,
          razorpayOrderId: `order_mock_${randomBytes(8).toString('hex')}`,
          amount: job.priceTotal,
          status: 'created',
        },
      });
      await this.markPaidAndQueue(job.id, `pay_mock_${randomBytes(6).toString('hex')}`);
      this.logger.log(`Job ${job.id} paid (mock, ₹${(payment.amount / 100).toFixed(2)}) → QUEUED`);
      return { mode: 'mock', jobId: job.id, state: 'QUEUED' };
    }

    const existing = await this.prisma.payment.findUnique({ where: { jobId: job.id } });
    const intent = await this.payProvider.createOrder(job, existing);
    if (!existing) {
      await this.prisma.payment.create({
        data: { jobId: job.id, razorpayOrderId: (intent as any).orderId, amount: job.priceTotal, status: 'created' },
      });
    }
    return intent;
  }

  /**
   * The moment money is confirmed (mock pay here, payment.captured webhook in
   * Razorpay mode): record capture, issue OTP, queue for the kiosk.
   * Idempotent — a replayed webhook is a no-op.
   */
  async markPaidAndQueue(jobId: string, razorpayPaymentId: string): Promise<void> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) return;
    if (job.state !== 'AWAITING_PAYMENT') return; // already captured/queued — idempotent

    const otp = String(randomInt(0, 10_000)).padStart(4, '0');
    const otpExpiresAt = new Date(Date.now() + OTP_TTL_MIN * 60_000);

    // QUEUED before emitting so an instant agent claim can't race the write.
    const queued = await this.prisma.job.update({
      where: { id: job.id },
      data: {
        state: 'QUEUED',
        otpHash: bcrypt.hashSync(otp, 10),
        otpExpiresAt,
        otpAttempts: 0,
        otpShownAt: null,
      },
    });
    await this.prisma.payment.updateMany({
      where: { jobId: job.id, status: 'created' },
      data: { status: 'captured', razorpayPaymentId },
    });
    this.pendingOtps.set(job.id, { digits: otp, expiresAt: otpExpiresAt.getTime() });
    this.gateway.emitJobQueued(job.kioskId, queued);
    this.logger.log(`Job ${job.id} captured (${razorpayPaymentId}) → QUEUED; OTP expires in ${OTP_TTL_MIN} min`);
  }

  // GET /jobs/:id/status — polled by the user app; OTP revealed exactly once
  async status(jobId: string, token: string | undefined) {
    const job = await this.getByToken(jobId, token);

    const response: Record<string, unknown> = {
      jobId: job.id,
      state: job.state,
      pages: job.pages,
      settings: job.settings ? JSON.parse(job.settings) : null,
      priceTotal: job.priceTotal,
      fileName: job.fileName,
      failReason: job.failReason,
      printedAt: job.printedAt,
      otpExpiresAt: job.otpExpiresAt,
      otpLocked: job.otpAttempts >= OTP_MAX_ATTEMPTS,
    };

    const pending = this.pendingOtps.get(job.id);
    const canReveal =
      (job.state === 'QUEUED' || job.state === 'PRINTING') &&
      pending &&
      pending.expiresAt > Date.now() &&
      !job.otpShownAt &&
      job.otpAttempts < OTP_MAX_ATTEMPTS;

    if (canReveal) {
      response.otp = pending.digits;
      this.pendingOtps.delete(job.id);
      await this.prisma.job.update({ where: { id: job.id }, data: { otpShownAt: new Date() } });
    }
    return response;
  }

  /** Mark FAILED and return the exception to throw. */
  private async fail(jobId: string, reason: string, message: string): Promise<never> {
    await this.prisma.job.update({ where: { id: jobId }, data: { state: 'FAILED', failReason: reason } });
    throw new BadRequestException(message);
  }

  async getByToken(jobId: string, token: string | undefined) {
    const job = await this.prisma.job.findUnique({
      where: { id: jobId },
      include: { kiosk: { include: { pricing: true } } },
    });
    if (!job || !token || job.accessToken !== token) {
      throw new NotFoundException('Job not found');
    }
    return job;
  }
}
