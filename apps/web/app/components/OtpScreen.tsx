'use client';

interface JobStatus {
  jobId: string;
  state: string;
  priceTotal?: number;
  otpExpiresAt?: string;
  otpLocked?: boolean;
  failReason?: string | null;
}

/** The waiting room: OTP reveal → keypad instruction → printing → outcome. */
export default function OtpScreen({
  status,
  otp,
  now,
  onReset,
}: {
  status: JobStatus | null;
  otp: string | null;
  now: number;
  onReset: () => void;
}) {
  const state = status?.state;

  if (state === 'COMPLETED') return <Done onReset={onReset} />;
  if (state === 'FAILED' || state === 'REFUNDED' || state === 'EXPIRED') return <Failed state={state} status={status} onReset={onReset} />;
  if (status?.otpLocked) return <Locked onReset={onReset} />;
  if (state === 'PRINTING') return <Printing onReset={onReset} />;

  return <WaitingForKeypad otp={otp} status={status} now={now} />;
}

/* ------------------------------------------------------------------ states */

function WaitingForKeypad({ otp, status, now }: { otp: string | null; status: JobStatus | null; now: number }) {
  const remainingMs = status?.otpExpiresAt ? new Date(status.otpExpiresAt).getTime() - now : 0;
  const totalMs = 30 * 60 * 1000;
  const min = Math.max(0, Math.floor(remainingMs / 60000));
  const sec = Math.max(0, Math.floor((remainingMs % 60000) / 1000));
  const digits = otp ?? '····';

  return (
    <div className="stagger flex flex-1 flex-col justify-center py-8 text-center">
      <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-accent">Step 3 of 3 · Collect</p>
      <h2 className="font-display mt-2 text-3xl font-semibold leading-tight">
        Type this code
        <br />
        on the kiosk keypad
      </h2>

      <div className="mt-8 flex justify-center gap-3">
        {digits.split('').map((d, i) => (
          <div
            key={i}
            className={`flex h-[4.4rem] w-16 items-center justify-center rounded-2xl border text-4xl font-bold tabular-nums shadow-sheet ${
              otp ? 'animate-pop border-accent/30 bg-card text-ink' : 'animate-breathe border-line bg-card/70 text-inksoft'
            }`}
            style={otp ? { animationDelay: `${i * 70}ms` } : undefined}
          >
            {d}
          </div>
        ))}
      </div>

      {/* countdown strip */}
      <div className="mx-auto mt-6 w-full max-w-[260px]">
        <div className="h-1 overflow-hidden rounded-full bg-line">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-1000 ease-linear"
            style={{ width: `${Math.max(0, Math.min(100, (remainingMs / totalMs) * 100))}%` }}
          />
        </div>
        <p className="mt-2 text-xs font-medium text-inksoft">
          {otp ? (
            <>
              valid for{' '}
              <span className="font-display text-sm font-semibold tabular-nums text-ink">
                {min}:{String(sec).padStart(2, '0')}
              </span>
            </>
          ) : (
            'getting your code…'
          )}
        </p>
      </div>

      <p className="mx-auto mt-6 max-w-[32ch] text-sm leading-relaxed text-inksoft">
        Your print starts the moment the kiosk accepts the code. Stay nearby —{' '}
        <span className="font-semibold text-ink">collect it within 30 minutes</span> or the payment auto-refunds.
      </p>
    </div>
  );
}

