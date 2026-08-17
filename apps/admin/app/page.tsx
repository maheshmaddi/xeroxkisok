'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { adminFetch, rupees, STATUS_COLORS } from './lib';

interface Overview {
  jobsToday: number;
  jobsWeek: number;
  revenueTodayPaise: number;
  revenueWeekPaise: number;
  failureRateToday: number;
  kiosks: {
    id: string;
    name: string;
    status: string;
    lastSeenAt: string | null;
    inkLevels: Record<string, number> | null;
    paperRemaining: number;
  }[];
  revenueByDay: { day: string; paise: number }[];
}

export default function Page() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await adminFetch<Overview>('/admin/overview'));
      setError(null);
    } catch (err: any) {
      if (err?.message !== 'unauthenticated') setError(err?.message ?? 'Failed to load');
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = setInterval(load, 10_000);
    return () => clearInterval(interval);
  }, [load]);

  const logout = async () => {
    await adminFetch('/admin/logout', { method: 'POST' }).catch(() => undefined);
    window.location.href = '/login';
  };

  if (error) return <main className="p-8 text-red-400">{error}</main>;
  if (!data) return <main className="p-8 text-slate-400">Loading…</main>;

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Overview</h1>
        <div className="flex items-center gap-4 text-sm">
          <Link href="/refunds" className="text-indigo-400 hover:underline">Refunds</Link>
          <button onClick={() => void logout()} className="text-slate-400 hover:text-slate-200">Sign out</button>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Revenue today" value={rupees(data.revenueTodayPaise)} />
        <Stat label="Revenue (7d)" value={rupees(data.revenueWeekPaise)} />
        <Stat label="Jobs today" value={String(data.jobsToday)} sub={`${data.jobsWeek} this week`} />
        <Stat
          label="Failure rate today"
          value={`${(data.failureRateToday * 100).toFixed(0)}%`}
          tone={data.failureRateToday > 0.2 ? 'text-red-400' : 'text-emerald-400'}
        />
      </div>

      <div className="mt-8 rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Revenue — last 7 days</h2>
        <div className="mt-3 h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.revenueByDay.map((d) => ({ ...d, rupees: d.paise / 100 }))}>
              <CartesianGrid stroke="#1e293b" vertical={false} />
              <XAxis dataKey="day" stroke="#64748b" fontSize={12} tickLine={false} />
              <YAxis stroke="#64748b" fontSize={12} tickLine={false} />
              <Tooltip
                cursor={{ fill: '#1e293b' }}
                contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 12 }}
                formatter={(value: number) => [`₹${value}`, 'Revenue']}
              />
              <Bar dataKey="rupees" fill="#6366f1" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-slate-400">Kiosks</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {data.kiosks.map((k) => (
          <Link
            key={k.id}
            href={`/kiosks/${k.id}`}
            className="rounded-2xl border border-slate-800 bg-slate-900 p-4 transition-colors hover:border-indigo-600"
          >
            <div className="flex items-center justify-between">
              <span className="font-semibold">{k.id}</span>
              <span className="flex items-center gap-2 text-xs text-slate-400">
                <span className={`h-2.5 w-2.5 rounded-full ${STATUS_COLORS[k.status] ?? 'bg-slate-500'}`} />
                {k.status}
              </span>
            </div>
            <div className="mt-1 text-sm text-slate-400">{k.name}</div>
            <div className="mt-3 flex gap-1">
              {k.inkLevels &&
                Object.entries(k.inkLevels).map(([color, pct]) => (
                  <div key={color} className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800" title={`${color} ${pct}%`}>
                    <div
                      className={`h-full ${pct < 20 ? 'bg-red-500' : 'bg-emerald-500'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                ))}
            </div>
            <div className="mt-2 text-xs text-slate-500">~{k.paperRemaining} sheets left</div>
          </Link>
        ))}
      </div>
    </main>
  );
}

function Stat({ label, value, sub, tone = 'text-slate-100' }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${tone}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  );
}
