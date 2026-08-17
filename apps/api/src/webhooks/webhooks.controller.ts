import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { JobsService } from '../jobs/jobs.service';
import { RefundsService } from '../payments/refunds.service';
import { verifyRazorpaySignature } from '../payments/webhook-signature.util';
import { PrismaService } from '../prisma/prisma.service';

interface RazorpayWebhook {
  event: string;
  payload: {
    payment?: { entity?: { id: string; order_id: string; status: string } };
    refund?: { entity?: { id: string; payment_id: string } };
  };
}

/** POST /webhooks/razorpay — signature verification is mandatory (spec §5, §9). */
@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly refunds: RefundsService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @Post('razorpay')
  @HttpCode(200)
  async razorpay(@Req() req: RawBodyRequest<Request>, @Body() body: RazorpayWebhook) {
    if (!this.config.get('RAZORPAY_WEBHOOK_SECRET')) {
      this.logger.warn('Razorpay webhook received but RAZORPAY_WEBHOOK_SECRET is not configured');
      throw new BadRequestException('Webhooks not configured');
    }

    const raw = typeof req.rawBody === 'string' ? req.rawBody : req.rawBody?.toString('utf8');
    if (!raw) throw new BadRequestException('Missing raw body');
    const signature = req.headers['x-razorpay-signature'] as string | undefined;
    // Verified against the webhook secret directly — independent of payment mode.
    if (!verifyRazorpaySignature(raw, signature, this.config.get('RAZORPAY_WEBHOOK_SECRET')!)) {
      this.logger.warn('Razorpay webhook signature mismatch — rejecting');
      throw new BadRequestException('Invalid webhook signature');
    }

    switch (body?.event) {
      case 'payment.captured': {
        const entity = body.payload?.payment?.entity;
        if (!entity?.order_id) break;
        const payment = await this.prisma.payment.findFirst({ where: { razorpayOrderId: entity.order_id } });
        if (!payment) {
          this.logger.warn(`Webhook payment.captured for unknown order ${entity.order_id}`);
          break;
        }
        await this.jobs.markPaidAndQueue(payment.jobId, entity.id);
        break;
      }
      case 'refund.processed': {
        const entity = body.payload?.refund?.entity;
        if (!entity?.payment_id) break;
        const payment = await this.prisma.payment.findFirst({ where: { razorpayPaymentId: entity.payment_id } });
        if (!payment) {
          this.logger.warn(`Webhook refund.processed for unknown payment ${entity.payment_id}`);
          break;
        }
        await this.refunds.markRefundProcessed(payment.id, entity.id);
        break;
      }
      default:
        break; // events we don't act on — acknowledged per Razorpay guidance
    }
    return { ok: true };
  }
}
