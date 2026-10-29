import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { frontendDiagnostics } from '../diagnostics/runtime';
import { acquireAudioListener, releaseSound, routeSoundToBus } from './components/audioComponents';
import { useRuntimeServices } from './RuntimeServicesContext';
import { SpatialParamWriter } from './spatialAudio';
import { SOUND_SPEED, worldClock, type LightningStrike, type WeatherState } from './weather';
import { weatherCover } from './weatherCover';

/**
 * THE WEATHER'S SOUND
 *
 * Synthesized round the listener: rain hissing (muffled under cover, a heavier rumble in a
 * downpour), wind gusting with its speed, and thunder after each lightning strike, as late as
 * sound takes from where it struck and lower and longer the further off. Play only.
 */

const NOISE_SECONDS = 2;
/** Longest thunder waits for a distant strike, s. */
const MAX_THUNDER_DELAY = 9;

/** Weather params, in order: rain level, rain tone cutoff, downpour level, wind level, wind tone. */
export const WEATHER_PARAMS = 5;

/** The params for the weather now; `sheltered` muffles the rain, `gust` 0-1 swells the wind. */
export const weatherSoundValues = (out: Float64Array, weather: WeatherState, sheltered: boolean, gust: number): Float64Array => {
    const rain = Math.max(weather.rain, weather.snow * 0.08);
    out[0] = 0.32 * rain ** 0.7 * (sheltered ? 0.6 : 1);
    out[1] = sheltered ? 1100 : 6500;
    out[2] = 0.3 * weather.rain ** 2;
    const wind = Math.min(1, Math.max(0, (weather.wind - 2) / 18));
    out[3] = 0.42 * wind * (0.6 + 0.4 * gust);
    out[4] = 260 + 520 * wind * (0.5 + 0.5 * gust);
    return out;
};

/** Thunder from a strike `distance` m off: how loud (0-1), how low (its cutoff, Hz) and how long (s). */
export const thunderShape = (distance: number): { level: number; cutoff: number; length: number } => ({
    level: Math.min(1, 900 / Math.max(250, distance)),
    cutoff: 120 + 900 * Math.min(1, 400 / Math.max(250, distance)),
    length: 2.5 + Math.min(1, distance / 2500) * 4,
});

