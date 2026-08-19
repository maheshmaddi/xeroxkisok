'use client';

export interface DocSettings {
  copies: number;
  color: boolean;
  duplex: boolean;
  paperSize: 'A4' | 'A3';
  pageRange: string;
}

/** Document print settings: segmented pills, copies stepper, page range. */
export default function DocumentSettings({
  settings,
  onChange,
  pages,
}: {
  settings: DocSettings;
  onChange: (next: DocSettings) => void;
  pages: number;
}) {
  const set = (patch: Partial<DocSettings>) => onChange({ ...settings, ...patch });

  return (
    <div className="animate-rise space-y-5">
      <Stepper
        label="Copies"
        value={settings.copies}
        min={1}
        max={50}
        onChange={(copies) => set({ copies })}
      />

      <Segmented
        label="Colour"
        options={[
          { value: 'bw', label: 'B&W', hint: '₹2/side' },
          { value: 'color', label: 'Colour', hint: '₹8/side' },
        ]}
        value={settings.color ? 'color' : 'bw'}
        onSelect={(v) => set({ color: v === 'color' })}
      />

      <Segmented
        label="Sides"
        options={[
          { value: 'single', label: 'Single' },
          { value: 'duplex', label: 'Duplex', hint: 'save paper' },
        ]}
        value={settings.duplex ? 'duplex' : 'single'}
        onSelect={(v) => set({ duplex: v === 'duplex' })}
      />

      <Segmented
        label="Paper"
        options={[
          { value: 'A4', label: 'A4' },
          { value: 'A3', label: 'A3', hint: '₹4+' },
        ]}
        value={settings.paperSize}
        onSelect={(v) => set({ paperSize: v as 'A4' | 'A3' })}
      />

      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-inksoft">Pages</span>
          <button
            onClick={() => set({ pageRange: '' })}
            className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold transition-colors ${
              settings.pageRange.trim() === '' ? 'bg-accent/10 text-accent' : 'bg-ink/5 text-inksoft'
            }`}
          >
            All {pages}
          </button>
        </div>
        <input
          className="h-12 w-full rounded-xl border border-line bg-card px-4 text-[15px] shadow-sheet outline-none placeholder:text-inksoft/50 focus:border-accent"
          placeholder="Range, e.g. 1-3,7"
          inputMode="numeric"
          value={settings.pageRange}
          onChange={(e) => set({ pageRange: e.target.value })}
        />
      </div>
    </div>
  );
}

export function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  return (
    <div>
      <span className="mb-2 block text-[11px] font-bold uppercase tracking-[0.18em] text-inksoft">{label}</span>
      <div className="flex items-center gap-3">
        <button
          aria-label={`Decrease ${label}`}
          onClick={() => onChange(clamp(value - 1))}
          className="flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-card text-2xl font-bold text-ink shadow-sheet transition-transform active:scale-90"
        >
          −
        </button>
        <div className="flex h-12 flex-1 items-center justify-center rounded-xl border border-line bg-card shadow-sheet">
          <span className="font-display text-2xl font-semibold tabular-nums">{value}</span>
        </div>
        <button
          aria-label={`Increase ${label}`}
          onClick={() => onChange(clamp(value + 1))}
          className="flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-card text-2xl font-bold text-ink shadow-sheet transition-transform active:scale-90"
        >
          +
        </button>
      </div>
    </div>
  );
}

interface SegOption {
  value: string;
  label: string;
  hint?: string;
}

/** Two-option pill selector with a sliding ink indicator. */
export function Segmented({
  label,
  options,
  value,
  onSelect,
}: {
  label: string;
  options: [SegOption, SegOption];
  value: string;
  onSelect: (value: string) => void;
}) {
  const activeIndex = options.findIndex((o) => o.value === value);
  return (
    <div>
      <span className="mb-2 block text-[11px] font-bold uppercase tracking-[0.18em] text-inksoft">{label}</span>
      <div className="relative grid grid-cols-2 gap-1 rounded-xl border border-line bg-ink/[0.04] p-1">
        <span
          aria-hidden
          className="seg-pill absolute inset-y-1 rounded-lg bg-card shadow-sheet"
          style={{
            width: 'calc(50% - 0.375rem)',
            left: activeIndex === 0 ? '0.25rem' : 'calc(50% + 0.125rem)',
          }}
        />
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onSelect(opt.value)}
            className={`relative z-10 flex h-11 flex-col items-center justify-center rounded-lg text-sm font-bold transition-colors ${
              value === opt.value ? 'text-ink' : 'text-inksoft'
            }`}
          >
            {opt.label}
            {opt.hint && <span className="text-[10px] font-medium text-inksoft">{opt.hint}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
