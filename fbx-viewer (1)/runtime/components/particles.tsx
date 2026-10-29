import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { TextureData } from '../../types';
import { useGameContent } from '../GameContentContext';
import {
    EDITOR_PARTICLE_LIMIT,
    resolveParticleEffect,
    RUNTIME_PARTICLE_LIMIT,
    type BuiltinSprite,
    type ParticleEffect,
} from '../particleEffect';
import { particleEmitters } from '../particleEmitters';
import { ParticleRenderer } from '../particleRenderer';
import { ParticleSimulation, type ParticleRaycast } from '../particleSimulation';
import { builtinSpriteTexture, SPRITE_GRIDS } from '../particleSprites';
import { usePhysicsAvailable, usePhysicsQueries } from '../physics';
import { collectHostGeometry, PHYSICS_IGNORED_USER_DATA } from './physicsComponents';
import type { ComponentDefinition, ComponentRenderProps } from './types';

/**
 * PARTICLES
 *
 * The Particles component runs one emitter (see particleEffect for what an effect holds). In the
 * editor it previews live, one-shot effects replaying; in play it starts by itself unless Play on
 * Start is off, and level scripts, gameplay scripts and other emitters' sub-emitter events start,
 * stop and burst it through the particle emitter registry.
 */

/** Seconds an editor preview of a one-shot effect waits after it ends before replaying. */
const PREVIEW_REPLAY_DELAY = 1;

const loadedTextures = new Map<string, THREE.Texture>();

/** The effect's sprite texture and flipbook grid: a built-in sprite, or a project texture. */
const spriteFor = (effect: ParticleEffect, textures: readonly TextureData[]): { texture: THREE.Texture; grid: [number, number] } => {
    const sprite = effect.render.sprite;
    if (sprite.startsWith('texture:')) {
        const asset = textures.find(texture => texture.id === sprite.slice('texture:'.length));
        if (asset?.url) {
            let texture = loadedTextures.get(asset.url);
            if (!texture) {
                texture = new THREE.TextureLoader().load(asset.url);
                texture.colorSpace = THREE.SRGBColorSpace;
                loadedTextures.set(asset.url, texture);
            }
            return { texture, grid: [effect.render.columns, effect.render.rows] };
        }
        return { texture: builtinSpriteTexture('soft'), grid: [1, 1] };
    }
    return { texture: builtinSpriteTexture(sprite as BuiltinSprite), grid: SPRITE_GRIDS[sprite as BuiltinSprite] ?? [1, 1] };
};

const _from = new THREE.Vector3();
const _direction = new THREE.Vector3();

