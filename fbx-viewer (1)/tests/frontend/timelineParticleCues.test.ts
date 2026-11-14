import { afterEach, describe, expect, it, vi } from 'vitest';
import { particleEmitters, type ParticleEmitterHandle, type ParticleScope } from '../../runtime/particleEmitters';
import { normalizeTimeline } from '../../runtime/timeline/evaluate';
import {
    auditionTimelineParticles, beginTimelineParticleAudition, compileTimelineParticleCues,
    dispatchTimelineParticleCues, endTimelineParticleAudition,
} from '../../runtime/timeline/particleCues';
import type { TimelineData, TimelineKey, TimelineParticleCueValue, TimelineParticleTrack } from '../../runtime/timeline/types';

const cleanups: Array<() => void> = [];
afterEach(() => { endTimelineParticleAudition(); cleanups.splice(0).forEach(cleanup => cleanup()); });

const key = (time: number, action: 'play' | 'stop' | number): TimelineKey<TimelineParticleCueValue> =>
    ({ time, value: typeof action === 'number' ? { action: 'burst', count: action } : { action } });
const track = (id: string, componentId: string, ...keys: TimelineKey<TimelineParticleCueValue>[]): TimelineParticleTrack =>
    ({ kind: 'particle', id, objectId: 'torch', componentId, keys });
function register(scope: ParticleScope, id: string, calls: string[], label = id) {
    let playing = true;
    const handle: ParticleEmitterHandle = {
        objectId: 'torch', componentId: id, emitAt() {}, alive: () => 0,
        play() { playing = true; calls.push(label + ' play'); }, stop() { playing = false; calls.push(label + ' stop'); },
        emit(n) { calls.push(label + ' ' + n); }, isPlaying: () => playing, setAuditioning: vi.fn(),
    };
    cleanups.push(particleEmitters.register(scope, handle));
    return handle;
}

describe('timeline particle cues', () => {
    it('normalizes bindings, commands, burst counts, invalid keys and stable equal-time order', () => {
        const result = normalizeTimeline({ duration: 1, tracks: [
            { kind: 'particle', id: 'bad', objectId: 'torch', keys: [] },
            { ...track('good', 'a'), keys: [key(0.5, 9000), key(0.1, 'play'), key(0.5, -4), key(0.5, 'stop'),
                { time: 0, value: { action: 'delete' } }, { time: 0.75, value: { action: 'burst' } }] },
        ] });
        expect(result.tracks).toEqual([track('good', 'a', key(0.1, 'play'), key(0.5, 5000), key(0.5, 1), key(0.5, 'stop'), key(0.75, 10))]);
    });

    it('handles full laps, end and start keys, equal times, skipped targets and scope', () => {
        const calls: string[] = [];
        register('runtime', 'a', calls); register('runtime', 'b', calls); register('editor', 'a', calls, 'editor');
        const cues = compileTimelineParticleCues({ duration: 1, tracks: [
            track('a1', 'a', key(0, 'play'), key(0.2, 3), key(1, 'stop')),
            track('b1', 'b', key(0.2, 5), key(2, 'play')),
            { ...track('muted', 'a', key(0, 99)), muted: true },
            track('missing', 'unknown', key(0, 17)),
        ] });
        dispatchTimelineParticleCues('runtime', cues, -1, 0.2, 2);
        const lap = ['a play', 'a 3', 'b 5', 'a stop'];
        expect(calls).toEqual([...lap, ...lap, 'a play', 'a 3', 'b 5']);
        dispatchTimelineParticleCues('runtime', cues, 0.2, 0.2);
        expect(calls).toHaveLength(11);
    });

    it('auditions every view of one emitter, applies state on resume without bursting, and restores previews', () => {
        const calls: string[] = [];
        const handle = register('editor', 'a', calls, 'main');
        const second = register('editor', 'a', calls, 'quad');
        const sibling = register('editor', 'b', calls);
        register('runtime', 'a', calls, 'runtime');
        const data: TimelineData = { duration: 5, tracks: [track('cues', 'a', key(0, 7), key(0.2, 'stop'), key(4, 'play'))] };
        auditionTimelineParticles(data, -1, 0);
        auditionTimelineParticles(data, 0, 0.3);
        auditionTimelineParticles(data, 0.3, 2.5);
        expect(calls).toEqual(['main 7', 'quad 7', 'main stop', 'quad stop']);
        expect(handle.setAuditioning).toHaveBeenCalledExactlyOnceWith(true);
        expect(second.isPlaying()).toBe(false);
        expect(sibling.isPlaying()).toBe(true);
        endTimelineParticleAudition();
        expect(handle.setAuditioning).toHaveBeenLastCalledWith(false);
        expect(handle.isPlaying()).toBe(true);
        calls.length = 0;
        auditionTimelineParticles(data, 1, 0);
        auditionTimelineParticles(data, 1, 1);
        expect(calls).toEqual([]);
        beginTimelineParticleAudition(data, 2.5);
        expect(calls).toEqual(['main stop', 'quad stop']);
        auditionTimelineParticles(data, 2.5, 4);
        expect(calls.slice(-2)).toEqual(['main play', 'quad play']);
    });
});
