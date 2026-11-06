import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GLYPHS, GLYPH_NAMES, type GlyphName } from './glyphs';
import { Icon } from './index';
import { Button, IconButton, Segmented } from '../kit';

/**
 * The catalogue of Auvra's icons, served by the development server at /icons.html. It shows every icon at the sizes the
 * editor uses, beside text and in buttons, and enlarged pixel by pixel, which is how they are drawn.
 */

const SIZES = [10, 11, 12, 13, 14, 16, 24] as const;
const PANEL = 'rgb(30 31 34)';
const INK = 'rgb(173 176 182)';
const ACCENT = 'rgb(240 138 60)';

type View = 'icons' | 'sheet' | 'pixels';

const componentName = (name: string): string => `${name[0].toUpperCase()}${name.slice(1)}Icon`;
const hasSmall = (name: GlyphName): boolean => 's' in GLYPHS[name];

/** The icon drawn at `size` and blown up `zoom` times with a pixel grid, so every pixel of it can be judged. */
const Enlarged: React.FC<{ name: GlyphName; size: number; color: string; zoom: number; caption?: string; onSpill?: (spill: boolean) => void }> = ({ name, size, color, zoom, caption, onSpill }) => {
  const holder = useRef<HTMLSpanElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const svg = holder.current?.querySelector('svg');
    const target = canvas.current;
    if (!svg || !target) return;
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      const small = document.createElement('canvas');
      small.width = size;
      small.height = size;
      const smallContext = small.getContext('2d');
      const context = target.getContext('2d');
      if (!smallContext || !context) return;
      smallContext.drawImage(image, 0, 0, size, size);
      if (onSpill) {
        // The 11 px drawing may not reach the edge pixels of a 13 px box, nor the 9 px drawing those of an 11 px box.
        const pixels = smallContext.getImageData(0, 0, size, size).data;
        let spill = false;
        for (let y = 0; y < size; y += 1) {
          for (let x = 0; x < size; x += 1) {
            const edge = x === 0 || y === 0 || x === size - 1 || y === size - 1;
            if (edge && pixels[(y * size + x) * 4 + 3] > 24) spill = true;
          }
        }
        onSpill(spill);
      }
      context.fillStyle = PANEL;
      context.fillRect(0, 0, target.width, target.height);
      context.imageSmoothingEnabled = false;
      context.drawImage(small, 0, 0, size * zoom, size * zoom);
      context.strokeStyle = 'rgb(255 255 255 / 0.05)';
      context.lineWidth = 1;
      for (let line = 1; line < size; line += 1) {
        context.beginPath();
        context.moveTo(line * zoom + 0.5, 0);
        context.lineTo(line * zoom + 0.5, size * zoom);
        context.moveTo(0, line * zoom + 0.5);
        context.lineTo(size * zoom, line * zoom + 0.5);
        context.stroke();
      }
    };
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
    return () => {
      cancelled = true;
    };
  }, [name, size, color, zoom, onSpill]);
  return (
    <span className="relative inline-flex flex-col items-center gap-1">
      <span ref={holder} className="pointer-events-none absolute opacity-0"><Icon name={name} size={size} color={color} /></span>
      <canvas ref={canvas} width={size * zoom} height={size * zoom} className="rounded-sm" />
      {caption && <span className="max-w-full truncate text-2xs text-ink-3">{caption}</span>}
    </span>
  );
};

const PixelRow: React.FC<{ name: GlyphName; color: string }> = ({ name, color }) => {
  const [spills, setSpills] = useState<Record<number, boolean>>({});
  const reporters = useMemo(() => Object.fromEntries([11, 13].map((size) => [size, (spill: boolean) => setSpills((current) => (current[size] === spill ? current : { ...current, [size]: spill }))])), []);
  const spilt = Boolean(spills[13] || (hasSmall(name) && spills[11]));
  return (
    <div className="flex items-start gap-4 border-b border-line py-3">
      <div className="w-40 shrink-0">
        <div className="text-xs font-medium text-ink">{componentName(name)}</div>
        <div className="text-2xs text-ink-3">{hasSmall(name) ? 'Small and main drawings' : 'Main drawing'}</div>
        {spilt && <div className="mt-1 text-2xs text-bad">Reaches the edge of its box</div>}
      </div>
      {[10, 11, 12, 13, 14].map((size) => (
        <Enlarged key={size} name={name} size={size} color={color} zoom={9} caption={String(size)} onSpill={reporters[size]} />
      ))}
    </div>
  );
};

