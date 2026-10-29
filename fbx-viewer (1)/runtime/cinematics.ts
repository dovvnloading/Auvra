import { createContext, useSyncExternalStore } from 'react';
import type * as THREE from 'three';

/**
 * CINEMATICS
 *
 * What playing timelines ask of the screen and of play: a cinematic timeline (its component's Cinematic
 * setting) letterboxes the view, hides the HUD and takes the player's controls while it plays, and may be
 * skipped; any timeline can show a subtitle or fade the screen. Each timeline writes its own entry; the
 * overlay and the play session read them together.
 */

export interface CinematicSubtitle {
    speaker: string;
    text: string;
    /** Localization key for the line (the text shows when a locale does not translate it). */
    key: string;
}

/** One timeline's part. */
export interface CinematicEntry {
    /** Plays as a cinematic: letterbox, HUD hidden, the player's controls taken. */
    cinematic: boolean;
    skippable: boolean;
    fade: { amount: number; color: string } | null;
    subtitle: CinematicSubtitle | null;
}

/** All playing timelines' parts together. */
export interface CinematicState {
    /** Some cinematic is playing. */
    active: boolean;
    /** Some playing cinematic can be skipped. */
    skippable: boolean;
    /** The deepest fade any timeline asks for. */
    fade: { amount: number; color: string } | null;
    /** The line the timeline that set one most recently shows. */
    subtitle: CinematicSubtitle | null;
}

export const IDLE_CINEMATIC_STATE: CinematicState = Object.freeze({ active: false, skippable: false, fade: null, subtitle: null });

const sameFade = (a: CinematicEntry['fade'], b: CinematicEntry['fade']) =>
    a === b || (!!a && !!b && Math.abs(a.amount - b.amount) < 1e-4 && a.color === b.color);
const sameSubtitle = (a: CinematicSubtitle | null, b: CinematicSubtitle | null) =>
    a === b || (!!a && !!b && a.key === b.key && a.text === b.text && a.speaker === b.speaker);

export const createCinematics = () => {
    const entries = new Map<string, CinematicEntry & { order: number }>();
    const listeners = new Set<() => void>();
    let state: CinematicState = IDLE_CINEMATIC_STATE;
    let order = 0;
    let skips = 0;

    const combine = (): CinematicState => {
        if (entries.size === 0) return IDLE_CINEMATIC_STATE;
        let active = false, skippable = false;
        let fade: CinematicState['fade'] = null;
        let subtitle: CinematicSubtitle | null = null;
        let subtitleOrder = -1;
        for (const entry of entries.values()) {
            if (entry.cinematic) {
                active = true;
                if (entry.skippable) skippable = true;
            }
            if (entry.fade && entry.fade.amount > 0 && (!fade || entry.fade.amount > fade.amount)) fade = entry.fade;
            if (entry.subtitle && entry.order > subtitleOrder) {
                subtitle = entry.subtitle;
                subtitleOrder = entry.order;
            }
        }
        return { active, skippable, fade, subtitle };
    };

    const publish = () => {
        const next = combine();
        if (next.active === state.active && next.skippable === state.skippable && sameFade(next.fade, state.fade) && sameSubtitle(next.subtitle, state.subtitle)) return;
        state = next;
        [...listeners].forEach(listener => listener());
    };

    return {
        /** Sets (or with null clears) a timeline's part. */
        set(timelineId: string, entry: CinematicEntry | null): void {
            const previous = entries.get(timelineId);
            if (!entry) {
                if (!previous) return;
                entries.delete(timelineId);
            } else {
                // A new subtitle makes this timeline the one whose line shows.
                const fresh = !previous || (entry.subtitle && !sameSubtitle(entry.subtitle, previous.subtitle));
                entries.set(timelineId, { ...entry, order: fresh ? ++order : previous!.order });
            }
            publish();
        },
        state(): CinematicState {
            return state;
        },
        subscribe(listener: () => void): () => void {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        /** Asks every skippable cinematic playing to skip to its end. */
        skip(): void {
            skips++;
        },
        /** Counts skip requests; a cinematic compares it with the count when it started. */
        skipCount(): number {
            return skips;
        },
        clear(): void {
            entries.clear();
            publish();
        },
    };
};

export type Cinematics = ReturnType<typeof createCinematics>;

/** The play session's cinematics. */
export const cinematics = createCinematics();

export const useCinematicState = (store: Cinematics = cinematics): CinematicState =>
    useSyncExternalStore(store.subscribe, store.state, store.state);

/** The player character's clips in a play session, for timeline animation tracks aimed at the player. */
export const PlayerClipsContext = createContext<readonly THREE.AnimationClip[]>([]);
