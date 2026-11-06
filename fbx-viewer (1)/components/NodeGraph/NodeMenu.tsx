import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckIcon } from '../UI/Icons';
import { Kbd } from '../UI/kit';
import type { MenuItem } from './types';

/**
 * A menu at the pointer (for a node, a wire or a frame): its items in sections, and optionally a row
 * of colours to pick from. Arrows move, Enter picks, Escape or a press outside closes. It stays inside
 * the window.
 */

const WIDTH = 228;
const MARGIN = 8;

export interface MenuColours {
    label: string;
    colours: readonly string[];
    names: Readonly<Record<string, string>>;
    current?: string;
    /** Picks a colour, or none for the default. */
    onPick: (colour: string | undefined) => void;
}

export const NodeMenu: React.FC<{
    /** Where it opens, in window pixels. */
    x: number;
    y: number;
    title?: string;
    items: readonly MenuItem[];
    colours?: MenuColours;
    onClose: () => void;
}> = ({ x, y, title, items, colours, onClose }) => {
    const panel = useRef<HTMLDivElement>(null);
    const buttons = useRef<Array<HTMLButtonElement | null>>([]);
    const [active, setActive] = useState(() => Math.max(0, items.findIndex((item) => !item.disabled)));
    const [place, setPlace] = useState<{ left: number; top: number }>({ left: x, top: y });

    useLayoutEffect(() => {
        const element = panel.current;
        if (!element) return;
        const height = element.offsetHeight;
        setPlace({
            left: Math.max(MARGIN, Math.min(x, window.innerWidth - WIDTH - MARGIN)),
            top: Math.max(MARGIN, y + height > window.innerHeight - MARGIN ? y - height : y),
        });
    }, [x, y, items.length]);

    useEffect(() => { buttons.current[active]?.focus(); }, [active]);

    useEffect(() => {
        const onPress = (event: MouseEvent) => { if (!panel.current?.contains(event.target as Node)) onClose(); };
        window.addEventListener('mousedown', onPress, true);
        window.addEventListener('blur', onClose);
        return () => {
            window.removeEventListener('mousedown', onPress, true);
            window.removeEventListener('blur', onClose);
        };
    }, [onClose]);

    const move = (step: number) => {
        if (!items.length) return;
        let next = active;
        for (let i = 0; i < items.length; i++) {
            next = (next + step + items.length) % items.length;
            if (!items[next].disabled) break;
        }
        setActive(next);
    };

    const pick = (item: MenuItem) => {
        if (item.disabled) return;
        onClose();
        item.onSelect();
    };

    let lastSection: string | undefined;
    return createPortal(
        <div
            ref={panel}
            role="menu"
            aria-label={title ?? 'Actions'}
            className="fixed z-[9500] overflow-hidden rounded-lg border border-line bg-panel py-1 shadow-[0_12px_32px_rgb(0_0_0/0.55)]"
            style={{ left: place.left, top: place.top, width: WIDTH }}
            onContextMenu={(event) => event.preventDefault()}
            onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Escape') { event.preventDefault(); onClose(); }
                else if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
                else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
                else if (event.key === 'Home') { event.preventDefault(); setActive(items.findIndex((item) => !item.disabled)); }
                else if (event.key === 'End') { event.preventDefault(); for (let i = items.length - 1; i >= 0; i--) if (!items[i].disabled) { setActive(i); break; } }
            }}
        >
            {title && <div className="truncate border-b border-line px-3 pb-1.5 pt-1 text-2xs font-medium text-ink-3">{title}</div>}
            {items.map((item, index) => {
                const parted = index > 0 && item.section !== lastSection;
                lastSection = item.section;
                return (
                    <React.Fragment key={`${item.label}:${index}`}>
                        {parted && <div className="my-1 border-t border-line" />}
                        <button
                            ref={(element) => { buttons.current[index] = element; }}
                            type="button"
                            role="menuitem"
                            disabled={item.disabled}
                            title={item.disabled ? item.hint : undefined}
                            onMouseEnter={() => !item.disabled && setActive(index)}
                            onClick={() => pick(item)}
                            className={`flex h-7 w-full items-center gap-2 px-3 text-left text-xs outline-none disabled:opacity-40 ${index === active && !item.disabled ? 'bg-white/5' : ''} ${item.danger ? 'text-bad' : 'text-ink'}`}
                        >
                            <span className="flex w-3.5 shrink-0 justify-center text-ink-3">{item.icon}</span>
                            <span className="min-w-0 flex-1 truncate">{item.label}</span>
                            {item.shortcut && <Kbd>{item.shortcut}</Kbd>}
                        </button>
                    </React.Fragment>
                );
            })}
            {colours && (
                <div className="mt-1 border-t border-line px-3 pb-1.5 pt-2">
                    <div className="mb-1.5 text-2xs text-ink-3">{colours.label}</div>
                    <div role="radiogroup" aria-label={colours.label} className="flex flex-wrap gap-1.5">
                        <button type="button" role="radio" aria-checked={!colours.current} aria-label="As its kind" title="As its kind"
                            onClick={() => { onClose(); colours.onPick(undefined); }}
                            className={`flex h-5 w-5 items-center justify-center rounded border text-ink-3 ${!colours.current ? 'border-ink' : 'border-line hover:border-gray-600'}`}>
                            {!colours.current && <CheckIcon size={10} />}
                        </button>
                        {colours.colours.map((colour) => (
                            <button key={colour} type="button" role="radio" aria-checked={colours.current === colour} aria-label={colours.names[colour] ?? colour} title={colours.names[colour] ?? colour}
                                onClick={() => { onClose(); colours.onPick(colour); }}
                                className={`h-5 w-5 rounded border ${colours.current === colour ? 'border-ink ring-1 ring-ink/50' : 'border-line hover:border-gray-600'}`} style={{ background: colour }} />
                        ))}
                    </div>
                </div>
            )}
        </div>,
        document.body,
    );
};