export const IconGallery: React.FC = () => {
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>('icons');
  const [sheetSize, setSheetSize] = useState<'10' | '12' | '13' | '14' | '16' | '24'>('13');
  const [accent, setAccent] = useState(false);
  const color = accent ? ACCENT : INK;
  // Several words find any of them, so a handful of icons can be compared side by side.
  const words = query.toLowerCase().split(/[\s,]+/).filter(Boolean);
  const names = GLYPH_NAMES.filter((name) => !words.length || words.some((word) => name.toLowerCase().includes(word)));
  const size = Number(sheetSize);
  const sheetNames = size <= 11 ? names.filter(hasSmall) : names;
  return (
    <div className="editor-shell h-full overflow-auto bg-ground p-6 text-ink">
      <div className="mx-auto max-w-6xl">
        <header className="mb-5 flex flex-wrap items-center gap-3">
          <h1 className="text-sm font-semibold">Auvra icons</h1>
          <span className="text-2xs text-ink-3">{GLYPH_NAMES.length} icons, {GLYPH_NAMES.filter(hasSmall).length} with a small drawing</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find an icon"
            className="ml-auto h-7 w-48 rounded border border-line bg-well px-2 text-xs text-ink outline-none placeholder:text-ink-3 focus:border-accent"
          />
          <Segmented
            label="View"
            value={view}
            onChange={setView}
            options={[{ value: 'icons', label: 'Icons' }, { value: 'sheet', label: 'Sheet' }, { value: 'pixels', label: 'Pixels' }]}
          />
          <Button size="md" variant={accent ? 'primary' : 'default'} onClick={() => setAccent((value) => !value)}>Accent</Button>
        </header>

        <section className="mb-6 flex flex-wrap items-center gap-4 rounded-lg border border-line bg-panel p-4">
          <span className="flex items-center gap-1.5 text-2xs text-ink-2"><Icon name="folder" size={11} /> Content</span>
          <span className="flex items-center gap-1.5 text-xs text-ink-2"><Icon name="cube" size={12} /> Crate_01</span>
          <span className="flex items-center gap-1.5 text-xs text-ink"><Icon name="music" size={13} className="text-ink-3" /> Ambience</span>
          <Button size="sm" icon={<Icon name="plus" size={10} />}>Add</Button>
          <Button size="md" variant="primary" icon={<Icon name="play" size={12} fill="currentColor" />}>Play level</Button>
          <Button size="md" variant="danger" icon={<Icon name="trash" size={12} />}>Delete</Button>
          <span className="flex items-center gap-0.5">
            <IconButton label="Search"><Icon name="search" size={14} /></IconButton>
            <IconButton label="Visible" active><Icon name="eye" size={14} /></IconButton>
            <IconButton label="Settings"><Icon name="gear" size={14} /></IconButton>
            <IconButton label="Camera"><Icon name="camera" size={14} /></IconButton>
          </span>
          <span className="flex items-center gap-1 text-2xs text-warn"><Icon name="warning" size={12} /> Two clips share a name</span>
        </section>

        {view === 'icons' && (
          <section className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
            {names.map((name) => (
              <div key={name} className="rounded-lg border border-line bg-panel p-3">
                <div className="mb-3 flex items-end gap-3" style={{ color }}>
                  {SIZES.map((iconSize) => <Icon key={iconSize} name={name} size={iconSize} />)}
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-xs text-ink">{componentName(name)}</span>
                  <span className="text-2xs text-ink-3">{hasSmall(name) ? '9 + 11 px' : '11 px'}</span>
                </div>
              </div>
            ))}
          </section>
        )}

        {view === 'sheet' && (
          <>
            <div className="mb-3 flex items-center gap-2 text-2xs text-ink-3">
              Every icon at
              <Segmented
                label="Size"
                value={sheetSize}
                onChange={setSheetSize}
                options={(['10', '12', '13', '14', '16', '24'] as const).map((value) => ({ value, label: `${value} px` }))}
              />
              {size <= 11 && 'showing the icons that have a small drawing'}
            </div>
            <section className="grid gap-x-2 gap-y-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${Math.max(size * 5, 64)}px, 1fr))` }}>
              {sheetNames.map((name) => (
                <Enlarged key={`${name}-${size}`} name={name} size={size} color={color} zoom={size >= 16 ? 3 : 5} caption={name} />
              ))}
            </section>
          </>
        )}

        {view === 'pixels' && <section>{names.map((name) => <PixelRow key={name} name={name} color={color} />)}</section>}
      </div>
    </div>
  );
};
