'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { rupees, type PriceResult } from '@print-kiosk/shared';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const MAX_FILE_BYTES = 50 * 1024 * 1024;

type Phase = 'loading' | 'landing' | 'uploading' | 'settings' | 'otp';

interface KioskInfo {
  id: string;
  name: string;
  status: string;
}

interface JobRef {
  jobId: string;
  token: string;
}

interface Settings {
  copies: number;
  color: boolean;
  duplex: boolean;
  paperSize: 'A4' | 'A3';
  pageRange: string;
}

interface JobStatus {
  jobId: string;
  state: string;
  pages: number;
  otp?: string;
  otpExpiresAt?: string;
  otpLocked?: boolean;
  failReason?: string | null;
  printedAt?: string | null;
  priceTotal?: number;
}

async function api<T>(path: string, init?: RequestInit & { token?: string }): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.token ? { 'x-job-token': init.token } : {}),
      ...init?.headers,
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.message ?? `Request failed (${res.status})`);
  return body;
}

function uploadWithProgress(url: string, file: File, onProgress: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed (${xhr.status})`));
    xhr.onerror = () => reject(new Error('Network error during upload — check your connection and retry'));
    xhr.send(file);
  });
}

interface RazorpayCheckoutOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description?: string;
  theme?: { color?: string };
  handler: () => void;
}

type RazorpayCtor = new (options: RazorpayCheckoutOptions) => { open: () => void };

/** Loads https://checkout.razorpay.com/v1/checkout.js once; undefined on failure. */
async function loadRazorpayCheckout(): Promise<RazorpayCtor | undefined> {
  const w = window as unknown as { Razorpay?: RazorpayCtor };
  if (w.Razorpay) return w.Razorpay;
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('checkout script failed'));
    document.head.appendChild(script);
  }).catch(() => undefined);
  return w.Razorpay;
}

export default function Page() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [kiosk, setKiosk] = useState<KioskInfo | null>(null);
  const [job, setJob] = useState<JobRef | null>(null);
  const [fileName, setFileName] = useState('');
  const [pages, setPages] = useState(0);
  const [progress, setProgress] = useState(0);
  const [settings, setSettings] = useState<Settings>({ copies: 1, color: false, duplex: false, paperSize: 'A4', pageRange: '' });
  const [price, setPrice] = useState<PriceResult | null>(null);
  const [pricing, setPricing] = useState(false);
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [otp, setOtp] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Boot: read URL params (?kiosk=K001, or ?job=…&t=… to resume a job's status page)
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const kioskId = sp.get('kiosk') ?? 'K001';
    const resumeJob = sp.get('job');
    const resumeToken = sp.get('t');

    api<KioskInfo>(`/kiosks/${encodeURIComponent(kioskId)}/info`)
      .then((info) => {
        setKiosk(info);
        if (resumeJob && resumeToken) {
          setJob({ jobId: resumeJob, token: resumeToken });
          setPhase('otp'); // spec §6: recoverable via link in the page URL
        } else {
          setPhase('landing');
        }
      })
      .catch(() => {
        setError(`Could not reach the kiosk service. Is the API running at ${API}?`);
        setPhase('landing');
      });
  }, []);

  // Debounced server-side re-pricing whenever settings change (spec §5 rule 5)
  useEffect(() => {
    if (phase !== 'settings' || !job) return;
    const handle = setTimeout(async () => {
      setPricing(true);
      setError(null);
      try {
        const result = await api<PriceResult>(`/jobs/${job.jobId}/price`, {
          method: 'POST',
          token: job.token,
          body: JSON.stringify({
            mode: 'document',
            copies: settings.copies,
            color: settings.color,
            duplex: settings.duplex,
            paperSize: settings.paperSize,
            pageRange: settings.pageRange.trim() === '' ? null : settings.pageRange.trim(),
          }),
        });
        setPrice(result);
      } catch (err: any) {
        setError(err?.message ?? 'Could not compute price');
        setPrice(null);
      } finally {
        setPricing(false);
      }
    }, 350);
    return () => clearTimeout(handle);
  }, [phase, job, settings]);

  // Poll job status on the OTP screen (also resumes after a page reload)
  useEffect(() => {
    if (phase !== 'otp' || !job) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const st = await api<JobStatus>(`/jobs/${job.jobId}/status`, { token: job.token });
        if (cancelled) return;
        setStatus(st);
        if (st.otp) setOtp(st.otp);
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? 'Lost contact with the kiosk service');
      }
    };

    void poll();
    const interval = setInterval(poll, 3000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
      clearInterval(tick);
    };
  }, [phase, job]);

  const startUpload = useCallback(
    async (file: File) => {
      setError(null);
      if (file.size > MAX_FILE_BYTES) {
        setError('That file is larger than 50MB.');
        return;
      }
      setFileName(file.name);
      setPhase('uploading');
      setProgress(0);
      try {
        const created = await api<{ jobId: string; upload: { url: string } }>('/jobs', {
          method: 'POST',
          body: JSON.stringify({ kioskId: kiosk!.id, fileName: file.name }),
        });
        const token = new URL(created.upload.url).searchParams.get('token');
        if (!token) throw new Error('Upload link was malformed');

        await uploadWithProgress(created.upload.url, file, setProgress);

        const processed = await api<{ pages: number }>(`/jobs/${created.jobId}/process`, {
          method: 'POST',
          token,
        });

        // Put the job identity in the URL so a refresh/reopen can recover it (spec §6)
        const sp = new URLSearchParams(window.location.search);
        sp.set('job', created.jobId);
        sp.set('t', token);
        window.history.replaceState(null, '', `?${sp.toString()}`);

        setJob({ jobId: created.jobId, token });
        setPages(processed.pages);
        setPhase('settings');
      } catch (err: any) {
        setError(err?.message ?? 'Upload failed');
        setPhase('landing');
      }
    },
    [kiosk],
  );

  const pay = useCallback(async () => {
    if (!job) return;
    setError(null);
    try {
      const res = await api<{ mode: 'mock' | 'razorpay'; jobId: string; state?: string; orderId?: string; keyId?: string; amountPaise?: number }>(
        `/jobs/${job.jobId}/pay`,
        { method: 'POST', token: job.token },
      );
      if (res.mode === 'razorpay' && res.orderId && res.keyId && typeof res.amountPaise === 'number') {
        const RazorpayCtor = await loadRazorpayCheckout();
        if (!RazorpayCtor) {
          setError('Could not load the payment window. Check your connection and retry.');
          return;
        }
        const rzp = new RazorpayCtor({
          key: res.keyId,
          order_id: res.orderId,
          amount: res.amountPaise,
          currency: 'INR',
          name: 'Print Kiosk',
          description: fileName,
          theme: { color: '#4f46e5' },
          handler: () => setPhase('otp'), // capture is confirmed by the webhook; polling picks it up
        });
        rzp.open();
      } else {
        // Phase 1 mock pay — capture already happened server-side.
        setPhase('otp');
      }
    } catch (err: any) {
      setError(err?.message ?? 'Payment failed');
    }
  }, [job, fileName]);

  const kioskUnavailable = kiosk && kiosk.status !== 'ONLINE';

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 pb-10 pt-6">
      <header className="mb-6">
        <div className="text-xs font-semibold uppercase tracking-widest text-indigo-600">Print Kiosk</div>
        <h1 className="mt-1 text-xl font-bold">{kiosk?.name ?? '…'}</h1>
        {kiosk && (
          <div className={`mt-1 text-sm ${kiosk.status === 'ONLINE' ? 'text-emerald-600' : 'text-slate-500'}`}>
            {kiosk.status === 'ONLINE' ? '● Online' : `● ${kiosk.status.toLowerCase()}`}
          </div>
        )}
      </header>

      {error && (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {error}
        </div>
      )}

      {phase === 'loading' && <p className="text-slate-500">Loading…</p>}

      {phase === 'landing' && (
        <section className="rounded-2xl bg-white p-5 shadow-sm">
          {kioskUnavailable ? (
            <>
              <h2 className="text-lg font-semibold">This kiosk is temporarily unavailable</h2>
              <p className="mt-2 text-sm text-slate-600">Please try again in a few minutes.</p>
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold">Print from your phone</h2>
              <p className="mt-2 text-sm text-slate-600">
                PDF, DOCX, JPG or PNG up to 50MB. Pay securely, get a 4-digit code, type it on the kiosk keypad and
                collect your prints. Files are deleted right after printing.
              </p>
              <div className="mt-4 rounded-xl bg-slate-50 p-4 text-sm">
                <div className="flex justify-between"><span>B&W A4</span><span>₹2 / side</span></div>
                <div className="mt-1 flex justify-between"><span>Color A4</span><span>₹8 / side</span></div>
                <div className="mt-1 flex justify-between text-slate-500"><span>B&W A3</span><span>₹4 / side</span></div>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx,.jpg,.jpeg,.png,application/pdf"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void startUpload(f);
                  e.target.value = '';
                }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="mt-5 w-full rounded-xl bg-indigo-600 py-3.5 text-base font-semibold text-white shadow-sm active:bg-indigo-700"
              >
                Upload to print
              </button>
            </>
          )}
        </section>
      )}

      {phase === 'uploading' && (
        <section className="rounded-2xl bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">Uploading {fileName}</h2>
          <div className="mt-4 h-2.5 w-full overflow-hidden rounded-full bg-slate-200">
            <div className="h-full rounded-full bg-indigo-600 transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <p className="mt-2 text-sm text-slate-500">{Math.round(progress * 100)}% — keep this page open</p>
        </section>
      )}

      {phase === 'settings' && (
        <section className="space-y-4">
          <div className="rounded-2xl bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">{fileName}</h2>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium">{pages} pages</span>
            </div>

            <label className="mt-4 block text-sm font-medium text-slate-700">Copies (1–50)</label>
            <div className="mt-1 flex items-center gap-3">
              <button className="h-10 w-10 rounded-xl bg-slate-100 text-lg font-bold" onClick={() => setSettings((s) => ({ ...s, copies: Math.max(1, s.copies - 1) }))}>−</button>
              <input
                className="h-10 w-16 rounded-xl border border-slate-300 text-center text-base font-semibold"
                type="number" min={1} max={50} value={settings.copies}
                onChange={(e) => setSettings((s) => ({ ...s, copies: Math.min(50, Math.max(1, Number(e.target.value) || 1)) }))}
              />
              <button className="h-10 w-10 rounded-xl bg-slate-100 text-lg font-bold" onClick={() => setSettings((s) => ({ ...s, copies: Math.min(50, s.copies + 1) }))}>+</button>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3">
              <Toggle label="Color" active={settings.color} onClick={() => setSettings((s) => ({ ...s, color: !s.color }))} />
              <Toggle label="Duplex" active={settings.duplex} onClick={() => setSettings((s) => ({ ...s, duplex: !s.duplex }))} />
              <Toggle label="A4" active={settings.paperSize === 'A4'} onClick={() => setSettings((s) => ({ ...s, paperSize: 'A4' }))} />
              <Toggle label="A3" active={settings.paperSize === 'A3'} onClick={() => setSettings((s) => ({ ...s, paperSize: 'A3' }))} />
            </div>

            <label className="mt-4 block text-sm font-medium text-slate-700">Pages (blank = all)</label>
            <input
              className="mt-1 h-11 w-full rounded-xl border border-slate-300 px-3 text-base"
              placeholder="e.g. 1-3,7" value={settings.pageRange}
              onChange={(e) => setSettings((s) => ({ ...s, pageRange: e.target.value }))}
            />
          </div>

          <div className="rounded-2xl bg-white p-5 shadow-sm">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Live price</h3>
            {price ? (
              <>
                {price.lines.map((line) => (
                  <div key={line.label} className="mt-2">
                    <div className="text-sm text-slate-700">{line.label}</div>
                    <div className="text-sm text-slate-500">{rupees(line.unitPaise)} × {line.qty} side(s)</div>
                  </div>
                ))}
                <div className="mt-3 flex items-baseline justify-between border-t border-slate-100 pt-3">
                  <span className="font-semibold">Total</span>
                  <span className={`text-2xl font-bold ${pricing ? 'opacity-50' : ''}`}>{rupees(price.totalPaise)}</span>
                </div>
              </>
            ) : (
              <p className="mt-2 text-sm text-slate-500">{pricing ? 'Computing…' : 'Set your options to see the price.'}</p>
            )}
            <button
              onClick={() => void pay()}
              disabled={!price || pricing}
              className="mt-4 w-full rounded-xl bg-indigo-600 py-3.5 text-base font-semibold text-white shadow-sm active:bg-indigo-700 disabled:bg-slate-300"
            >
              Pay {price ? rupees(price.totalPaise) : ''} (mock — Phase 1)
            </button>
            <p className="mt-2 text-center text-xs text-slate-400">UPI checkout via Razorpay arrives in Phase 2</p>
          </div>
        </section>
      )}

      {phase === 'otp' && <OtpScreen status={status} otp={otp} now={now} />}
    </main>
  );
}

function Toggle({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`h-11 rounded-xl border text-sm font-semibold transition-colors ${
        active ? 'border-indigo-600 bg-indigo-50 text-indigo-700' : 'border-slate-300 bg-white text-slate-600'
      }`}
    >
      {label}
    </button>
  );
}

function OtpScreen({ status, otp, now }: { status: JobStatus | null; otp: string | null; now: number }) {
  const state = status?.state;
  const remainingMs = status?.otpExpiresAt ? new Date(status.otpExpiresAt).getTime() - now : 0;
  const remainingMin = Math.max(0, Math.floor(remainingMs / 60000));
  const remainingSec = Math.max(0, Math.floor((remainingMs % 60000) / 1000));

  if (state === 'COMPLETED') {
    return (
      <section className="rounded-2xl bg-white p-6 text-center shadow-sm">
        <div className="text-5xl">🎉</div>
        <h2 className="mt-3 text-xl font-bold">Done! Collect your prints</h2>
        <p className="mt-2 text-sm text-slate-500">Your file has been deleted from our servers.</p>
      </section>
    );
  }

  if (state === 'FAILED' || state === 'EXPIRED') {
    return (
      <section className="rounded-2xl bg-white p-6 text-center shadow-sm">
        <div className="text-4xl">{state === 'FAILED' ? '⚠️' : '⌛'}</div>
        <h2 className="mt-3 text-lg font-bold">{state === 'FAILED' ? 'Printing failed' : 'Code expired'}</h2>
        <p className="mt-2 text-sm text-slate-600">
          {state === 'FAILED'
            ? 'Your payment has been refunded automatically — the amount returns in 3–5 days.'
            : 'The 30-minute collection window passed. Your payment has been refunded automatically.'}
        </p>
        {status?.failReason && <p className="mt-2 text-xs text-slate-400">Reason: {status.failReason}</p>}
      </section>
    );
  }

  if (status?.otpLocked) {
    return (
      <section className="rounded-2xl bg-white p-6 text-center shadow-sm">
        <div className="text-4xl">🔒</div>
        <h2 className="mt-3 text-lg font-bold">Too many wrong attempts</h2>
        <p className="mt-2 text-sm text-slate-600">The job is locked. Please contact support for help.</p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl bg-white p-6 text-center shadow-sm">
      {state === 'PRINTING' ? (
        <>
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-indigo-200 border-t-indigo-600" />
          <h2 className="mt-4 text-lg font-bold">Printing…</h2>
          <p className="mt-1 text-sm text-slate-500">Collect your prints from the tray below the screen.</p>
        </>
      ) : (
        <>
          <h2 className="text-lg font-bold">Enter this code on the kiosk keypad</h2>
          <div className="mt-5 flex justify-center gap-3">
            {(otp ?? '••••').split('').map((digit, i) => (
              <div key={i} className="flex h-16 items-center justify-center rounded-2xl bg-indigo-50 text-3xl font-bold text-indigo-700" style={{ width: '3.25rem' }}>
                {digit}
              </div>
            ))}
          </div>
          <p className="mt-4 text-sm text-slate-500">
            {otp ? (
              <>Expires in <span className="font-semibold text-slate-700 tabular-nums">{remainingMin}:{String(remainingSec).padStart(2, '0')}</span></>
            ) : (
              'Retrieving your code…'
            )}
          </p>
          <p className="mt-1 text-xs text-slate-400">Waiting for the kiosk — keep this page open.</p>
        </>
      )}
    </section>
  );
}
