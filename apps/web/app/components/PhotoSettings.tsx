'use client';

import { useRef } from 'react';
import { Stepper } from './DocumentSettings';

export interface CropState {
  zoom: number;
  offsetX: number;
  offsetY: number;
}

export type PhotoMode = 'photo4x6' | 'passport';

/** Photo settings: 4×6 (with crop) or passport ×8 sheet, plus copies. */
export default function PhotoSettings({
  mode,
  onMode,
  copies,
  onCopies,
  crop,
  onCrop,
  photoSrc,
}: {
  mode: PhotoMode;
  onMode: (m: PhotoMode) => void;
  copies: number;
  onCopies: (n: number) => void;
  crop: CropState;
  onCrop: (c: CropState) => void;
  photoSrc: string | null;
}) {
  return (
    <div className="animate-rise space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <ModeCard
          active={mode === 'photo4x6'}
          onClick={() => onMode('photo4x6')}
          title="4×6 Photo"
          sub="Full-bleed print"
          icon={<svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="11" r="2" /><path d="m3 17 5-4 4 3 3-2 6 5" /></svg>}
        />
        <ModeCard
          active={mode === 'passport'}
          onClick={() => onMode('passport')}
          title="Passport ×8"
          sub="35×45mm each"
          icon={
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="4" y="3" width="7" height="8" rx="1" />
              <rect x="13" y="3" width="7" height="8" rx="1" />
              <rect x="4" y="13" width="7" height="8" rx="1" />
              <rect x="13" y="13" width="7" height="8" rx="1" />
            </svg>
          }
        />
      </div>

      {mode === 'photo4x6' && photoSrc ? (
        <CropEditor src={photoSrc} crop={crop} onChange={onCrop} />
      ) : (
        <div className="rounded-2xl border border-line bg-card p-4 shadow-sheet">
          <p className="text-sm font-semibold">What you&apos;ll get</p>
          {mode === 'passport' ? (
            <>
              <p className="mt-1 text-[13px] leading-relaxed text-inksoft">
                One 4×6 sheet with <strong className="text-ink">8 identical passport photos</strong> (35×45mm, white
                spacing) — cut them apart at home. Face is auto-framed.
              </p>
              <div className="mt-3 grid w-full max-w-[220px] grid-cols-4 gap-1.5 rounded-lg bg-paper p-2">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="aspect-[7/9] animate-pop rounded-sm bg-ink/15" style={{ animationDelay: `${i * 60}ms` }} />
                ))}
              </div>
            </>
          ) : (
            <p className="mt-1 text-[13px] leading-relaxed text-inksoft">One photo per 4×6 sheet, exactly as framed.</p>
          )}
        </div>
      )}

      <Stepper label="Copies" value={copies} min={1} max={50} onChange={onCopies} />
    </div>
  );
}

function ModeCard({
  active,
  onClick,
  title,
  sub,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  sub: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative flex flex-col items-start gap-2 rounded-2xl border p-4 text-left shadow-sheet transition-all active:scale-[0.97] ${
        active ? 'border-accent bg-accent/[0.06]' : 'border-line bg-card'
      }`}
    >
      <span className={`transition-colors ${active ? 'text-accent' : 'text-inksoft'}`}>{icon}</span>
      <span>
        <span className="block text-[15px] font-bold leading-tight">{title}</span>
        <span className="text-xs text-inksoft">{sub}</span>
      </span>
      {active && <span className="absolute right-3 top-3 h-2.5 w-2.5 rounded-full bg-accent" />}
    </button>
  );
}

/** 2:3 crop frame with third-guides, drag-to-pan and zoom slider. */
export function CropEditor({ src, crop, onChange }: { src: string; crop: CropState; onChange: (c: CropState) => void }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const panFraction = Math.max(0, 1 - 1 / crop.zoom);
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, ox: crop.offsetX, oy: crop.offsetY };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    const frame = frameRef.current;
    if (!drag || !frame || panFraction === 0) return;
    const dx = ((e.clientX - drag.x) / frame.clientWidth) / panFraction;
    const dy = ((e.clientY - drag.y) / frame.clientHeight) / panFraction;
    onChange({ ...crop, offsetX: clamp01(drag.ox - dx), offsetY: clamp01(drag.oy - dy) });
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const tx = (crop.offsetX - 0.5) * panFraction * -100;
  const ty = (crop.offsetY - 0.5) * panFraction * -100;

  return (
    <div className="rounded-2xl border border-line bg-card p-4 shadow-sheet">
      <div className="flex items-baseline justify-between">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-inksoft">Frame your print</p>
        <p className="text-[11px] font-medium text-inksoft">4×6</p>
      </div>

      <div
        ref={frameRef}
        className="relative mx-auto mt-3 aspect-[2/3] w-full max-w-[230px] touch-none select-none overflow-hidden rounded-xl bg-ink"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{ cursor: panFraction > 0 ? 'grab' : 'default' }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt="Crop preview"
          draggable={false}
          className="h-full w-full object-cover"
          style={{ transform: `scale(${crop.zoom}) translate(${tx}%, ${ty}%)` }}
        />
        <div className="crop-grid pointer-events-none absolute inset-0" aria-hidden />
      </div>

      <label className="mt-4 block">
        <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-inksoft">Zoom</span>
        <input
          type="range"
          min={1}
          max={3}
          step={0.05}
          value={crop.zoom}
          onChange={(e) => onChange({ ...crop, zoom: Number(e.target.value) })}
          className="mt-1.5 w-full accent-[#2E4BE6]"
        />
      </label>
      <p className="mt-1 text-center text-xs text-inksoft">
        {panFraction > 0 ? 'Drag the photo to reposition' : 'Zoom in to reposition'}
      </p>
    </div>
  );
}
