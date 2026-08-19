'use client';

import { useRef } from 'react';
import { rupees } from '@print-kiosk/shared';

interface KioskInfo {
  id: string;
  name: string;
  status: string;
}

/** Landing: kiosk status, receipt-style price card, the one big upload button. */
export default function Landing({
  kiosk,
  onPick,
  busy,
}: {
  kiosk: KioskInfo | null;
  onPick: (file: File) => void;
  busy: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const offline = kiosk && kiosk.status !== 'ONLINE';

  return (
    <div className="stagger space-y-5">
      <section className="px-1 pt-3">
        <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-accent">Self-service printing</p>
        <h1 className="font-display mt-2 text-[2.6rem] font-semibold leading-[1.04] tracking-tight">
          From your phone
          <br />
          to <span className="italic text-accent">paper</span> in a minute.
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-inksoft">
          No app. No signup. Upload, pay by UPI, type a 4-digit code on the kiosk — done.
        </p>
      </section>

      {kiosk && (
        <section className="flex items-center justify-between rounded-2xl border border-line bg-card px-4 py-3 shadow-sheet">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-inksoft">This kiosk</p>
            <p className="truncate text-[15px] font-semibold">{kiosk.name}</p>
          </div>
          <span
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${
              offline ? 'bg-stamp/10 text-stamp' : 'bg-leaf/10 text-leaf'
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${offline ? 'bg-stamp' : 'animate-breathe bg-leaf'}`} />
            {offline ? kiosk.status.toLowerCase() : 'Online'}
          </span>
        </section>
      )}

      <section className="relative">
        <div className="rounded-t-2xl border border-b-0 border-line bg-card px-5 pb-4 pt-4 shadow-sheet">
          <div className="flex items-baseline justify-between">
            <h2 className="font-display text-lg font-semibold">Rates</h2>
            <CmykDots />
          </div>
          <dl className="mt-3 space-y-2 text-[14px]">
            <RateRow label="B&W · A4" per="per side" paise={200} />
            <RateRow label="Colour · A4" per="per side" paise={800} />
            <RateRow label="B&W · A3" per="per side" paise={400} />
            <RateRow label="Photo 4×6" per="per print" paise={1500} />
            <RateRow label="Passport sheet ×8" per="per sheet" paise={2000} />
          </dl>
        </div>
        <div className="tear" aria-hidden />
      </section>

      {offline ? (
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-line bg-card px-6 py-10 text-center shadow-sheet">
          <span className="stamp animate-stamp-in text-xl text-stamp">Temporarily unavailable</span>
          <p className="max-w-[26ch] text-sm text-inksoft">
            This kiosk can&apos;t print right now. Please try again in a few minutes.
          </p>
        </div>
      ) : (
        <>
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.docx,.jpg,.jpeg,.png,application/pdf"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onPick(f);
              e.target.value = '';
            }}
          />
          <button
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="group flex w-full items-center justify-center gap-3 rounded-2xl bg-ink px-6 py-5 text-lg font-bold text-paper shadow-sheet transition-transform active:scale-[0.985] disabled:opacity-60"
          >
            <svg viewBox="0 0 24 24" className="h-6 w-6 transition-transform group-active:-translate-y-0.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 16V4m0 0 5 5m-5-5L7 9" />
              <path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" />
            </svg>
            Upload to print
          </button>
          <p className="pb-2 text-center text-xs text-inksoft">
            PDF · DOCX · JPG · PNG — up to 50MB
            <span className="mx-1.5 text-line">/</span>
            <svg viewBox="0 0 24 24" className="mr-1 inline h-3 w-3 align-[-1px]" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="5" y="11" width="14" height="9" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
            Files auto-delete after printing
          </p>
        </>
      )}
    </div>
  );
}

function RateRow({ label, per, paise }: { label: string; per: string; paise: number }) {
  return (
    <div className="flex items-end">
      <dt>
        {label} <span className="text-xs text-inksoft">({per})</span>
      </dt>
      <span className="dotfill" aria-hidden />
      <dd className="font-display font-semibold">{rupees(paise)}</dd>
    </div>
  );
}

export function CmykDots({ className }: { className?: string }) {
  return (
    <span className={`flex items-center gap-1 ${className ?? ''}`} aria-hidden>
      <span className="h-2 w-2 rounded-full bg-cmyk-c" />
      <span className="h-2 w-2 rounded-full bg-cmyk-m" />
      <span className="h-2 w-2 rounded-full bg-cmyk-y" />
      <span className="h-2 w-2 rounded-full bg-cmyk-k" />
    </span>
  );
}
