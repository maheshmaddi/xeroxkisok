'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { adminFetch, rupees } from '../lib';

interface RefundRow {
  jobId: string;
  fileName: string;
  kiosk: { id: string; name: string };
  state: string;
  failReason: string | null;
  amount: number;
  paymentStatus: string;
  refundId: string | null;
  createdAt: string;
}

export default function RefundsPage() {
  const [rows, setRows] = useState<RefundRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await adminFetch<RefundRow[]>('/admin/refunds'));
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

  const refund = async (jobId: string) => {
    try {
      await adminFetch(`/admin/jobs/${jobId}/refund`, { method: 'POST' });
      await load();
    } catch (err: any) {
      setError(err?.message ?? 'Refund failed');
    }
  };

  if (error) return <main className="p-8 text-red-400">{error}</main>;
  if (!rows) return <main className="p-8 text-slate-400">Loading…</main>;

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/" className="text-sm text-indigo-400 hover:underline">← Overview</Link>
          <h1 className="mt-1 text-2xl font-bold">Failed & refunded jobs</h1>
        </div>
      </div>

      <div className="mt-6 overflow-x-auto rounded-2xl border border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-900 text-left text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-4 py-3">File</th><th className="px-4 py-3">Kiosk</th>
              <th className="px-4 py-3">State</th><th className="px-4 py-3">Amount</th>
              <th className="px-4 py-3">Payment</th><th className="px-4 py-3">Reason</th>
              <th className="px-4 py-3">Created</th><th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {rows.map((r) => (
              <tr key={r.jobId} className="text-slate-300">
                <td className="max-w-48 truncate px-4 py-2.5">{r.fileName}</td>
                <td className="px-4 py-2.5">{r.kiosk.id}</td>
                <td className="px-4 py-2.5">{r.state}</td>
                <td className="px-4 py-2.5">{r.amount ? rupees(r.amount) : '—'}</td>
                <td className="px-4 py-2.5">{r.paymentStatus}</td>
                <td className="px-4 py-2.5 text-slate-500">{r.failReason ?? '—'}</td>
                <td className="px-4 py-2.5 text-slate-500">{new Date(r.createdAt).toLocaleString()}</td>
                <td className="px-4 py-2.5">
                  {r.paymentStatus === 'captured' && (
                    <button
                      onClick={() => void refund(r.jobId)}
                      className="rounded-lg border border-amber-600 px-2.5 py-1 text-xs font-medium text-amber-400 hover:bg-amber-950"
                    >
                      Refund
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-6 text-center text-slate-500">Nothing to show — no failed or refunded jobs 🎉</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
