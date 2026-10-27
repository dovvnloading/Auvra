import type { AnimNotify } from '../../../types';

/** A stretch of clip time; each end is closed (inclusive) or open (exclusive). */
interface TimeSpan {
    low: number;
    high: number;
    lowClosed: boolean;
    highClosed: boolean;
}

const clampTime = (time: number, duration: number) => Math.min(duration, Math.max(0, time));

const spanContains = (span: TimeSpan, time: number) =>
    (span.lowClosed ? time >= span.low : time > span.low)
    && (span.highClosed ? time <= span.high : time < span.high);

/**
 * The stretches of clip time one step of playback passed over, in playback order. Each step owns
 * the time it starts at and not the time it ends at, so consecutive steps share no point and a
 * notify on a frame boundary fires on exactly one of them. Forward that is [previous, time);
 * reverse it is (time, previous]. Two exceptions close the far end: a one-shot clip that clamps at
 * its end (it never moves past to claim the point later), and the loop point on a wrap, which is
 * crossed in full (forward: [previous, duration] then [0, time); reverse: [0, previous] then
 * (time, duration]).
 */
const playedSpans = (from: number, to: number, duration: number, looped: boolean, forward: boolean): TimeSpan[] => {
    if (forward) {
        if (to > from) return [{ low: from, high: to, lowClosed: true, highClosed: !looped && to >= duration }];
        if (to < from && looped) {
            return [
                { low: from, high: duration, lowClosed: true, highClosed: true },
                { low: 0, high: to, lowClosed: true, highClosed: false },
            ];
        }
        return [];
    }
    if (to < from) return [{ low: to, high: from, lowClosed: !looped && to <= 0, highClosed: true }];
    if (to > from && looped) {
        return [
            { low: 0, high: from, lowClosed: true, highClosed: true },
            { low: to, high: duration, lowClosed: false, highClosed: true },
        ];
    }
    return [];
};

/**
 * The notifies whose time playback passed between two frames of a state's clip, in playback order
 * (ties keep list order). `previousTime` and `time` are the clip times (seconds) at the previous
 * and current frame and `timeScale` only gives the direction: positive plays forward, negative in
 * reverse, zero fires nothing. On the first frame after entering a state, pass the start as
 * `previousTime` (0 forward, `duration` reverse) so a notify exactly at the start fires; if that
 * frame does not advance, it fires on the first frame that does.
 *
 * A looping clip wraps when its time drops (forward) or rises (reverse); the notifies on both sides
 * of the loop point fire. A one-shot clip clamps at its end, and a notify exactly there fires once
 * on the frame that reaches it; a one-shot whose time moves backwards (a reset) fires nothing.
 * Notify times outside the clip are clamped onto it, non-finite ones never fire, and no notify
 * fires twice in one step. One step is assumed to cover less than a full loop.
 */
export const crossedNotifies = (
    notifies: AnimNotify[] | undefined,
    previousTime: number,
    time: number,
    duration: number,
    looped: boolean,
    timeScale: number,
): AnimNotify[] => {
    if (!notifies?.length) return [];
    if (!Number.isFinite(duration) || duration <= 0) return [];
    if (!Number.isFinite(previousTime) || !Number.isFinite(time)) return [];
    if (!Number.isFinite(timeScale) || timeScale === 0) return [];

    const forward = timeScale > 0;
    const spans = playedSpans(clampTime(previousTime, duration), clampTime(time, duration), duration, looped, forward);
    const fired = new Set<AnimNotify>();
    const crossed: AnimNotify[] = [];
    for (const span of spans) {
        const hits = notifies
            .filter(notify => Number.isFinite(notify.time) && !fired.has(notify))
            .map(notify => ({ notify, at: clampTime(notify.time, duration) }))
            .filter(({ at }) => spanContains(span, at))
            .sort((a, b) => (forward ? a.at - b.at : b.at - a.at));
        for (const { notify } of hits) {
            if (fired.has(notify)) continue;
            fired.add(notify);
            crossed.push(notify);
        }
    }
    return crossed;
};
