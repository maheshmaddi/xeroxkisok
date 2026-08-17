import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Patch,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { KioskGateway } from '../kiosk-gateway/kiosk.gateway';
import { RefundsService } from '../payments/refunds.service';
import { AdminGuard } from './admin.guard';
import { ADMIN_COOKIE, createSessionToken } from './admin-auth.util';

const COMMANDS = ['test_print', 'reboot_agent', 'maintenance_on', 'maintenance_off'] as const;
type Command = (typeof COMMANDS)[number];

@Controller('admin')
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: KioskGateway,
    private readonly refunds: RefundsService,
    private readonly config: ConfigService,
  ) {}

  // ------------------------------------------------------------------ auth
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: { email?: string; password?: string }, @Res({ passthrough: true }) res: Response) {
    const email = this.config.get<string>('ADMIN_EMAIL') ?? 'admin@local';
    const hash = this.config.get<string>('ADMIN_PASSWORD_HASH');
    const plain = this.config.get<string>('ADMIN_PASSWORD');
    // Prefer the bcrypt hash (spec §11); the plain var is dev-only convenience.
    const passwordOk = hash
      ? bcrypt.compareSync(body?.password ?? '', hash)
      : Boolean(plain) && body?.password === plain;
    if (!passwordOk || body?.email !== email) throw new BadRequestException('Invalid credentials');

    const secret = this.config.get<string>('JWT_SECRET') ?? 'dev-jwt-secret-change-me';
    res.cookie(ADMIN_COOKIE, createSessionToken(email, secret), {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 12 * 60 * 60 * 1000,
    });
    return { ok: true };
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(ADMIN_COOKIE);
    return { ok: true };
  }

  // ------------------------------------------------------------- dashboard
  @Get('overview')
  @UseGuards(AdminGuard)
  async overview() {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);

    const [todayJobs, weekJobs, todayRevenue, weekRevenue, todayFailed, kiosks] = await Promise.all([
      this.prisma.job.count({ where: { createdAt: { gte: startOfDay } } }),
      this.prisma.job.count({ where: { createdAt: { gte: weekAgo } } }),
      this.prisma.payment.aggregate({
        where: { status: { in: ['captured', 'refunded'] }, job: { createdAt: { gte: startOfDay } } },
        _sum: { amount: true },
      }),
      this.prisma.payment.aggregate({
        where: { status: { in: ['captured', 'refunded'] }, job: { createdAt: { gte: weekAgo } } },
        _sum: { amount: true },
      }),
      this.prisma.job.count({ where: { createdAt: { gte: startOfDay }, state: { in: ['FAILED', 'REFUNDED'] } } }),
      this.prisma.kiosk.findMany({
        select: { id: true, name: true, status: true, lastSeenAt: true, inkLevels: true, sheetsSinceRefill: true, paperCapacity: true },
        orderBy: { id: 'asc' },
      }),
    ]);

    const daily = await this.prisma.payment.groupBy({
      by: ['jobId'],
      where: { status: { in: ['captured', 'refunded'] }, job: { createdAt: { gte: weekAgo } } },
      _sum: { amount: true },
    });
    // Fold into 7 day buckets from the joined jobs.
    const jobs = await this.prisma.job.findMany({
      where: { id: { in: daily.map((d) => d.jobId) } },
      select: { id: true, createdAt: true },
    });
    const createdById = new Map(jobs.map((j) => [j.id, j.createdAt.getTime()]));
    const revenueByDay = new Map<string, number>();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 3600 * 1000);
      revenueByDay.set(d.toISOString().slice(0, 10), 0);
    }
    for (const entry of daily) {
      const created = createdById.get(entry.jobId);
      if (!created) continue;
      const key = new Date(created).toISOString().slice(0, 10);
      if (revenueByDay.has(key)) revenueByDay.set(key, (revenueByDay.get(key) ?? 0) + (entry._sum.amount ?? 0));
    }

    return {
      jobsToday: todayJobs,
      jobsWeek: weekJobs,
      revenueTodayPaise: todayRevenue._sum.amount ?? 0,
      revenueWeekPaise: weekRevenue._sum.amount ?? 0,
      failureRateToday: todayJobs > 0 ? todayFailed / todayJobs : 0,
      kiosks: kiosks.map((k) => ({
        ...k,
        inkLevels: k.inkLevels ? JSON.parse(k.inkLevels) : null,
        paperRemaining: Math.max(0, k.paperCapacity - k.sheetsSinceRefill),
      })),
      revenueByDay: [...revenueByDay.entries()].map(([day, paise]) => ({ day, paise })),
    };
  }

  // ----------------------------------------------------------- kiosks CRUD
  @Post('kiosks')
  @UseGuards(AdminGuard)
  async createKiosk(@Body() body: { id?: string; name?: string; printerIp?: string; pricingId?: string; secret?: string }) {
    if (!body?.id || !body?.name || !body?.pricingId) throw new BadRequestException('id, name, pricingId required');
    if (await this.prisma.kiosk.findUnique({ where: { id: body.id } })) {
      throw new BadRequestException(`Kiosk ${body.id} already exists`);
    }
    const secret = body.secret ?? randomBytes(16).toString('hex');
    const kiosk = await this.prisma.kiosk.create({
      data: {
        id: body.id,
        name: body.name,
        printerIp: body.printerIp ?? '127.0.0.1',
        pricingId: body.pricingId,
        secretKey: bcrypt.hashSync(secret, 10),
      },
    });
    return { id: kiosk.id, name: kiosk.name, secret }; // shown once for agent config
  }

  @Patch('kiosks/:id')
  @UseGuards(AdminGuard)
  async updateKiosk(@Param('id') id: string, @Body() body: { name?: string; printerIp?: string; pricingId?: string; secret?: string; status?: string }) {
    const kiosk = await this.prisma.kiosk.findUnique({ where: { id } });
    if (!kiosk) throw new NotFoundException('Kiosk not found');
    const { secret, ...rest } = body;
    const data: Record<string, unknown> = { ...rest };
    if (secret) data.secretKey = bcrypt.hashSync(secret, 10); // secret rotation (spec §9)
    const updated = await this.prisma.kiosk.update({ where: { id }, data });
    return { id: updated.id, name: updated.name, rotatedSecret: secret ?? null };
  }

  @Get('kiosks/:id')
  @UseGuards(AdminGuard)
  async kioskDetail(@Param('id') id: string) {
    const kiosk = await this.prisma.kiosk.findUnique({ where: { id }, include: { pricing: true } });
    if (!kiosk) throw new NotFoundException('Kiosk not found');
    const [jobs, consumables] = await Promise.all([
      this.prisma.job.findMany({
        where: { kioskId: id },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, fileName: true, state: true, pages: true, priceTotal: true, failReason: true, createdAt: true, printedAt: true },
      }),
      this.prisma.consumableEvent.findMany({ where: { kioskId: id }, orderBy: { createdAt: 'desc' }, take: 10 }),
    ]);
    return {
      ...kiosk,
      inkLevels: kiosk.inkLevels ? JSON.parse(kiosk.inkLevels) : null,
      paperRemaining: Math.max(0, kiosk.paperCapacity - kiosk.sheetsSinceRefill),
      jobs,
      consumables: consumables.map((c) => ({ ...c, data: JSON.parse(c.data) })),
    };
  }

  @Post('kiosks/:id/command')
  @HttpCode(200)
  @UseGuards(AdminGuard)
  async command(@Param('id') id: string, @Body() body: { type?: string }) {
    const kiosk = await this.prisma.kiosk.findUnique({ where: { id } });
    if (!kiosk) throw new NotFoundException('Kiosk not found');
    const type = body?.type as Command;
    if (!COMMANDS.includes(type)) throw new BadRequestException(`type must be one of ${COMMANDS.join(', ')}`);
    if (type === 'maintenance_on') {
      await this.prisma.kiosk.update({ where: { id }, data: { status: 'MAINTENANCE' } });
    } else if (type === 'maintenance_off') {
      await this.prisma.kiosk.update({ where: { id }, data: { status: 'OFFLINE' } }); // agent heartbeat restores ONLINE
    }
    this.gateway.emitKioskCommand(id, { type });
    return { ok: true, type };
  }

  // ------------------------------------------------------------ pricing CRUD
  @Post('pricing')
  @UseGuards(AdminGuard)
  async createPricing(@Body() body: Record<string, unknown>) {
    const required = ['name', 'bwA4', 'colorA4', 'bwA3', 'colorA3', 'photo4x6', 'passportSheet'];
    for (const key of required) if (typeof body?.[key] !== 'number' || (key === 'name' && !body[key])) {
      throw new BadRequestException(`pricing field ${key} required`);
    }
    return this.prisma.pricingProfile.create({ data: body as never });
  }

  @Patch('pricing/:id')
  @UseGuards(AdminGuard)
  async updatePricing(@Param('id') id: string, @Body() body: Record<string, number | string>) {
    const profile = await this.prisma.pricingProfile.findUnique({ where: { id } });
    if (!profile) throw new NotFoundException('Pricing profile not found');
    return this.prisma.pricingProfile.update({ where: { id }, data: body as never });
  }

  @Get('pricing')
  @UseGuards(AdminGuard)
  async pricingList() {
    return this.prisma.pricingProfile.findMany({ orderBy: { name: 'asc' } });
  }

  // ---------------------------------------------------------------- refunds
  @Get('refunds')
  @UseGuards(AdminGuard)
  async refundsList() {
    const jobs = await this.prisma.job.findMany({
      where: { state: { in: ['FAILED', 'REFUNDED', 'EXPIRED'] } },
      include: { payment: true, kiosk: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return jobs.map((j) => ({
      jobId: j.id,
      fileName: j.fileName,
      kiosk: j.kiosk,
      state: j.state,
      failReason: j.failReason,
      amount: j.payment?.amount ?? 0,
      paymentStatus: j.payment?.status ?? 'none',
      refundId: j.payment?.refundId ?? null,
      createdAt: j.createdAt,
    }));
  }

  @Post('jobs/:id/refund')
  @HttpCode(200)
  @UseGuards(AdminGuard)
  async manualRefund(@Param('id') jobId: string) {
    const refunded = await this.refunds.refundFailedJob(jobId, 'ADMIN_REFUND');
    if (!refunded) {
      const job = await this.prisma.job.findUnique({ where: { id: jobId } });
      if (!job) throw new NotFoundException('Job not found');
      throw new BadRequestException('Job has no captured payment to refund');
    }
    return { ok: true };
  }
}

/** Field staff log refills with kiosk credentials (spec §5 refill endpoint). */
@Controller('kiosks')
export class RefillController {
  constructor(private readonly prisma: PrismaService) {}

  @Post(':id/refill')
  @HttpCode(200)
  async refill(
    @Param('id') id: string,
    @Body() body: { type?: string; sheets?: number },
    @Req() req: Request,
  ) {
    const kiosk = await this.prisma.kiosk.findUnique({ where: { id } });
    const secret = req.headers['x-kiosk-secret'];
    if (!kiosk || typeof secret !== 'string' || !bcrypt.compareSync(secret, kiosk.secretKey)) {
      throw new NotFoundException('Kiosk not found');
    }
    const type = body?.type === 'INK_REFILL' ? 'INK_REFILL' : 'PAPER_REFILL';
    const sheets = typeof body?.sheets === 'number' ? body.sheets : kiosk.paperCapacity;
    await this.prisma.kiosk.update({ where: { id }, data: { sheetsSinceRefill: 0 } });
    await this.prisma.consumableEvent.create({
      data: { kioskId: id, type, data: JSON.stringify({ sheets }) },
    });
    return { ok: true, resetSheets: true };
  }
}
