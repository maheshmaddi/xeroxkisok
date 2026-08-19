'use client';

import { rupees } from '@print-kiosk/shared';
import { CmykDots } from './Landing';

const STEPS = ['Upload', 'Set up', 'Pay', 'Collect'] as const;

/** Four-dot progress rail — where am I in the flow. */
export function Stepper({ current }: { current: number }) {
  return (
    <ol className="flex items-center justify-between" aria-label="Progress">
      {STEPS.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className="flex flex-1 items-center">
            <div className="flex flex-col items-center gap-1">
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-full border-2 text-[9px] font-bold transition-colors ${
                  done
                    ? 'border-accent bg-accent text-white'
                    : active
                      ? 'animate-breathe border-accent bg-card'
                      : 'border-line bg-card'
                }`}
              >
                {done ? '✓' : i + 1}
              </span>
              <span
                className={`text-[9px] font-bold uppercase tracking-wider ${
                  active ? 'text-ink' : 'text-inksoft/70'
                }`}
              >
                {label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <span className={`mx-1 mb-4 h-0.5 flex-1 rounded-full ${done ? 'bg-accent' : 'bg-line'}`} aria-hidden />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Thumb-reach sticky pay bar with live total. */
export function PayBar({
  totalPaise,
  busy,
  disabled,
  onPay,
}: {
  totalPaise: number | null;
  busy: boolean;
  disabled: boolean;
  onPay: () => void;
}) {
  return (
    <div className="sticky bottom-0 z-20 -mx-4 border-t border-line bg-paper/95 px-4 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-3 backdrop-blur">
      <button
        onClick={onPay}
        disabled={disabled || busy}
        className="flex w-full items-center justify-between rounded-2xl bg-ink px-5 py-4 text-paper shadow-sheet transition-transform active:scale-[0.985] disabled:bg-inksoft/40"
      >
        <span className="flex items-center gap-2 text-[15px] font-bold">
          {busy && (
            <span className="h-4 w-4 animate-tumble rounded-full border-2 border-paper/30 border-t-paper" aria-hidden />
          )}
          {busy ? 'Getting price…' : 'Pay & print'}
        </span>
        <span className="font-display text-2xl font-semibold tabular-nums">
          {totalPaise != null ? rupees(totalPaise) : '—'}
        </span>
      </button>
      <p className="mt-1.5 flex items-center justify-center gap-1 text-[10px] font-medium text-inksoft">
        <CmykDots className="gap-0.5 [&>span]:h-1 [&>span]:w-1" />
        <span className="ml-1">UPI · Cards · Wallets — via Razorpay</span>
      </p>
    </div>
  );
}
