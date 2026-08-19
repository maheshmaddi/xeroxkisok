'use client';

/** Upload progress: a sheet filling with ink, big percentage, keep-open note. */
export default function Uploading({ fileName, progress }: { fileName: string; progress: number }) {
  const pct = Math.round(progress * 100);
  return (
    <div className="stagger flex flex-1 flex-col justify-center space-y-6 py-10">
      <div className="relative mx-auto w-44">
        {/* Paper sheet with a folded corner */}
        <div className="relative h-56 overflow-hidden rounded-lg border border-line bg-card shadow-sheet">
          <div
            className="absolute inset-x-0 bottom-0 bg-accent/90 transition-[height] duration-300 ease-out"
            style={{ height: `${pct}%` }}
          />
          {/* fold */}
          <div className="absolute right-0 top-0 h-8 w-8 bg-paper" style={{ clipPath: 'polygon(100% 0, 0 0, 100% 100%)' }} />
          <div className="absolute inset-x-0 top-2 mx-auto w-10 border-t-2 border-line" />
          <div className="absolute inset-x-0 top-4 mx-auto w-10 border-t-2 border-line" />
        </div>
        <p className="font-display mt-4 text-center text-5xl font-semibold tabular-nums">{pct}%</p>
      </div>

      <div className="text-center">
        <h2 className="font-display text-xl font-semibold">Sending to the kiosk…</h2>
        <p className="mx-auto mt-1 max-w-[30ch] truncate text-sm text-inksoft">{fileName}</p>
        <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-ink/5 px-3 py-1 text-xs font-medium text-inksoft">
          <span className="h-1.5 w-1.5 animate-breathe rounded-full bg-accent" />
          Keep this page open
        </p>
      </div>
    </div>
  );
}
