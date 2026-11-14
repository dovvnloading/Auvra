import { particleEmitters, type ParticleEmitterHandle, type ParticleScope } from '../particleEmitters';
import type { TimelineData, TimelineParticleCueValue } from './types';

interface ParticleCue {
    time: number;
    objectId: string;
    componentId: string;
    value: TimelineParticleCueValue;
}

/** Bind the timeline's tracks once. Stable sort preserves track and key order at equal times. */
export function compileTimelineParticleCues(data: TimelineData): ParticleCue[] {
    const cues: ParticleCue[] = [];
    for (const track of data.tracks) {
        if (track.kind !== 'particle' || track.muted || !track.objectId || !track.componentId) continue;
        for (const { time, value } of track.keys) {
            if (time >= 0 && time <= data.duration) cues.push({ time, value, objectId: track.objectId, componentId: track.componentId });
        }
    }
    return cues.sort((a, b) => a.time - b.time);
}

function runCue(handle: ParticleEmitterHandle, cue: TimelineParticleCueValue): void {
    switch (cue.action) {
        case 'burst': handle.emit(cue.count); break;
        case 'play': handle.play(); break;
        case 'stop': handle.stop(); break;
    }
}

const auditionHandles = new Map<ParticleEmitterHandle, boolean>();
function auditionCue(handle: ParticleEmitterHandle, value: TimelineParticleCueValue): void {
    if (!auditionHandles.has(handle)) {
        auditionHandles.set(handle, handle.isPlaying());
        handle.setAuditioning?.(true);
    }
    runCue(handle, value);
}

/**
 * Forward playback issues commands in (previous,time]. A negative previous time includes the zero key;
 * a loop finishes the outgoing cycle before dispatching zero on the incoming cycle. Seeking the
 * timeline evaluates its state directly and never calls this function.
 */
export function dispatchTimelineParticleCues(
    scope: ParticleScope, cues: readonly ParticleCue[], previous: number, time: number, wraps = 0,
): void {
    if (!cues.length) return;
    for (let lap = 0; lap <= wraps; lap++) {
        const from = lap === 0 ? previous : -1;
        const to = lap === wraps ? time : Infinity;
        for (const cue of cues) {
            if (cue.time > to) break;
            if (cue.time <= from) continue;
            if (scope === 'editor') {
                for (const handle of particleEmitters.editorViews(cue.objectId, cue.componentId)) auditionCue(handle, cue.value);
            } else {
                const handle = particleEmitters.get('runtime', cue.objectId, cue.componentId);
                if (handle) runCue(handle, cue.value);
            }
        }
    }
}

const previewCache = new WeakMap<TimelineData, ParticleCue[]>();

function previewCues(data: TimelineData): ParticleCue[] {
    let cues = previewCache.get(data);
    if (!cues) {
        cues = compileTimelineParticleCues(data);
        previewCache.set(data, cues);
    }
    return cues;
}

/** Resume from a position using the latest continuous emission command. Bursts stay on crossings. */
export function beginTimelineParticleAudition(data: TimelineData, time: number): void {
    if (time <= 0) return;
    const last = new Map<ParticleEmitterHandle, TimelineParticleCueValue>();
    for (const cue of previewCues(data)) {
        if (cue.time > time) break;
        if (cue.value.action === 'burst') continue;
        for (const handle of particleEmitters.editorViews(cue.objectId, cue.componentId)) last.set(handle, cue.value);
    }
    for (const [handle, value] of last) auditionCue(handle, value);
}

/** Restore preview emission and automatic replay for the mounted layers this audition controlled. */
export function endTimelineParticleAudition(): void {
    for (const [handle, wasPlaying] of auditionHandles) {
        const current = particleEmitters.editorViews(handle.objectId, handle.componentId);
        for (const mounted of current) {
            if (mounted !== handle) continue;
            handle.setAuditioning?.(false);
            if (wasPlaying && !handle.isPlaying()) handle.play();
            if (!wasPlaying && handle.isPlaying()) handle.stop();
        }
    }
    auditionHandles.clear();
}

/** The modal calls this only while advancing the editor playhead through time. */
export function auditionTimelineParticles(data: TimelineData, previousTime: number, time: number): void {
    if (previousTime < time) dispatchTimelineParticleCues('editor', previewCues(data), previousTime, time);
}