function Printing({ onReset }: { onReset: () => void }) {
  return (
    <div className="animate-rise flex flex-1 flex-col items-center justify-center py-10 text-center">
      {/* CSS printer: body + slot + looping sheet */}
      <div className="relative h-44 w-48">
        <div className="absolute inset-x-0 top-0 h-20 rounded-t-xl rounded-b-md border border-line bg-card shadow-sheet" />
        <div className="absolute inset-x-4 top-3 h-2 rounded-full bg-ink/10" />
        <div className="absolute right-4 top-8 h-3 w-3 rounded-full bg-leaf" />
        <div className="absolute inset-x-3 top-[4.7rem] h-2 rounded-full bg-ink/15" />
        {/* the printed page */}
        <div className="absolute inset-x-8 top-[5.4rem] h-32 animate-sheet-out overflow-hidden rounded-b-md border border-line border-t-0 bg-card">
          <div className="mx-auto mt-3 w-14 space-y-1.5 pt-2">
            <div className="h-1.5 rounded bg-ink/20" />
            <div className="h-1.5 rounded bg-ink/20" />
            <div className="h-1.5 w-8 rounded bg-accent/50" />
          </div>
        </div>
      </div>
      <h2 className="font-display mt-6 text-3xl font-semibold">Printing…</h2>
      <p className="mt-2 max-w-[30ch] text-sm text-inksoft">
        Sheets land in the tray below the screen. Hang on a second.
      </p>
      <button onClick={onReset} className="mt-8 text-sm font-bold text-accent underline underline-offset-4">
        Print something else
      </button>
    </div>
  );
}

function Done({ onReset }: { onReset: () => void }) {
  return (
    <div className="animate-rise flex flex-1 flex-col items-center justify-center py-10 text-center">
      <span className="stamp animate-stamp-in text-2xl text-leaf">Printed</span>
      <h2 className="font-display mt-8 text-3xl font-semibold">Collect your prints</h2>
      <p className="mt-2 max-w-[30ch] text-sm text-inksoft">
        They&apos;re in the tray below the screen. Take them all!
      </p>
      <div className="mt-6 flex items-center gap-1.5 rounded-full bg-leaf/10 px-3 py-1.5 text-xs font-semibold text-leaf">
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2">
          <rect x="5" y="11" width="14" height="9" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
        Your file was deleted from our servers
      </div>
      <button
        onClick={onReset}
        className="mt-8 rounded-2xl bg-ink px-6 py-3.5 text-base font-bold text-paper shadow-sheet transition-transform active:scale-[0.98]"
      >
        Print another file
      </button>
    </div>
  );
}

function Failed({ state, status, onReset }: { state: string; status: JobStatus | null; onReset: () => void }) {
  const refunded = state !== 'FAILED' || Boolean(status?.priceTotal);
  return (
    <div className="animate-rise flex flex-1 flex-col items-center justify-center py-10 text-center">
      <span className="stamp animate-stamp-in text-xl text-stamp">
        {state === 'EXPIRED' ? 'Code expired' : 'Print failed'}
      </span>
      <h2 className="font-display mt-8 max-w-[20ch] text-3xl font-semibold leading-tight">
        {state === 'EXPIRED' ? 'The 30-minute window passed' : 'Something went wrong at the kiosk'}
      </h2>
      <p className="mt-3 max-w-[34ch] text-sm leading-relaxed text-inksoft">
        {refunded
          ? 'Your payment is being refunded automatically — the amount returns to your account in 3–5 working days.'
          : 'No charge was made for this job.'}
      </p>
      {status?.failReason && (
        <p className="mt-3 rounded-full bg-ink/5 px-3 py-1 text-[11px] font-medium tracking-wide text-inksoft">
          {status.failReason}
        </p>
      )}
      <button
        onClick={onReset}
        className="mt-8 rounded-2xl bg-ink px-6 py-3.5 text-base font-bold text-paper shadow-sheet transition-transform active:scale-[0.98]"
      >
        Try again
      </button>
    </div>
  );
}

function Locked({ onReset }: { onReset: () => void }) {
  return (
    <div className="animate-rise flex flex-1 flex-col items-center justify-center py-10 text-center">
      <span className="stamp animate-stamp-in text-xl text-stamp">Locked</span>
      <h2 className="font-display mt-8 max-w-[22ch] text-3xl font-semibold leading-tight">
        Too many wrong codes
      </h2>
      <p className="mt-3 max-w-[32ch] text-sm leading-relaxed text-inksoft">
        For safety this job is locked. Your payment refunds automatically — or show this screen to the support number
        on the kiosk.
      </p>
      <button
        onClick={onReset}
        className="mt-8 rounded-2xl bg-ink px-6 py-3.5 text-base font-bold text-paper shadow-sheet transition-transform active:scale-[0.98]"
      >
        Start over
      </button>
    </div>
  );
}
