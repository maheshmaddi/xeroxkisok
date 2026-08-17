'use client';

export const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export async function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (res.status === 401 && typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
    window.location.href = '/login';
    throw new Error('unauthenticated');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.message ?? `Request failed (${res.status})`);
  return body;
}

export function rupees(paise: number): string {
  return `₹${(paise / 100).toFixed(paise % 100 === 0 ? 0 : 2)}`;
}

export const STATUS_COLORS: Record<string, string> = {
  ONLINE: 'bg-emerald-500',
  OFFLINE: 'bg-slate-500',
  ERROR: 'bg-red-500',
  MAINTENANCE: 'bg-amber-500',
};