const ParticlesRender: React.FC<ComponentRenderProps> = ({ object, component, mode }) => {
    const editor = mode === 'editor';
    const effect = useMemo(() => resolveParticleEffect(component.props), [component.props]);
    const playOnStart = component.props.playOnStart !== false;
    const capacity = Math.min(editor ? EDITOR_PARTICLE_LIMIT : RUNTIME_PARTICLE_LIMIT, effect.maxParticles);
    const { textures } = useGameContent();
    const queries = usePhysicsQueries();
    const physics = usePhysicsAvailable();
    const anchor = useRef<THREE.Group>(null);
    const effectRef = useRef(effect);
    effectRef.current = effect;

    const simulation = useMemo(() => new ParticleSimulation(effect, capacity), [capacity]);
    const renderer = useMemo(() => new ParticleRenderer(capacity), [capacity]);
    useEffect(() => () => renderer.dispose(), [renderer]);
    const sprite = useMemo(() => spriteFor(effect, textures), [effect, textures]);

    // Layout effect: the look is in place before the first frame draws anything.
    useLayoutEffect(() => {
        simulation.setEffect(effect);
        renderer.setLook(effect, sprite.texture, sprite.grid);
    }, [simulation, renderer, effect, sprite]);

    // The light some effects carry (fire, explosions, muzzle flashes). It stays in the scene, dark
    // while there is nothing to light: adding and removing lights recompiles every lit material.
    const light = useMemo(() => {
        if (!effect.light.enabled) return null;
        const point = new THREE.PointLight(effect.light.color, 0, effect.light.range, 2);
        point.castShadow = false;
        return point;
    }, [effect.light.enabled]);
    useEffect(() => {
        if (!light) return;
        light.color.set(effect.light.color);
        light.distance = effect.light.range;
    }, [light, effect.light.color, effect.light.range]);
    useEffect(() => () => light?.dispose(), [light]);

    // The model's surface, for the mesh shape.
    useLayoutEffect(() => {
        const host = anchor.current?.parent;
        if (effect.shape.kind !== 'mesh' || !host) {
            simulation.setMeshSurface(null);
            return;
        }
        const geometry = collectHostGeometry(host, object.id);
        simulation.setMeshSurface(geometry ? { positions: geometry.positions, indices: geometry.indices } : null);
    }, [simulation, effect.shape.kind, object.id]);

    // Starts with the play session (or always in the editor), prewarmed when asked.
    const started = useRef(false);
    useLayoutEffect(() => {
        started.current = false;
        if (editor || playOnStart) simulation.play();
        else simulation.stop();
    }, [simulation, editor, playOnStart]);

    const scope = editor ? 'editor' : 'runtime';
    useEffect(() => particleEmitters.register(scope, {
        objectId: object.id,
        componentId: component.id,
        play: () => simulation.play(),
        stop: clear => simulation.stop(clear),
        emit: count => {
            const host = anchor.current?.parent;
            if (!host) return;
            host.updateWorldMatrix(true, false);
            const at = new THREE.Vector3().setFromMatrixPosition(host.matrixWorld);
            simulation.emitAt(Math.max(0, Math.round(count)), at.x, at.y, at.z);
        },
        emitAt: (count, x, y, z, vx = 0, vy = 0, vz = 0) => simulation.emitAt(Math.max(0, Math.round(count)), x, y, z, vx, vy, vz),
        isPlaying: () => simulation.isEmitting,
        alive: () => simulation.count,
    }), [scope, object.id, component.id, simulation]);

    const raycast = useMemo((): ParticleRaycast | null => (physics ? (fx, fy, fz, tx, ty, tz) => {
        _from.set(fx, fy, fz);
        _direction.set(tx - fx, ty - fy, tz - fz);
        const length = _direction.length();
        if (length < 1e-5) return null;
        const hit = queries.raycast(_from, _direction, length, { excludeObjectId: object.id });
        return hit ? { x: hit.point.x, y: hit.point.y, z: hit.point.z, nx: hit.normal.x, ny: hit.normal.y, nz: hit.normal.z } : null;
    } : null), [physics, queries, object.id]);

    const idle = useRef(0);
    const peak = useRef(1);
    const clock = useRef(0);

    useFrame((state, delta) => {
        const host = anchor.current?.parent;
        if (!host) return;
        const current = effectRef.current;
        host.updateWorldMatrix(true, false);
        if (!started.current) {
            started.current = true;
            if (current.loop && current.prewarm && simulation.isEmitting) simulation.prewarm(host.matrixWorld.elements);
        }
        simulation.step(delta, host.matrixWorld.elements, raycast);

        // Sub-emitters: other emitters on the object set off where these particles died or hit.
        if (simulation.events.length) {
            for (const event of simulation.events) {
                for (const sub of current.subEmitters) {
                    if (sub.trigger !== event.trigger) continue;
                    const target = particleEmitters.get(scope, object.id, sub.target);
                    target?.emitAt(sub.count, event.x, event.y, event.z, event.vx * sub.inheritVelocity, event.vy * sub.inheritVelocity, event.vz * sub.inheritVelocity);
                }
            }
            simulation.events.length = 0;
        }

        // An editor preview of a one-shot effect replays a moment after it ends.
        if (editor && simulation.isDone) {
            idle.current += delta;
            if (idle.current > PREVIEW_REPLAY_DELAY) {
                idle.current = 0;
                simulation.play();
            }
        } else idle.current = 0;

        renderer.update(simulation, host.matrixWorld, state.camera);

        if (light) {
            // As bright as the effect is busy, against the most it has been lately.
            clock.current += delta;
            peak.current = Math.max(1, peak.current * Math.exp(-delta * 0.5), simulation.count);
            const strength = Math.min(1, Math.sqrt(simulation.count / peak.current));
            const flicker = 1 - current.light.flicker * 0.5 * (1 + Math.sin(clock.current * 23) * 0.6 + Math.sin(clock.current * 37) * 0.4) * 0.5;
            light.intensity = current.light.intensity * strength * flicker;
        }
    });

    return (
        <group ref={anchor} userData={PHYSICS_IGNORED_USER_DATA}>
            <primitive object={renderer.object} />
            {light && <primitive object={light} />}
        </group>
    );
};

// --- DEFINITION ---

export const PARTICLES_COMPONENT: ComponentDefinition = {
    type: 'particles',
    label: 'Particles',
    description: 'A particle effect: smoke, fire, sparks, rain, explosions, trails and more. Pick a preset and shape it: where particles come from, how they move, '
        + 'change over their life and look, what they hit and what they set off. Plays by itself, or from level and gameplay scripts.',
    props: [
        { key: 'playOnStart', label: 'Play on start', type: 'boolean', default: true },
    ],
    Render: ParticlesRender,
};
