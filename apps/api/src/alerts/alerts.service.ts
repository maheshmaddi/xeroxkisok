import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

const OFFLINE_AFTER_MIN = 5;
const INK_THRESHOLD = 20; // percent
const PAPER_THRESHOLD_SHEETS = 50;
const FAILURE_RATE = 0.2; // 20% within an hour (spec §8)
const ALERT_COOLDOWN_MIN = 30;

/** Spec §8 alerts: offline, low ink, low paper, failure spikes, daily summary. */
@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  private readonly lastSentAt = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Called from the sweep loop every SWEEP_INTERVAL_SEC. */
  async evaluate() {
    await this.kioskOffline();
    await this.lowInk();
    await this.lowPaper();
    await this.failureRate();
  }

  /** Daily 9 PM revenue summary (spec §8). */
  async dailySummary() {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const [jobs, revenue, failures, kiosks] = await Promise.all([
      this.prisma.job.count({ where: { createdAt: { gte: startOfDay } } }),
      this.prisma.payment.aggregate({
        where: { status: { in: ['captured', 'refunded'] }, job: { createdAt: { gte: startOfDay } } },
        _sum: { amount: true },
      }),
      this.prisma.job.count({ where: { createdAt: { gte: startOfDay }, state: { in: ['FAILED', 'REFUNDED'] } } }),
      this.prisma.kiosk.findMany({ select: { id: true, status: true } }),
    ]);
    const online = kiosks.filter((k) => k.status === 'ONLINE').length;
    await this.send(
      'daily-summary',
      `📊 Daily summary — ₹${((revenue._sum.amount ?? 0) / 100).toFixed(2)} from ${jobs} jobs (${failures} failed). Kiosks online: ${online}/${kiosks.length}.`,
    );
  }

  private async kioskOffline() {
    const cutoff = new Date(Date.now() - OFFLINE_AFTER_MIN * 60_000);
    const kiosks = await this.prisma.kiosk.findMany({
      where: { status: { in: ['OFFLINE', 'ERROR'] }, OR: [{ lastSeenAt: { lt: cutoff } }, { lastSeenAt: null }] },
      select: { id: true, name: true, status: true },
    });
    for (const k of kiosks) {
      await this.send(`offline:${k.id}`, `🔴 Kiosk ${k.id} (${k.name}) is ${k.status} for over ${OFFLINE_AFTER_MIN} minutes.`);
    }
  }

  private async lowInk() {
    const kiosks = await this.prisma.kiosk.findMany({ select: { id: true, inkLevels: true } });
    for (const k of kiosks) {
      if (!k.inkLevels) continue;
      const levels = JSON.parse(k.inkLevels) as Record<string, number>;
      const low = Object.entries(levels).filter(([, v]) => v < INK_THRESHOLD);
      if (low.length > 0) {
        await this.send(
          `ink:${k.id}`,
          `🖨️ Kiosk ${k.id} ink low: ${low.map(([c, v]) => `${c} ${v}%`).join(', ')}.`,
        );
      }
    }
  }

  private async lowPaper() {
    const kiosks = await this.prisma.kiosk.findMany({
      select: { id: true, sheetsSinceRefill: true, paperCapacity: true },
    });
    for (const k of kiosks) {
      const remaining = k.paperCapacity - k.sheetsSinceRefill;
      if (remaining < PAPER_THRESHOLD_SHEETS) {
        await this.send(`paper:${k.id}`, `📄 Kiosk ${k.id} paper low: ~${remaining} sheets left.`);
      }
    }
  }

  private async failureRate() {
    const hourAgo = new Date(Date.now() - 3600_000);
    const [total, failed] = await Promise.all([
      this.prisma.job.count({ where: { createdAt: { gte: hourAgo } } }),
      this.prisma.job.count({ where: { createdAt: { gte: hourAgo }, state: { in: ['FAILED', 'REFUNDED'] } } }),
    ]);
    if (total >= 5 && failed / total > FAILURE_RATE) {
      await this.send(
        'failure-rate',
        `⚠️ Failure rate ${(100 * failed / total).toFixed(0)}% over the last hour (${failed}/${total} jobs).`,
      );
    }
  }

  /** Telegram when configured, log otherwise; rate-limited per key. */
  private async send(key: string, message: string) {
    const now = Date.now();
    const last = this.lastSentAt.get(key) ?? 0;
    if (now - last < ALERT_COOLDOWN_MIN * 60_000) return;
    this.lastSentAt.set(key, now);

    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    const chatId = this.config.get<string>('TELEGRAM_CHAT_ID');
    if (!token || !chatId) {
      this.logger.log(`[alert:${key}] ${message}`);
      return;
    }
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: `[print-kiosk] ${message}` }),
      });
    } catch (err) {
      this.logger.warn(`Telegram send failed for ${key}: ${err}`);
    }
  }
}
