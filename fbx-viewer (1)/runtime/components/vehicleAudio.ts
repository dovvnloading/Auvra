import { SpatialParamWriter, type SpatialPositionalAudio } from '../spatialAudio';
import { SURFACES } from '../surfaces';
import type { VehicleTelemetry } from '../vehicles';

/**
 * A vehicle's synthesized sound: its engine (when it has no recording), and the road under it:
 * tyres squealing on hard ground, loose ground rumbling and spitting under them, wind at speed,
 * and knocks from impacts and hard landings. All driven by the simulation's telemetry.
 */

const NOISE_SECONDS = 1;

const noiseBuffer = (context: BaseAudioContext): AudioBuffer => {
    const buffer = context.createBuffer(1, Math.floor(context.sampleRate * NOISE_SECONDS), context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
    return buffer;
};

export interface SynthVoice {
    writer: SpatialParamWriter;
    stop: () => void;
}

/** Engine params, in order: firing frequency, sub, second harmonic, tone cutoff, level. */
export const ENGINE_PARAMS = 5;

/**
 * A synthesized engine: oscillators at the firing rate, half and twice it, through a low-pass whose
 * cutoff opens with load and revs.
 */
export const synthesizeEngine = (sound: SpatialPositionalAudio): SynthVoice => {
    const context = sound.context;
    const engine = context.createOscillator();
    engine.type = 'sawtooth';
    const sub = context.createOscillator();
    sub.type = 'triangle';
    const harmonic = context.createOscillator();
    harmonic.type = 'square';
    harmonic.detune.value = 7;
    const subLevel = context.createGain();
    subLevel.gain.value = 0.7;
    const harmonicLevel = context.createGain();
    harmonicLevel.gain.value = 0.12;
    const tone = context.createBiquadFilter();
    tone.type = 'lowpass';
    tone.Q.value = 1.5;
    const level = context.createGain();
    level.gain.value = 0;
    engine.connect(tone);
    sub.connect(subLevel).connect(tone);
    harmonic.connect(harmonicLevel).connect(tone);
    tone.connect(level);
    sound.setNodeSource(level);
    for (const source of [engine, sub, harmonic]) source.start();
    return {
        writer: new SpatialParamWriter([engine.frequency, sub.frequency, harmonic.frequency, tone.frequency, level.gain]),
        stop: () => {
            for (const source of [engine, sub, harmonic]) {
                try { source.stop(); } catch { /* never started */ }
                source.disconnect();
            }
            for (const node of [subLevel, harmonicLevel, tone, level]) node.disconnect();
        },
    };
};

/** The engine's params from its revs (0 idle - 1 redline), rpm, load (throttle) and whether a gear change is cutting it. */
export const engineSoundValues = (out: Float64Array, rpm: number, revs: number, load: number, shifting: boolean, running: boolean, volume: number): Float64Array => {
    out[0] = rpm / 30;
    out[1] = rpm / 60;
    out[2] = rpm / 15;
    out[3] = 300 + 2400 * load + 1500 * revs;
    out[4] = running ? volume * (0.2 + 0.32 * load + 0.18 * revs) * (shifting ? 0.55 : 1) : 0;
    return out;
};

export interface RoadVoice extends SynthVoice {
    /** A knock, 0-1: an impact or a hard landing. */
    thump: (strength: number) => void;
}

/** Road params, in order: squeal pitch, squeal level, rumble cutoff, rumble level, wind level. */
export const ROAD_PARAMS = 5;

export const synthesizeRoad = (sound: SpatialPositionalAudio): RoadVoice => {
    const context = sound.context;
    const buffer = noiseBuffer(context);
    const noise = context.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;
    const squeal = context.createBiquadFilter();
    squeal.type = 'bandpass';
    squeal.frequency.value = 1400;
    squeal.Q.value = 3;
    const squealLevel = context.createGain();
    squealLevel.gain.value = 0;
    const rumble = context.createBiquadFilter();
    rumble.type = 'lowpass';
    rumble.frequency.value = 400;
    rumble.Q.value = 0.7;
    const rumbleLevel = context.createGain();
    rumbleLevel.gain.value = 0;
    const wind = context.createBiquadFilter();
    wind.type = 'bandpass';
    wind.frequency.value = 520;
    wind.Q.value = 0.6;
    const windLevel = context.createGain();
    windLevel.gain.value = 0;
    const out = context.createGain();
    noise.connect(squeal).connect(squealLevel).connect(out);
    noise.connect(rumble).connect(rumbleLevel).connect(out);
    noise.connect(wind).connect(windLevel).connect(out);
    sound.setNodeSource(out);
    noise.start();
    return {
        writer: new SpatialParamWriter([squeal.frequency, squealLevel.gain, rumble.frequency, rumbleLevel.gain, windLevel.gain]),
        thump: strength => {
            // One-shot nodes of its own, so nothing piles up on the looping layers' params.
            if (context.state !== 'running' || !(strength > 0)) return;
            const now = context.currentTime;
            const hit = context.createBufferSource();
            hit.buffer = buffer;
            const body = context.createBiquadFilter();
            body.type = 'lowpass';
            body.frequency.value = 140 + 260 * strength;
            const envelope = context.createGain();
            envelope.gain.setValueAtTime(Math.min(1.5, 0.3 + 1.2 * strength), now);
            envelope.gain.exponentialRampToValueAtTime(0.001, now + 0.25 + 0.35 * strength);
            hit.connect(body).connect(envelope).connect(out);
            hit.start(now, Math.random() * (NOISE_SECONDS - 0.7), 0.7);
            hit.onended = () => {
                hit.disconnect();
                body.disconnect();
                envelope.disconnect();
            };
        },
        stop: () => {
            try { noise.stop(); } catch { /* never started */ }
            noise.disconnect();
            for (const node of [squeal, squealLevel, rumble, rumbleLevel, wind, windLevel, out]) node.disconnect();
        },
    };
};

/**
 * The road's params from the telemetry: squeal from tyres sliding on hard ground, rumble from
 * rolling (louder and grittier on loose ground, more so sliding), wind growing with speed.
 */
export const roadSoundValues = (out: Float64Array, telemetry: VehicleTelemetry, volume: number): Float64Array => {
    const speed = Math.abs(telemetry.speed);
    let squeal = 0;
    let loose = 0;
    let looseSlide = 0;
    let rolling = 0;
    for (const wheel of telemetry.wheels) {
        if (!wheel.contact) continue;
        const surface = SURFACES[wheel.surface];
        const slide = Math.max(Math.abs(wheel.slipAngle) / 0.35, Math.abs(wheel.slipRatio) / 0.4);
        rolling++;
        if (surface.loose || surface.kick === 'spray') {
            loose++;
            looseSlide = Math.max(looseSlide, slide);
        } else if (surface.kick === 'smoke') {
            squeal = Math.max(squeal, Math.min(1, Math.max(0, slide - 0.6) * 1.5) * Math.min(1, wheel.groundSpeed / 3));
        }
    }
    const looseShare = rolling ? loose / rolling : 0;
    const pace = Math.min(1, speed / 20);
    out[0] = 1150 + 600 * squeal;
    out[1] = volume * 0.35 * squeal;
    out[2] = looseShare > 0 ? 450 + 900 * pace : 220 + 380 * pace;
    out[3] = volume * (0.05 * Math.min(1, speed / 30) * (1 - looseShare) + looseShare * (0.32 * pace + 0.22 * Math.min(1, Math.max(0, looseSlide - 0.5))));
    out[4] = volume * 0.22 * Math.min(1, (speed / 45) ** 2);
    return out;
};
