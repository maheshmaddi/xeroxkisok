import { z } from 'zod';

/**
 * Prisma's SQLite connector (local dev) supports neither `enum` nor `Json`
 * columns, so these values live in `String` columns and are validated at the
 * application boundary with the zod schemas in this file (spec §4 note).
 */

export const JOB_STATES = [
  'UPLOADED',
  'PRICED',
  'AWAITING_PAYMENT',
  'PAID',
  'QUEUED',
  'PRINTING',
  'COMPLETED',
  'FAILED',
  'REFUNDED',
  'EXPIRED',
] as const;
export type JobState = (typeof JOB_STATES)[number];
export const JobStateSchema = z.enum(JOB_STATES);

export const KIOSK_STATUSES = ['ONLINE', 'OFFLINE', 'ERROR', 'MAINTENANCE'] as const;
export type KioskStatus = (typeof KIOSK_STATUSES)[number];
export const KioskStatusSchema = z.enum(KIOSK_STATUSES);

export const FILE_TYPES = ['pdf', 'docx', 'jpg', 'png'] as const;
export type FileType = (typeof FILE_TYPES)[number];

export const PAPER_SIZES = ['A4', 'A3'] as const;
export const PRINT_MODES = ['document', 'photo4x6', 'passport'] as const;

/** Phase 1 covers document mode; photo4x6/passport arrive in Phase 4. */
export const DocumentSettingsSchema = z.object({
  mode: z.literal('document'),
  copies: z.number().int().min(1).max(50),
  color: z.boolean(),
  duplex: z.boolean(),
  paperSize: z.enum(PAPER_SIZES),
  pageRange: z
    .string()
    .regex(/^\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*$/, 'Invalid page range (use e.g. "1-3,7")')
    .nullable()
    .optional(),
});
export type DocumentSettings = z.infer<typeof DocumentSettingsSchema>;

export const CreateJobSchema = z.object({
  kioskId: z.string().min(1).max(32),
  fileName: z.string().min(1).max(255),
});
export type CreateJobInput = z.infer<typeof CreateJobSchema>;

export interface PriceLine {
  label: string;
  qty: number;
  unitPaise: number;
  totalPaise: number;
}

export interface PriceResult {
  totalPaise: number;
  lines: PriceLine[];
  sides: number;
  sheets: number;
}

/** Paise rates from a PricingProfile row. */
export interface PricingRates {
  bwA4: number;
  colorA4: number;
  bwA3: number;
  colorA3: number;
  photo4x6: number;
  passportSheet: number;
}

export const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50MB (spec §6)
