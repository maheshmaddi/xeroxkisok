'use client';

import { useState } from 'react';
import { API } from '../lib';

export default function LoginPage() {
  const [email, setEmail] = useState('admin@local');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API}/admin/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? 'Login failed');
      }
      window.location.href = '/';
    } catch (err: any) {
      setError(err?.message ?? 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
      <h1 className="text-2xl font-bold">Print Kiosk Admin</h1>
      <p className="mt-1 text-sm text-slate-400">Owner sign-in</p>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <div>
          <label className="text-sm font-medium text-slate-300">Email</label>
          <input
            className="mt-1 h-11 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-slate-100"
            value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username"
          />
        </div>
        <div>
          <label className="text-sm font-medium text-slate-300">Password</label>
          <input
            type="password"
            className="mt-1 h-11 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-slate-100"
            value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password"
          />
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          disabled={busy || !password}
          className="h-11 w-full rounded-xl bg-indigo-600 font-semibold text-white disabled:bg-slate-700"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
