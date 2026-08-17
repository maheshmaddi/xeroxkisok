'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { adminFetch, rupees, STATUS_COLORS } from '../../lib';

interface KioskDetail {
  id: string;
  name: string;
  status: string;
  printerIp: string;
  lastSeenAt: string | null;
  inkLevels: Record<string, number> | null;
  sheetsSinceRefill: number;
  paperCapacity: number;
  paperRemaining: number;
  pricing: { id: string; name: string };
  jobs: {
    id: string; fileName: string; state: string; pages: number;
    priceTotal: number; failReason: string | null; createdAt: string; printedAt: string | null;
  }[];
  consumables: { id: string; type: string; data: Record<string, unknown>; createdAt: string }[];
}

const INK_COLORS: Record<string, string> = {
  black: 'bg-slate-300', cyan: 'bg-cyan-400', magenta: 'bg-fuchsia-400', yellow: 'bg-amber-400',
};

export default function KioskPage() {
  const params = useParams<{ id: string }>();
  const [kiosk, setKiosk] = useState<KioskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setKiosk(await adminFetch<KioskDetail>(`/admin/kiosks/${params.id}`));
      setError(null);
    } catch (err: any) {
      if (err?.message !== 'unauthenticated') setError(err?.message ?? 'Failed to load');
    }
  }, [params.id]);

  useEffect(() => {
    void load();
    const interval = setInterval(load, 10_000);
    return () => clearInterval(interval);
  }, [load]);

  const command = async (type: string) => {
    setBusy(type);
    try {
      await adminFetch(`/admin/kiosks/${params.id}/command`, { method: 'POST', body: JSON.stringify({ type }) });
      await load();
    } catch (err: any) {
      setError(err?.message ?? 'Command failed');
    } finally {
      setBusy(null);
    }
  };

  const refill = async () => {
    setBusy('refill');
    try {
      await adminFetch(`/kiosks/${params.id}/refill`, {
        method: 'POST',
        // Refill endpoint takes kiosk credentials (spec §5); the owner uses the dev secret locally.
        headers: { 'x-kiosk-secret': 'dev-secret-001' },
        body: JSON.stringify({ type: 'PAPER_REFILL' }),
      });
      await load();
    } catch (err: any) {
      setError(err?.message ?? 'Refill failed');
    } finally {
      setBusy(null);
    }
  };

  if (error) return <main className="p-8 text-red-400">{error}</main>;
  if (!kiosk) return <main className="p-8 text-slate-400">Loading…</main>;

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/" className="text-sm text-indigo-400 hover:underline">← Overview</Link>
          <h1 className="mt-1 flex items-center gap-3 text-2xl font-bold">
            {kiosk.id}
            <span className="flex items-center gap-2 text-xs font-medium text-slate-400">
              <span className={`h-2.5 w-2.5 rounded-full ${STATUS_COLORS[kiosk.status] ?? 'bg-slate-500'}`} />
              {kiosk.status}
            </span>
          </h1>
          <div className="text-sm text-slate-400">{kiosk.name} · {kiosk.printerIp} · pricing “{kiosk.pricing.name}”</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void command('test_print')} busy={busy === 'test_print'}>Test print</Button>
          <Button onClick={() => void command(kiosk.status === 'MAINTENANCE' ? 'maintenance_off' : 'maintenance_on')} busy={busy?.startsWith('maintenance')}>
            {kiosk.status === 'MAINTENANCE' ? 'End maintenance' : 'Maintenance mode'}
          </Button>
          <Button onClick={() => void command('reboot_agent')} busy={busy === 'reboot_agent'}>Reboot agent</Button>
          <Button onClick={() => void refill()} busy={busy === 'refill'}>Log paper refill</Button>
        </div>
      </div>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Ink levels</h2>
          {kiosk.inkLevels ? (
            <div className="mt-4 space-y-3">
              {Object.entries(kiosk.inkLevels).map(([color, pct]) => (
                <div key={color}>
                  <div className="flex justify-between text-xs text-slate-400">
                    <span className="capitalize">{color}</span>
                    <span>{pct}%</span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-800">
                    <div className={`h-full ${INK_COLORS[color] ?? 'bg-emerald-500'} ${pct < 20 ? 'animate-pulse' : ''}`} style={{ width: `${pct}%` }} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-sm text-slate-500">No ink data yet — appears after the first agent heartbeats.</p>
          )}
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Paper</h2>
          <div className="mt-4 text-3xl font-bold">~{kiosk.paperRemaining} <span className="text-base font-normal text-slate-400">sheets left</span></div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800">
            <div className={`h-full ${kiosk.paperRemaining < 50 ? 'bg-red-500' : 'bg-emerald-500'}`} style={{ width: `${Math.min(100, (kiosk.paperRemaining / kiosk.paperCapacity) * 100)}%` }} />
          </div>
          <div className="mt-2 text-xs text-slate-500">{kiosk.sheetsSinceRefill} printed since last refill · capacity {kiosk.paperCapacity}</div>
          {kiosk.consumables.length > 0 && (
            <div className="mt-4 space-y-1 text-xs text-slate-500">
              {kiosk.consumables.slice(0, 3).map((c) => (
                <div key={c.id}>{c.type} · {new Date(c.createdAt).toLocaleString()}</div>
              ))}
            </div>
          )}
        </div>
      </div>

      <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-slate-400">Recent jobs</h2>
      <div className="mt-3 overflow-x-auto rounded-2xl border border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-900 text-left text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-4 py-3">File</th><th className="px-4 py-3">State</th>
              <th className="px-4 py-3">Pages</th><th className="px-4 py-3">Amount</th>
              <th className="px-4 py-3">Created</th><th className="px-4 py-3">Note</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {kiosk.jobs.map((j) => (
              <tr key={j.id} className="text-slate-300">
                <td className="max-w-48 truncate px-4 py-2.5">{j.fileName}</td>
                <td className="px-4 py-2.5">{j.state}</td>
                <td className="px-4 py-2.5">{j.pages}</td>
                <td className="px-4 py-2.5">{j.priceTotal ? rupees(j.priceTotal) : '—'}</td>
                <td className="px-4 py-2.5 text-slate-500">{new Date(j.createdAt).toLocaleTimeString()}</td>
                <td className="px-4 py-2.5 text-slate-500">{j.failReason ?? (j.printedAt ? 'printed' : '')}</td>
              </tr>
            ))}
            {kiosk.jobs.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-500">No jobs yet</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}

function Button({ onClick, busy, children }: { onClick: () => void; busy?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={Boolean(busy)}
      className="h-9 rounded-xl border border-slate-700 px-3 text-sm font-medium text-slate-200 transition-colors hover:border-indigo-500 disabled:opacity-50"
    >
      {busy ? '…' : children}
    </button>
  );
}
