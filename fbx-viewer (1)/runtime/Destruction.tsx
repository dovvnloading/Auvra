import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useRapier } from '@react-three/rapier';
import type { RapierRigidBody } from '@react-three/rapier';
import { acquireAudioListener, releaseSound, routeSoundToBus } from './components/audioComponents';
import { DebrisWorld, type DebrisPhysics } from './debris';
import { destructibles, explosionFalloff, provideCombat, type Vec3 } from './destructibles';
import { ImpactEffects } from './impactEffects';
import { useRuntimeServices } from './RuntimeServicesContext';
import { SpatialPositionalAudio } from './spatialAudio';

/**
 * THE DESTRUCTION LAYER
 *
 * One per play session, inside the physics world: it keeps the debris of broken objects (Rapier
 * bodies with convex hull colliders), the impact and explosion effects, and their sound, and it
 * provides the combat services (runtime/destructibles.ts) that shots, explosions, scripts and
 * Destructible components use. It also remembers every loose body's velocity from before each
 * physics step, so a Destructible hit by one can tell how fast it was going.
 */

const NOISE_SECONDS = 2;

const noiseBuffer = (context: BaseAudioContext): AudioBuffer => {
    const buffer = context.createBuffer(1, Math.floor(context.sampleRate * NOISE_SECONDS), context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
    return buffer;
};

/** A synthesized one-shot: a crunch when something breaks, a boom for an explosion. */
const playSynth = (
    sound: SpatialPositionalAudio,
    buffer: AudioBuffer,
    kind: 'break' | 'explosion',
    strength: number,
    done: () => void,
): void => {
    const context = sound.context;
    const now = context.currentTime;
    const out = context.createGain();
    const parts: AudioNode[] = [out];
    const layer = (type: BiquadFilterType, frequency: number, q: number, peak: number, attack: number, decay: number, offset = 0) => {
        const source = context.createBufferSource();
        source.buffer = buffer;
        const filter = context.createBiquadFilter();
        filter.type = type;
        filter.frequency.value = frequency;
        filter.Q.value = q;
        const envelope = context.createGain();
        envelope.gain.setValueAtTime(0.0001, now + offset);
        envelope.gain.linearRampToValueAtTime(peak, now + offset + attack);
        envelope.gain.exponentialRampToValueAtTime(0.0001, now + offset + attack + decay);
        source.connect(filter).connect(envelope).connect(out);
        source.start(now + offset, Math.random() * (NOISE_SECONDS - 0.2) * 0.5);
        source.stop(now + offset + attack + decay + 0.1);
        parts.push(source, filter, envelope);
        return source;
    };
    let last: AudioBufferSourceNode;
    if (kind === 'break') {
        layer('lowpass', 180, 0.8, 1.1 * strength, 0.005, 0.35);
        last = layer('bandpass', 1100, 0.7, 0.8 * strength, 0.004, 0.25);
        // Crackles as the pieces part.
        for (let i = 0; i < 5; i++) last = layer('bandpass', 1800 + Math.random() * 2000, 2, 0.35 * strength, 0.002, 0.06, 0.03 + Math.random() * 0.3);
    } else {
        layer('highpass', 1500, 0.5, 0.9 * strength, 0.003, 0.12);
        layer('lowpass', 420, 0.9, 1.6 * strength, 0.01, 0.9);
        last = layer('lowpass', 110, 0.7, 1.4 * strength, 0.02, 2.6);
    }
    sound.setNodeSource(out as unknown as AudioBufferSourceNode);
    last.onended = () => {
        for (const part of parts) part.disconnect();
        done();
    };
};

export const Destruction: React.FC = () => {
    const { world, rapier } = useRapier();
    const camera = useThree(state => state.camera);
    const scene = useThree(state => state.scene);
    const { mixer } = useRuntimeServices();
    const velocities = useMemo(() => new Map<number, Vec3>(), []);

    const physics = useMemo<DebrisPhysics>(() => ({
        spawn: (hull, position, rotation, velocity, spin, mass) => {
            const collider = rapier.ColliderDesc.convexHull(hull);
            if (!collider) return null;
            const body = world.createRigidBody(
                rapier.RigidBodyDesc.dynamic()
                    .setTranslation(position.x, position.y, position.z)
                    .setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w })
                    .setLinvel(velocity.x, velocity.y, velocity.z)
                    .setAngvel({ x: spin.x, y: spin.y, z: spin.z })
                    .setCcdEnabled(Math.hypot(velocity.x, velocity.y, velocity.z) > 12),
            );
            world.createCollider(collider.setMass(mass).setFriction(0.75).setRestitution(0.12), body);
            body.userData = { debris: true };
            return body;
        },
        pose: (body, position, rotation) => {
            const rigid = body as RapierRigidBody;
            if (!world.getRigidBody(rigid.handle)) return false;
            const t = rigid.translation();
            const r = rigid.rotation();
            position.set(t.x, t.y, t.z);
            rotation.set(r.x, r.y, r.z, r.w);
            return true;
        },
        remove: (body) => {
            const rigid = body as RapierRigidBody;
            if (world.getRigidBody(rigid.handle)) world.removeRigidBody(rigid);
        },
    }), [world, rapier]);

    const debris = useMemo(() => new DebrisWorld(physics), [physics]);
    const effects = useMemo(() => new ImpactEffects(), []);
    const audio = useRef<{ listener: THREE.AudioListener; buffer: AudioBuffer; release: () => void; voices: Set<SpatialPositionalAudio> } | null>(null);

    useEffect(() => {
        const { listener, release } = acquireAudioListener(camera);
        audio.current = { listener, buffer: noiseBuffer(listener.context), release, voices: new Set() };
        return () => {
            for (const voice of audio.current?.voices ?? []) {
                releaseSound(voice);
                voice.removeFromParent();
            }
            audio.current = null;
            release();
        };
    }, [camera]);

    useEffect(() => {
        const sound = (kind: 'break' | 'explosion', at: Vec3, strength: number) => {
            const current = audio.current;
            if (!current || current.listener.context.state !== 'running') return;
            const voice = new SpatialPositionalAudio(current.listener);
            voice.setRefDistance(kind === 'explosion' ? 18 : 5);
            voice.setRolloffFactor(1);
            routeSoundToBus(voice, mixer, 'sfx');
            voice.position.set(at.x, at.y, at.z);
            scene.add(voice);
            current.voices.add(voice);
            playSynth(voice, current.buffer, kind, Math.min(1.2, Math.max(0.2, strength)), () => {
                current.voices.delete(voice);
                releaseSound(voice);
                voice.removeFromParent();
            });
        };
        const withdraw = provideCombat({
            impact: (surface, point, normal, strength) => effects.impact(surface, point, normal, strength),
            pushBodies: (centre, radius, speed) => {
                let pushed = 0;
                world.forEachRigidBody(body => {
                    if (!body.isDynamic()) return;
                    const t = body.translation();
                    const away = new THREE.Vector3(t.x - centre.x, t.y - centre.y, t.z - centre.z);
                    const share = explosionFalloff(away.length(), radius);
                    if (share <= 0) return;
                    if (away.lengthSq() < 1e-6) away.set(0, 1, 0);
                    away.normalize();
                    away.y += 0.35;
                    away.normalize();
                    const change = Math.min(40, speed * share);
                    body.applyImpulse({ x: away.x * change * body.mass(), y: away.y * change * body.mass(), z: away.z * change * body.mass() }, true);
                    body.applyTorqueImpulse({ x: (Math.random() - 0.5) * change * body.mass() * 0.2, y: (Math.random() - 0.5) * change * body.mass() * 0.2, z: (Math.random() - 0.5) * change * body.mass() * 0.2 }, true);
                    pushed++;
                });
                return pushed;
            },
            explosionEffect: (centre, radius) => {
                effects.explosion(centre, radius);
                sound('explosion', centre, Math.min(1.2, 0.5 + radius / 12));
            },
            spawnDebris: (result, materials, matrix, options) => debris.spawn(result, materials, matrix, options),
            breakEffect: (centre, radius, color) => {
                effects.breakApart(centre, radius, color);
                sound('break', centre, Math.min(1.2, 0.4 + radius / 2));
            },
            velocityBefore: handle => velocities.get(handle) ?? null,
        });
        effects.setRaycast((fx, fy, fz, tx, ty, tz) => {
            const direction = { x: tx - fx, y: ty - fy, z: tz - fz };
            const length = Math.hypot(direction.x, direction.y, direction.z);
            if (length < 1e-6) return null;
            const ray = new rapier.Ray({ x: fx, y: fy, z: fz }, { x: direction.x / length, y: direction.y / length, z: direction.z / length });
            const hit = world.castRayAndGetNormal(ray, length, true, rapier.QueryFilterFlags.ONLY_FIXED);
            if (!hit) return null;
            const d = hit.timeOfImpact;
            return { x: fx + ray.dir.x * d, y: fy + ray.dir.y * d, z: fz + ray.dir.z * d, nx: hit.normal.x, ny: hit.normal.y, nz: hit.normal.z };
        });
        return () => {
            withdraw();
            effects.setRaycast(null);
        };
    }, [world, rapier, debris, effects, mixer, scene, velocities]);

    useEffect(() => () => {
        debris.clear();
        effects.dispose();
        destructibles.clear();
    }, [debris, effects]);

    // Before the physics step: each loose body's velocity, for what it hits during the step.
    useFrame(() => {
        velocities.clear();
        world.forEachRigidBody(body => {
            if (!body.isDynamic() || body.isSleeping()) return;
            const v = body.linvel();
            velocities.set(body.handle, { x: v.x, y: v.y, z: v.z });
        });
    }, -2);

    useFrame((state, delta) => {
        const dt = Math.min(0.1, delta);
        debris.update(dt);
        effects.update(dt, state.camera);
    });

    return (
        <>
            <primitive object={debris.object} />
            <primitive object={effects.object} />
        </>
    );
};
