import type { Metadata, Viewport } from 'next';
import { Fraunces, Figtree } from 'next/font/google';
import './globals.css';

const fraunces = Fraunces({
  subsets: ['latin'],
  variable: '--font-fraunces',
  axes: ['SOFT', 'WONK', 'opsz'],
});

const figtree = Figtree({
  subsets: ['latin'],
  variable: '--font-figtree',
});

export const metadata: Metadata = {
  title: 'Print Kiosk',
  description: 'Scan, upload, pay, print — no app needed',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#FAF6EF',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${figtree.variable}`}>
      <body className="grain min-h-dvh bg-paper font-body text-ink antialiased">
        {children}
        {/* Print registration marks — quiet corner detail. */}
        <RegMark className="left-2 top-2" />
        <RegMark className="right-2 top-2" />
        <RegMark className="bottom-2 left-2" />
        <RegMark className="bottom-2 right-2" />
      </body>
    </html>
  );
}

function RegMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={`pointer-events-none fixed z-30 h-4 w-4 text-line ${className ?? ''}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <circle cx="12" cy="12" r="5" />
      <path d="M12 1v6M12 17v6M1 12h6M17 12h6" />
    </svg>
  );
}