const noiseBuffer = (context: BaseAudioContext): AudioBuffer => {
    const buffer = context.createBuffer(1, Math.floor(context.sampleRate * NOISE_SECONDS), context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
    return buffer;
};

interface WeatherVoice {
    writer: SpatialParamWriter;
    thunder: (strike: LightningStrike) => void;
    stop: () => void;
}

const synthesizeWeather = (sound: THREE.Audio): WeatherVoice => {
    const context = sound.context;
    const buffer = noiseBuffer(context);
    const noise = context.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;
    // Rain: a bright hiss, and a low roar for a downpour.
    const hiss = context.createBiquadFilter();
    hiss.type = 'highpass';
    hiss.frequency.value = 500;
    const hissTone = context.createBiquadFilter();
    hissTone.type = 'lowpass';
    hissTone.frequency.value = 6500;
    const hissLevel = context.createGain();
    hissLevel.gain.value = 0;
    const roar = context.createBiquadFilter();
    roar.type = 'lowpass';
    roar.frequency.value = 320;
    const roarLevel = context.createGain();
    roarLevel.gain.value = 0;
    // Wind: a band that rises and swells with the gusts.
    const wind = context.createBiquadFilter();
    wind.type = 'bandpass';
    wind.frequency.value = 400;
    wind.Q.value = 0.9;
    const windLevel = context.createGain();
    windLevel.gain.value = 0;
    const out = context.createGain();
    noise.connect(hiss).connect(hissTone).connect(hissLevel).connect(out);
    noise.connect(roar).connect(roarLevel).connect(out);
    noise.connect(wind).connect(windLevel).connect(out);
    sound.setNodeSource(out);
    noise.start();
    return {
        writer: new SpatialParamWriter([hissLevel.gain, hissTone.frequency, roarLevel.gain, windLevel.gain, wind.frequency]),
        thunder: strike => {
            if (context.state !== 'running') return;
            const { level, cutoff, length } = thunderShape(strike.distance);
            const start = context.currentTime + Math.min(MAX_THUNDER_DELAY, strike.distance / SOUND_SPEED);
            const source = context.createBufferSource();
            source.buffer = buffer;
            source.loop = true;
            const tone = context.createBiquadFilter();
            tone.type = 'lowpass';
            tone.frequency.value = cutoff;
            tone.Q.value = 0.8;
            const envelope = context.createGain();
            // A crack (near strikes), then rolling rumbles that die away.
            envelope.gain.setValueAtTime(0.0001, start);
            envelope.gain.linearRampToValueAtTime(level * (strike.distance < 600 ? 1.4 : 0.6), start + 0.04);
            let t = start + 0.25;
            const end = start + length;
            while (t < end) {
                const fade = 1 - (t - start) / length;
                envelope.gain.linearRampToValueAtTime(level * fade * (0.35 + 0.65 * Math.random()), t);
                t += 0.15 + Math.random() * 0.45;
            }
            envelope.gain.exponentialRampToValueAtTime(0.0001, end + 0.4);
            source.connect(tone).connect(envelope).connect(out);
            source.start(start, Math.random() * NOISE_SECONDS);
            source.stop(end + 0.5);
            source.onended = () => {
                source.disconnect();
                tone.disconnect();
                envelope.disconnect();
            };
        },
        stop: () => {
            try { noise.stop(); } catch { /* never started */ }
            noise.disconnect();
            for (const node of [hiss, hissTone, hissLevel, roar, roarLevel, wind, windLevel, out]) node.disconnect();
        },
    };
};

const _listener = new THREE.Vector3();

/** The weather's sound, heard through the camera. Mount once, in play. */
export const WeatherAudio: React.FC = () => {
    const camera = useThree(state => state.camera);
    const { mixer } = useRuntimeServices();
    const voice = useRef<{ sound: THREE.Audio; voice: WeatherVoice } | null>(null);
    const values = useRef(new Float64Array(WEATHER_PARAMS));
    const heard = useRef(-1);
    const gust = useRef({ phase: Math.random() * 10, value: 0.5 });

    useEffect(() => {
        const { listener, release } = acquireAudioListener(camera);
        const sound = new THREE.Audio(listener);
        routeSoundToBus(sound, mixer, 'sfx');
        let made: WeatherVoice | null = null;
        try {
            made = synthesizeWeather(sound);
            voice.current = { sound, voice: made };
        } catch (error) {
            frontendDiagnostics.failure('weather_audio_failed', error);
        }
        return () => {
            voice.current = null;
            made?.stop();
            releaseSound(sound);
            release();
        };
    }, [camera, mixer]);

    useEffect(() => {
        if (voice.current) routeSoundToBus(voice.current.sound, mixer, 'sfx');
    }, [mixer]);

    useFrame((_, delta) => {
        const current = voice.current;
        if (!current) return;
        // Gusts: a slow wander of two waves.
        const g = gust.current;
        g.phase += delta;
        g.value = 0.5 + 0.3 * Math.sin(g.phase * 0.37) + 0.2 * Math.sin(g.phase * 1.13 + 1.7);
        camera.getWorldPosition(_listener);
        const sheltered = weatherCover.sheltered(_listener.x, _listener.y, _listener.z);
        current.voice.writer.write(current.sound.context, weatherSoundValues(values.current, worldClock.weather, sheltered, g.value));
        const strike = worldClock.strike;
        if (strike && strike.id !== heard.current) {
            heard.current = strike.id;
            current.voice.thunder(strike);
        }
    });

    return null;
};
