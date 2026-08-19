'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { rupees, type PriceResult } from '@print-kiosk/shared';
import Landing, { CmykDots } from './components/Landing';
import Uploading from './components/Uploading';
import DocumentSettings, { type DocSettings } from './components/DocumentSettings';
import PhotoSettings, { type CropState, type PhotoMode } from './components/PhotoSettings';
import OtpScreen from './components/OtpScreen';
import { PayBar, Stepper } from './components/Chrome';

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
    credentials: 'include',
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
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`));
    xhr.onerror = () => reject(new Error('Network error during upload — check your connection and try again'));
    xhr.send(file);
  });
}

interface RazorpayCheckoutResponse {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

interface RazorpayCheckoutOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description?: string;
  theme?: { color?: string };
  handler: (response: RazorpayCheckoutResponse) => void;
}

type RazorpayCtor = new (options: RazorpayCheckoutOptions) => { open: () => void };

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
  const [isImage, setIsImage] = useState(false);
  const [photoSrc, setPhotoSrc] = useState<string | null>(null);

  const [doc, setDoc] = useState<DocSettings>({ copies: 1, color: false, duplex: false, paperSize: 'A4', pageRange: '' });
  const [photoMode, setPhotoMode] = useState<PhotoMode>('photo4x6');
  const [crop, setCrop] = useState<CropState>({ zoom: 1, offsetX: 0.5, offsetY: 0.35 });

  const [price, setPrice] = useState<PriceResult | null>(null);
  const [pricing, setPricing] = useState(false);
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [otp, setOtp] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  // Boot: read ?kiosk= / resume via ?job=&t= (spec §6 recoverable link)
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
          setPhase('otp');
        } else {
          setPhase('landing');
        }
      })
      .catch(() => {
        setError(`Could not reach the kiosk service. Is the API running at ${API}?`);
        setPhase('landing');
      });
  }, []);

  // Debounced server-side re-pricing on every settings change (spec §5 rule 5).
  // A sequence guard keeps a slow earlier response from overwriting a newer one.
  const priceSeq = useRef(0);
  useEffect(() => {
    if (phase !== 'settings' || !job) return;
    const handle = setTimeout(async () => {
      const seq = ++priceSeq.current;
      setPricing(true);
      setError(null);
      try {
        const body = isImage
          ? { mode: photoMode, copies: doc.copies, ...(photoMode === 'photo4x6' ? { crop } : {}) }
          : {
              mode: 'document',
              copies: doc.copies,
              color: doc.color,
              duplex: doc.duplex,
              paperSize: doc.paperSize,
              pageRange: doc.pageRange.trim() === '' ? null : doc.pageRange.trim(),
            };
        const result = await api<PriceResult>(`/jobs/${job.jobId}/price`, { method: 'POST', token: job.token, body: JSON.stringify(body) });
        if (seq === priceSeq.current) setPrice(result);
      } catch (err: any) {
        if (seq === priceSeq.current) {
          setError(err?.message ?? 'Could not compute the price');
          setPrice(null);
        }
      } finally {
        if (seq === priceSeq.current) setPricing(false);
      }
    }, 320);
    return () => clearTimeout(handle);
  }, [phase, job, doc, isImage, photoMode, crop]);

  // Poll status on the OTP screen (also resumes after reload)
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
        setError('That file is larger than 50MB — pick a smaller one.');
        return;
      }
      setFileName(file.name);
      setIsImage(file.type.startsWith('image/'));
      setPhotoSrc(file.type.startsWith('image/') ? URL.createObjectURL(file) : null);
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
        const processed = await api<{ pages: number }>(`/jobs/${created.jobId}/process`, { method: 'POST', token });

        // Job identity in the URL: reopening this link recovers the status page.
        const sp = new URLSearchParams(window.location.search);
        sp.set('job', created.jobId);
        sp.set('t', token);
        window.history.replaceState(null, '', `?${sp.toString()}`);

        setJob({ jobId: created.jobId, token });
        setPages(processed.pages);
        setPhase('settings');
      } catch (err: any) {
        setError(err?.message ?? 'Upload failed — please try again');
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
          setError('Could not load the payment window — check your connection and retry.');
          return;
        }
        const rzp = new RazorpayCtor({
          key: res.keyId,
          order_id: res.orderId,
          amount: res.amountPaise,
          currency: 'INR',
          name: 'Print Kiosk',
          description: fileName,
          theme: { color: '#1C2434' },
          handler: (response) => {
            // Localhost can't receive webhooks — confirm the checkout
            // signature directly; webhooks remain the production safety net.
            void (async () => {
              try {
                await api(`/jobs/${job.jobId}/pay/confirm`, {
                  method: 'POST',
                  token: job.token,
                  body: JSON.stringify({
                    razorpay_order_id: response.razorpay_order_id,
                    razorpay_payment_id: response.razorpay_payment_id,
                    razorpay_signature: response.razorpay_signature,
                  }),
                });
                setPhase('otp');
              } catch (err: any) {
                setError(err?.message ?? 'Payment confirmation failed — if you were charged, the refund is automatic.');
              }
            })();
          },
        });
        rzp.open();
      } else {
        setPhase('otp'); // mock pay captured server-side
      }
    } catch (err: any) {
      setError(err?.message ?? 'Payment failed');
    }
  }, [job, fileName]);

  const reset = useCallback(() => {
    const sp = new URLSearchParams(window.location.search);
    sp.delete('job');
    sp.delete('t');
    window.history.replaceState(null, '', `?${sp.toString()}`);
    setJob(null);
    setStatus(null);
    setOtp(null);
    setPrice(null);
    setPages(0);
    setFileName('');
    setPhotoSrc(null);
    setDoc({ copies: 1, color: false, duplex: false, paperSize: 'A4', pageRange: '' });
    setCrop({ zoom: 1, offsetX: 0.5, offsetY: 0.35 });
    setPhase('landing');
  }, []);

  const stepIndex = phase === 'loading' || phase === 'landing' || phase === 'uploading' ? 0 : phase === 'settings' ? 1 : 2;
  const terminal = status && ['COMPLETED', 'FAILED', 'REFUNDED', 'EXPIRED'].includes(status.state);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 pb-3 pt-5">
      {/* Chrome */}
      <header className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CmykDots className="gap-[3px]" />
          <span className="font-display text-lg font-semibold tracking-tight">PrintKiosk</span>
        </div>
        {kiosk && (
          <span className="flex items-center gap-1.5 rounded-full border border-line bg-card px-2.5 py-1 text-[11px] font-bold text-inksoft">
            <span className={`h-1.5 w-1.5 rounded-full ${kiosk.status === 'ONLINE' ? 'bg-leaf' : 'bg-stamp'}`} />
            {kiosk.id}
          </span>
        )}
      </header>
      {!terminal && (
        <div className="mb-5 px-2">
          <Stepper current={stepIndex} />
        </div>
      )}

      {error && (
        <div className="mb-4 flex items-start gap-2.5 rounded-2xl border border-stamp/30 bg-stamp/[0.07] px-4 py-3 text-sm text-stamp">
          <svg viewBox="0 0 24 24" className="mt-0.5 h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v4m0 4h.01" />
          </svg>
          {error}
        </div>
      )}

      {phase === 'loading' && (
        <div className="flex flex-1 items-center justify-center">
          <div className="flex gap-1.5">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="h-2.5 w-2.5 animate-breathe rounded-full bg-ink/30" style={{ animationDelay: `${i * 150}ms` }} />
            ))}
          </div>
        </div>
      )}

      {phase === 'landing' && <Landing kiosk={kiosk} onPick={(f) => void startUpload(f)} busy={false} />}
      {phase === 'uploading' && <Uploading fileName={fileName} progress={progress} />}

      {phase === 'settings' && job && (
        <div className="flex flex-1 flex-col">
          <div className="mb-4 flex items-center justify-between rounded-2xl border border-line bg-card px-4 py-3 shadow-sheet">
            <div className="min-w-0">
              <p className="truncate text-[15px] font-semibold">{fileName}</p>
              <p className="text-xs text-inksoft">
                {isImage ? 'Photo' : `${pages} page${pages > 1 ? 's' : ''} detected`}
              </p>
            </div>
            <span className="font-display shrink-0 text-2xl font-semibold text-accent">
              {isImage ? '4×6' : pages > 0 ? `p.${pages}` : ''}
            </span>
          </div>

          {isImage ? (
            <PhotoSettings
              mode={photoMode}
              onMode={setPhotoMode}
              copies={doc.copies}
              onCopies={(n) => setDoc((s) => ({ ...s, copies: n }))}
              crop={crop}
              onCrop={setCrop}
              photoSrc={photoSrc}
            />
          ) : (
            <DocumentSettings settings={doc} onChange={setDoc} pages={pages} />
          )}

          {/* live receipt */}
          {price && (
            <div className="mt-5 rounded-2xl border border-line bg-card px-4 py-3 shadow-sheet">
              {price.lines.map((line) => (
                <div key={line.label} className="flex items-end text-sm">
                  <span className="max-w-[70%]">{line.label}</span>
                  <span className="dotfill" aria-hidden />
                  <span className="font-display font-semibold">{rupees(line.totalPaise)}</span>
                </div>
              ))}
            </div>
          )}

          <div className="flex-1" />
          <PayBar
            totalPaise={price?.totalPaise ?? null}
            busy={pricing}
            disabled={!price}
            onPay={() => void pay()}
          />
        </div>
      )}

      {phase === 'otp' && <OtpScreen status={status} otp={otp} now={now} onReset={reset} />}
    </main>
  );
}
