import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * The editor's controls. Heights are fixed so rows line up across a panel: 24 for inline controls, 28 for the actions of
 * a section. Text is 11 or 12 px, one accent marks what is chosen or what happens next, and nothing here draws a card.
 */

type ButtonVariant = 'primary' | 'default' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink hover:bg-accent-hover active:brightness-95',
  default: 'bg-gray-800 text-ink hover:bg-gray-750 active:bg-gray-700',
  ghost: 'text-ink-2 hover:bg-white/5 hover:text-ink active:bg-white/10',
  danger: 'text-bad hover:bg-bad/10 active:bg-bad/15',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-6 gap-1 px-2 text-2xs',
  md: 'h-7 gap-1.5 px-2.5 text-xs',
  lg: 'h-8 gap-2 px-3 text-xs',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ variant = 'default', size = 'md', icon, className = '', children, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    {...props}
    className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded font-medium transition-colors duration-75 disabled:opacity-40 ${BUTTON_VARIANTS[variant]} ${BUTTON_SIZES[size]} ${className}`}
  >
    {icon}
    {children}
  </button>
));
Button.displayName = 'Button';

/** A small hint over a control, with its shortcut if it has one. Shows after a pause, as a tool's do. */
export const Tooltip: React.FC<{ text: React.ReactNode; shortcut?: string; children: React.ReactElement<React.HTMLAttributes<HTMLElement>> }> = ({ text, shortcut, children }) => {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setAnchor(null);
  };
  useEffect(() => hide, []);
  const trigger = React.cloneElement(children, {
    onMouseEnter: (event: React.MouseEvent<HTMLElement>) => {
      children.props.onMouseEnter?.(event);
      const target = event.currentTarget;
      timer.current = setTimeout(() => setAnchor(target.getBoundingClientRect()), 450);
    },
    onMouseLeave: (event: React.MouseEvent<HTMLElement>) => {
      children.props.onMouseLeave?.(event);
      hide();
    },
    onMouseDown: (event: React.MouseEvent<HTMLElement>) => {
      children.props.onMouseDown?.(event);
      hide();
    },
  });
  // Under the control unless that runs off the window.
  const below = anchor ? anchor.bottom + 34 < window.innerHeight : true;
  return (
    <>
      {trigger}
      {anchor && createPortal(
        <div
          role="tooltip"
          style={{
            position: 'fixed',
            left: Math.max(6, Math.min(anchor.left + anchor.width / 2, window.innerWidth - 6)),
            ...(below ? { top: anchor.bottom + 5 } : { bottom: window.innerHeight - anchor.top + 5 }),
            transform: 'translateX(-50%)',
          }}
          className="pointer-events-none z-[10000] flex max-w-xs items-center gap-2 rounded border border-line bg-ground px-2 py-1 text-2xs text-ink shadow-[0_4px_12px_rgb(0_0_0/0.5)]"
        >
          <span>{text}</span>
          {shortcut && <Kbd>{shortcut}</Kbd>}
        </div>,
        document.body,
      )}
    </>
  );
};

export interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  /** What it does: its accessible name and its tooltip. */
  label: string;
  shortcut?: string;
  active?: boolean;
  size?: 'sm' | 'md';
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(({ label, shortcut, active = false, size = 'sm', className = '', children, ...props }, ref) => (
  <Tooltip text={label} shortcut={shortcut}>
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={active || undefined}
      {...props}
      className={`inline-flex shrink-0 items-center justify-center rounded transition-colors duration-75 disabled:opacity-40 ${size === 'sm' ? 'h-6 w-6' : 'h-7 w-7'} ${active ? 'bg-accent/20 text-accent' : 'text-ink-2 hover:bg-white/5 hover:text-ink'} ${className}`}
    >
      {children}
    </button>
  </Tooltip>
));
IconButton.displayName = 'IconButton';

export const Kbd: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <kbd className={`rounded-sm bg-white/10 px-1 font-sans text-2xs text-ink-2 ${className}`}>{children}</kbd>
);

/** A ring that turns: for work in progress, sized to sit in a line of text. */
export const Spinner: React.FC<{ className?: string }> = ({ className = '' }) => (
  <span aria-hidden className={`inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-r-transparent ${className}`} />
);

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  /** Says what the choice means. */
  hint?: string;
}

/** One choice of a few, all in view. */
export const Segmented = <T extends string>({ value, options, onChange, label, disabled = false, className = '' }: {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}) => (
  <div role="radiogroup" aria-label={label} className={`inline-flex h-6 items-center gap-px rounded bg-well p-0.5 ${className}`}>
    {options.map((option) => (
      <button
        key={option.value}
        type="button"
        role="radio"
        aria-checked={option.value === value}
        disabled={disabled || option.disabled}
        title={option.hint}
        onClick={() => onChange(option.value)}
        className={`h-5 whitespace-nowrap rounded-sm px-2 text-2xs font-medium transition-colors duration-75 disabled:opacity-40 ${option.value === value ? 'bg-gray-750 text-ink' : 'text-ink-3 hover:text-ink-2'}`}
      >
        {option.label}
      </button>
    ))}
  </div>
);

const FIELD = 'w-full rounded border border-line bg-well text-xs text-ink placeholder:text-ink-3 transition-colors duration-75 hover:border-gray-700 focus:border-accent/70 focus:outline-none disabled:opacity-50';

export const TextInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className = '', ...props }, ref) => (
  <input ref={ref} type="text" {...props} className={`${FIELD} h-6 px-2 ${className}`} />
));
TextInput.displayName = 'TextInput';

export const TextArea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className = '', ...props }, ref) => (
  <textarea ref={ref} {...props} className={`${FIELD} resize-none px-2 py-1.5 leading-[18px] ${className}`} />
));
TextArea.displayName = 'TextArea';

/** A panel's title row. */
export const PanelTitle: React.FC<{ children: React.ReactNode; actions?: React.ReactNode }> = ({ children, actions }) => (
  <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
    <h2 className="truncate text-xs font-semibold text-ink">{children}</h2>
    {actions && <div className="flex items-center gap-0.5">{actions}</div>}
  </div>
);

/** A stretch of a panel, parted from the next by a line. */
export const Section: React.FC<{ title?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string }> = ({ title, actions, children, className = '' }) => (
  <section className={`border-b border-line px-3 py-2.5 last:border-b-0 ${className}`}>
    {(title || actions) && (
      <div className="mb-1.5 flex min-h-[20px] items-center justify-between gap-2">
        {title && <h3 className="truncate text-2xs font-medium text-ink-3">{title}</h3>}
        {actions}
      </div>
    )}
    {children}
  </section>
);

export type PopoverPlacement = 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end';

const POPOVER_GAP = 4;
const WINDOW_MARGIN = 8;

/** Floats over everything beside what opened it, flipping to stay in the window. Pressing outside or Escape closes it. */
export const Popover: React.FC<{
  anchor: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  placement?: PopoverPlacement;
  width?: number;
  label?: string;
  children: React.ReactNode;
}> = ({ anchor, open, onClose, placement = 'bottom-start', width = 320, label, children }) => {
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const [position, setPosition] = useState<React.CSSProperties>({ visibility: 'hidden' });

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const from = anchor.current?.getBoundingClientRect();
      const height = panel.current?.offsetHeight ?? 0;
      if (!from) return;
      const wantsTop = placement.startsWith('top');
      const roomAbove = from.top - WINDOW_MARGIN;
      const roomBelow = window.innerHeight - from.bottom - WINDOW_MARGIN;
      const top = wantsTop ? roomAbove >= height || roomAbove >= roomBelow : roomBelow < height && roomAbove > roomBelow;
      const left = placement.endsWith('end') ? from.right - width : from.left;
      setPosition({
        position: 'fixed',
        width,
        left: Math.max(WINDOW_MARGIN, Math.min(left, window.innerWidth - width - WINDOW_MARGIN)),
        ...(top ? { bottom: window.innerHeight - from.top + POPOVER_GAP } : { top: from.bottom + POPOVER_GAP }),
        maxHeight: (top ? roomAbove : roomBelow) - POPOVER_GAP,
      });
    };
    place();
    window.addEventListener('resize', place);
    const observer = new ResizeObserver(place);
    if (panel.current) observer.observe(panel.current);
    return () => {
      window.removeEventListener('resize', place);
      observer.disconnect();
    };
  }, [anchor, open, placement, width]);

  useEffect(() => {
    if (!open) return;
    const onPress = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('mousedown', onPress);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onPress);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [anchor, onClose, open]);

  if (!open) return null;
  return createPortal(
    <div
      ref={panel}
      id={id}
      role="dialog"
      aria-label={label}
      style={position}
      className="z-[9000] flex flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-[0_12px_32px_rgb(0_0_0/0.55)]"
    >
      {children}
    </div>,
    document.body,
  );
};

/** The width of a side panel, dragged by the edge beside it and remembered between sessions. */
export const usePanelWidth = (key: string, initial: number, min: number, max: number) => {
  const [width, setWidth] = useState(() => {
    try {
      const stored = Number(window.localStorage.getItem(`auvra.panel.${key}`));
      return stored >= min && stored <= max ? stored : initial;
    } catch {
      return initial;
    }
  });
  const widthRef = useRef(width);
  widthRef.current = width;
  const save = () => {
    try { window.localStorage.setItem(`auvra.panel.${key}`, String(widthRef.current)); } catch { /* A remembered width is a nicety. */ }
  };
  return { width, setWidth: (value: number) => setWidth(Math.max(min, Math.min(max, value))), save };
};

/** The strip between two panels that resizes one of them. */
export const PanelEdge: React.FC<{
  side: 'left' | 'right';
  width: number;
  onResize: (width: number) => void;
  onDone: () => void;
  label: string;
}> = ({ side, width, onResize, onDone, label }) => {
  const start = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const from = event.clientX;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => onResize(width + (side === 'left' ? next.clientX - from : from - next.clientX));
    const end = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
      onDone();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      onPointerDown={start}
      className="group relative z-10 w-px shrink-0 cursor-col-resize bg-ground"
    >
      <span className="absolute inset-y-0 -left-1 -right-1 transition-colors duration-100 group-hover:bg-accent/40 group-active:bg-accent/60" />
    </div>
  );
};
