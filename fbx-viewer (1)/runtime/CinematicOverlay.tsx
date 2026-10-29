import React, { useEffect } from 'react';
import { cinematics, useCinematicState, type Cinematics } from './cinematics';
import { useTranslation, useUiText } from './localization';

/** Height of each letterbox bar, as a share of the view's height. */
const LETTERBOX = '11%';

/**
 * What timelines put on screen over the play view: letterbox bars while a cinematic plays, a colour fade,
 * the subtitle line, and, for a cinematic that can be skipped, the skip prompt (Enter, or a click on it).
 */
export const CinematicOverlay: React.FC<{ store?: Cinematics }> = ({ store = cinematics }) => {
    const state = useCinematicState(store);
    const translate = useTranslation();
    const ui = useUiText();

    useEffect(() => {
        if (!state.skippable) return undefined;
        const skip = (event: KeyboardEvent) => {
            if (event.code !== 'Enter' && event.code !== 'NumpadEnter') return;
            event.preventDefault();
            store.skip();
        };
        window.addEventListener('keydown', skip);
        return () => window.removeEventListener('keydown', skip);
    }, [state.skippable, store]);

    const subtitle = state.subtitle;
    const text = subtitle ? translate(subtitle.key, undefined, subtitle.text) : '';
    const speaker = subtitle?.speaker ? translate(`${subtitle.key}.speaker`, undefined, subtitle.speaker) : '';

    return (
        <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden" aria-live="polite">
            {state.fade && (
                <div data-testid="cinematic-fade" className="absolute inset-0" style={{ backgroundColor: state.fade.color, opacity: state.fade.amount }} />
            )}
            <div className="absolute inset-x-0 top-0 bg-black transition-[height] duration-500 ease-out" style={{ height: state.active ? LETTERBOX : 0 }} />
            <div className="absolute inset-x-0 bottom-0 bg-black transition-[height] duration-500 ease-out" style={{ height: state.active ? LETTERBOX : 0 }} />
            {subtitle && text && (
                <div className="absolute inset-x-0 flex justify-center px-6" style={{ bottom: state.active ? `calc(${LETTERBOX} + 1.5rem)` : '3.5rem' }}>
                    <p className="max-w-3xl rounded bg-black/55 px-4 py-2 text-center text-base leading-snug text-white shadow-lg" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.9)' }}>
                        {speaker && <span className="mr-2 font-semibold text-amber-300">{speaker}:</span>}
                        {text}
                    </p>
                </div>
            )}
            {state.active && state.skippable && (
                <button
                    type="button"
                    onClick={() => store.skip()}
                    className="pointer-events-auto absolute bottom-3 right-4 flex items-center gap-2 rounded-full border border-white/25 bg-black/60 px-3 py-1 text-xs text-white/90 hover:bg-black/80"
                >
                    <kbd className="rounded border border-white/40 bg-white/10 px-1.5 py-0.5 font-mono text-[10px]">Enter</kbd>
                    {ui('ui.cinematic.skip')}
                </button>
            )}
        </div>
    );
};
