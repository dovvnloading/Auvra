import React, { useContext, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useRapier } from '@react-three/rapier';
import type { LevelComponent } from '../../types';
import { combat, destructibles, type DestructibleHandle, type Vec3 } from '../destructibles';
import { fractureMesh, MAX_FRACTURE_PIECES, MIN_FRACTURE_PIECES, type FractureResult, type FractureSource } from '../fracture';
import { useGameContent } from '../GameContentContext';
import { objectIdFromCollider } from '../physicsQueries';
import { useRuntimeServices } from '../RuntimeServicesContext';
import { findAudioAsset } from './audioComponents';
import { ComponentHostContext } from './builtins';
import { collectHostMeshes } from './physicsComponents';
import type { ComponentDefinition, ComponentRenderProps } from './types';

/**
 * DESTRUCTIBLE COMPONENT
 *
 * Makes an object break into pieces (runtime/fracture.ts) when its health runs out: shots take it
 * down, explosions in reach do, and a heavy loose body (a car) hitting it fast enough breaks it at
 * once and carries on through. The pieces fall as loose physics bodies with dust, chips and a
 * crunch, and the object is gone from the session (a save remembers it broken). Level scripts and
 * gameplay scripts damage and break it too. The fracture is worked out shortly after play starts,
 * once per model, so breaking does not stall a frame.
 */

export const DESTRUCTIBLE_COMPONENT_TYPE = 'destructible';

export const DESTRUCTIBLE_DEFAULTS = {
    health: 100,
    pieces: 12,
    breakSpeed: 7,
    scatter: 2,
    density: 700,
    life: 12,
    interiorColor: '#a08a6c',
    dust: true,
    sound: '',
    seed: 1,
    preview: false,
};

export interface DestructibleSettings {
    /** Damage it takes to break. */
    health: number;
    /** How many pieces. */
    pieces: number;
    /** Speed (m/s) at which a heavy loose body hitting it breaks it at once; 0: never. */
    breakSpeed: number;
    /** How fast the pieces fly apart, m/s. */
    scatter: number;
    /** kg per cubic metre, for the pieces' weight. */
    density: number;
    /** Seconds the pieces stay before shrinking away; 0: they stay. */
    life: number;
    /** Colour of the cut faces inside. */
    interiorColor: string;
    /** A dust cloud and chips as it breaks. */
    dust: boolean;
    /** Audio asset (id or name) played as it breaks; blank: a synthesized crunch. */
    sound: string;
    /** The break pattern: change it for another. */
    seed: number;
    /** In the editor, show the pieces instead of the model. */
    preview: boolean;
}

const number = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

export const readDestructibleSettings = (component: LevelComponent): DestructibleSettings => {
    const props = component.props;
    return {
        health: number(props.health, DESTRUCTIBLE_DEFAULTS.health, 0, 1e6),
        pieces: Math.round(number(props.pieces, DESTRUCTIBLE_DEFAULTS.pieces, MIN_FRACTURE_PIECES, MAX_FRACTURE_PIECES)),
        breakSpeed: number(props.breakSpeed, DESTRUCTIBLE_DEFAULTS.breakSpeed, 0, 200),
        scatter: number(props.scatter, DESTRUCTIBLE_DEFAULTS.scatter, 0, 50),
        density: number(props.density, DESTRUCTIBLE_DEFAULTS.density, 10, 20000),
        life: number(props.life, DESTRUCTIBLE_DEFAULTS.life, 0, 3600),
        interiorColor: typeof props.interiorColor === 'string' && /^#[0-9a-f]{6}$/i.test(props.interiorColor) ? props.interiorColor : DESTRUCTIBLE_DEFAULTS.interiorColor,
        dust: typeof props.dust === 'boolean' ? props.dust : DESTRUCTIBLE_DEFAULTS.dust,
        sound: typeof props.sound === 'string' ? props.sound.trim() : '',
        seed: Math.round(number(props.seed, DESTRUCTIBLE_DEFAULTS.seed, 0, 1e6)),
        preview: props.preview === true,
    };
};

/** A model's triangles and materials, in the space of the object that holds it (before its scale). */
export interface DestructibleSource {
    source: FractureSource;
    materials: THREE.Material[];
    /** Its bounds in that space. */
    min: THREE.Vector3;
    max: THREE.Vector3;
    /** Identifies the model's geometry, for sharing a fracture between copies. */
    key: string;
}

/**
 * The meshes under `host` that belong to object `objectId` (not skinned characters, nor anything
 * under `own`: the component's own nodes), as one fracture source.
 */
export const destructibleSource = (host: THREE.Object3D, objectId: string, own?: THREE.Object3D | null): DestructibleSource | null => {
    host.updateWorldMatrix(true, true);
    const meshes = collectHostMeshes(host, objectId, node => node === own).filter(mesh => !(mesh as THREE.SkinnedMesh).isSkinnedMesh);
    if (meshes.length === 0) return null;
    const toHost = new THREE.Matrix4().copy(host.matrixWorld).invert();
    const relative = new THREE.Matrix4();
    const normalMatrix = new THREE.Matrix3();
    const materials: THREE.Material[] = [];
    const slotOf = (material: THREE.Material | undefined): number => {
        const found = material ? materials.indexOf(material) : -1;
        if (found >= 0) return found;
        materials.push(material ?? new THREE.MeshStandardMaterial());
        return materials.length - 1;
    };
    let vertexCount = 0;
    let triangleCount = 0;
    for (const mesh of meshes) {
        const count = mesh.geometry.getAttribute('position').count;
        vertexCount += count;
        triangleCount += Math.floor((mesh.geometry.index ? mesh.geometry.index.count : count) / 3);
    }
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const indices = new Uint32Array(triangleCount * 3);
    const slots = new Uint16Array(triangleCount);
    const vertex = new THREE.Vector3();
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    let vertexOffset = 0;
    let triangleOffset = 0;
    for (const mesh of meshes) {
        const geometry = mesh.geometry;
        const position = geometry.getAttribute('position');
        const normal = geometry.getAttribute('normal');
        const uv = geometry.getAttribute('uv');
        relative.multiplyMatrices(toHost, mesh.matrixWorld);
        normalMatrix.getNormalMatrix(relative);
        for (let i = 0; i < position.count; i++) {
            vertex.fromBufferAttribute(position, i).applyMatrix4(relative);
            positions.set([vertex.x, vertex.y, vertex.z], (vertexOffset + i) * 3);
            min.min(vertex);
            max.max(vertex);
            if (normal) {
                vertex.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize();
                normals.set([vertex.x, vertex.y, vertex.z], (vertexOffset + i) * 3);
            }
            if (uv) uvs.set([uv.getX(i), uv.getY(i)], (vertexOffset + i) * 2);
        }
        const index = geometry.index;
        const triangles = Math.floor((index ? index.count : position.count) / 3);
        const meshMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const groupOf = (triangle: number): number => {
            if (!Array.isArray(mesh.material)) return 0;
            const start = triangle * 3;
            const group = geometry.groups.find(g => start >= g.start && start < g.start + g.count);
            return group?.materialIndex ?? 0;
        };
        for (let t = 0; t < triangles; t++) {
            for (let k = 0; k < 3; k++) indices[(triangleOffset + t) * 3 + k] = vertexOffset + (index ? index.getX(t * 3 + k) : t * 3 + k);
            slots[triangleOffset + t] = slotOf(meshMaterials[groupOf(t)]);
        }
        vertexOffset += position.count;
        triangleOffset += triangles;
    }
    const key = meshes.map(mesh => `${mesh.geometry.uuid}`).join('+');
    return { source: { positions, normals, uvs, indices, materials: slots }, materials, min, max, key };
};

/** Fractures already worked out, by model and settings: copies of one model share them. */
const fractureCache = new Map<string, FractureResult>();
/** Most fractures kept. */
const FRACTURE_CACHE_SIZE = 64;

export const cachedFracture = (source: DestructibleSource, pieces: number, seed: number): FractureResult => {
    const key = `${source.key}|${pieces}|${seed}`;
    const cached = fractureCache.get(key);
    if (cached) return cached;
    const result = fractureMesh(source.source, { pieces, seed, interiorScale: 1.5 });
    if (fractureCache.size >= FRACTURE_CACHE_SIZE) fractureCache.delete(fractureCache.keys().next().value as string);
    fractureCache.set(key, result);
    return result;
};

/** The material cut faces are drawn with: the model's first texture tinted, or plain colour. */
export const interiorMaterial = (materials: THREE.Material[], color: string): THREE.MeshStandardMaterial => {
    const first = materials.find(material => (material as THREE.MeshStandardMaterial).map) as THREE.MeshStandardMaterial | undefined;
    return new THREE.MeshStandardMaterial({ color, map: first?.map ?? null, roughness: 0.92, metalness: 0 });
};

interface Prepared {
    source: DestructibleSource;
    result: FractureResult;
    materials: THREE.Material[];
}

/** How much faster than Break Speed a piece of debris must hit to break something. */
export const DEBRIS_BREAK_FACTOR = 2;

const _centre = new THREE.Vector3();
const _scale = new THREE.Vector3();

const DestructibleRuntime: React.FC<{ objectId: string; settings: DestructibleSettings }> = ({ objectId, settings }) => {
    const host = useContext(ComponentHostContext);
    const anchor = useRef<THREE.Group>(null);
    const services = useRuntimeServices();
    const { audioAssets } = useGameContent();
    const { world } = useRapier();
    const state = useRef({ health: settings.health, broken: false, prepared: null as Prepared | null, colliders: [] as ReturnType<typeof world.getCollider>[], scan: 0 });
    const live = useRef({ settings, services, audioAssets });
    live.current = { settings, services, audioAssets };

    const hostObject = (): THREE.Object3D | null => host?.current ?? anchor.current?.parent ?? null;

    const handle = useMemo<DestructibleHandle>(() => {
        const prepare = (): Prepared | null => {
            const current = state.current;
            if (current.prepared) return current.prepared;
            const target = hostObject();
            const source = target ? destructibleSource(target, objectId, anchor.current) : null;
            if (!source) return null;
            const { settings: now } = live.current;
            const result = cachedFracture(source, now.pieces, now.seed);
            current.prepared = { source, result, materials: [...source.materials, interiorMaterial(source.materials, now.interiorColor)] };
            return current.prepared;
        };
        const centre = (): Vec3 => {
            const target = hostObject();
            const prepared = state.current.prepared;
            if (!target) return { x: 0, y: 0, z: 0 };
            target.updateWorldMatrix(true, false);
            if (prepared) _centre.addVectors(prepared.source.min, prepared.source.max).multiplyScalar(0.5).applyMatrix4(target.matrixWorld);
            else _centre.setFromMatrixPosition(target.matrixWorld);
            return { x: _centre.x, y: _centre.y, z: _centre.z };
        };
        const radius = (): number => {
            const target = hostObject();
            const prepared = state.current.prepared;
            if (!target || !prepared) return 0.5;
            target.matrixWorld.decompose(_centre, new THREE.Quaternion(), _scale);
            return prepared.source.max.clone().sub(prepared.source.min).multiply(_scale).length() / 2;
        };
        const breakApart = (point: Vec3 | null, direction: Vec3 | null, speed?: number): boolean => {
            const current = state.current;
            if (current.broken) return false;
            const prepared = prepare();
            const target = hostObject();
            if (!target) return false;
            current.broken = true;
            current.health = 0;
            const { settings: now, services: runtime, audioAssets: assets } = live.current;
            // Its colliders go at once, so what hit it carries on through.
            world.forEachCollider(collider => {
                if (objectIdFromCollider(collider) === objectId) collider.setEnabled(false);
            });
            target.updateWorldMatrix(true, true);
            const middle = centre();
            const reach = radius();
            if (prepared) {
                combat().spawnDebris(prepared.result, prepared.materials, target.matrixWorld, {
                    density: now.density, life: now.life, scatter: now.scatter,
                    hit: point, direction, push: speed ?? now.scatter * 1.5,
                });
            }
            if (now.dust) combat().breakEffect(middle, reach, now.interiorColor);
            const sound = findAudioAsset(assets, now.sound);
            if (sound) runtime.playSound(sound.id);
            target.visible = false;
            destructibles.reportBroken(objectId);
            runtime.destroyObject(objectId);
            return true;
        };
        return {
            objectId,
            centre,
            radius,
            health: () => state.current.health,
            maxHealth: () => live.current.settings.health,
            broken: () => state.current.broken,
            damage: (amount, point, direction) => {
                const current = state.current;
                if (current.broken || !(amount > 0)) return false;
                current.health = Math.max(0, current.health - amount);
                if (current.health > 0) return false;
                return breakApart(point, direction, live.current.settings.scatter + Math.min(12, amount * 0.08));
            },
            breakApart,
            prepare,
        } as DestructibleHandle & { prepare: () => Prepared | null };
    // The handle reads settings and services through refs; it belongs to the object for the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [objectId, world]);

    useEffect(() => destructibles.register(handle), [handle]);

    // Works the fracture out soon after play starts (and once the model has loaded), not as it breaks.
    useEffect(() => {
        let tries = 0;
        let timer = 0;
        const attempt = () => {
            if (state.current.broken || (handle as DestructibleHandle & { prepare: () => Prepared | null }).prepare()) return;
            if (++tries < 40) timer = window.setTimeout(attempt, 500);
        };
        timer = window.setTimeout(attempt, 150 + Math.random() * 600);
        return () => window.clearTimeout(timer);
    }, [handle]);

    // A heavy loose body hitting it fast enough breaks it at once.
    useFrame(() => {
        const current = state.current;
        const { settings: now } = live.current;
        if (current.broken || now.breakSpeed <= 0) return;
        if (current.colliders.length === 0 || current.scan++ % 120 === 0) {
            const found: typeof current.colliders = [];
            world.forEachCollider(collider => { if (objectIdFromCollider(collider) === objectId) found.push(collider); });
            current.colliders = found;
        }
        const prepared = current.prepared;
        const size = prepared ? prepared.source.max.clone().sub(prepared.source.min) : new THREE.Vector3(1, 1, 1);
        const target = hostObject();
        if (target) target.matrixWorld.decompose(_centre, new THREE.Quaternion(), _scale);
        const ownMass = Math.abs(size.x * size.y * size.z * _scale.x * _scale.y * _scale.z) * now.density * 0.5;
        for (const own of current.colliders) {
            if (!own) continue;
            const ownBody = own.parent();
            const ownBefore = ownBody?.isDynamic() ? combat().velocityBefore(ownBody.handle) : null;
            let hitter: { body: NonNullable<ReturnType<typeof own.parent>> | null; before: Vec3; speed: number; at: Vec3 } | null = null;
            world.contactPairsWith(own, other => {
                if (hitter) return;
                let touching = false;
                world.contactPair(own, other, manifold => { if (manifold.numContacts() > 0) touching = true; });
                if (!touching) return;
                const body = other.parent();
                const otherBefore = body?.isDynamic() ? combat().velocityBefore(body.handle) : null;
                if (!otherBefore && !ownBefore) return;
                const a = otherBefore ?? { x: 0, y: 0, z: 0 };
                const b = ownBefore ?? { x: 0, y: 0, z: 0 };
                const relative = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
                const speed = Math.hypot(relative.x, relative.y, relative.z);
                // Pieces of something already broken need a real blow to break more: no chain reaction from a gentle fall.
                const debris = (body?.userData as { debris?: boolean } | undefined)?.debris === true;
                if (speed < now.breakSpeed * (debris ? DEBRIS_BREAK_FACTOR : 1)) return;
                // Something light (a stone, a can) does not break a wall, however fast.
                if (otherBefore && !ownBefore && (body?.mass() ?? 0) < Math.max(5, ownMass * 0.1)) return;
                const t = body?.translation() ?? other.translation();
                hitter = { body: otherBefore ? body : null, before: otherBefore ?? relative, speed, at: { x: t.x, y: t.y, z: t.z } };
            });
            if (!hitter) continue;
            const { body, before, speed, at } = hitter as { body: NonNullable<ReturnType<typeof own.parent>> | null; before: Vec3; speed: number; at: Vec3 };
            const direction = { x: before.x / speed, y: before.y / speed, z: before.z / speed };
            if (handle.breakApart(at, direction, speed * 0.85)) {
                // What broke through keeps most of its speed.
                body?.setLinvel({ x: before.x * 0.8, y: before.y * 0.8, z: before.z * 0.8 }, true);
            }
            return;
        }
    });

    return <group ref={anchor} />;
};

/** In the editor: the pieces in place of the model, a little apart, to see how it will break. */
const DestructiblePreview: React.FC<{ objectId: string; settings: DestructibleSettings }> = ({ objectId, settings }) => {
    const anchor = useRef<THREE.Group>(null);
    const group = useMemo(() => new THREE.Group(), []);

    useEffect(() => {
        if (!settings.preview) return undefined;
        let hidden: THREE.Object3D[] = [];
        const made: THREE.BufferGeometry[] = [];
        let material: THREE.Material | null = null;
        let cancelled = false;
        const build = () => {
            const host = anchor.current?.parent;
            const source = host ? destructibleSource(host, objectId, anchor.current) : null;
            if (!host || !source) {
                if (!cancelled) timer = window.setTimeout(build, 500);
                return;
            }
            const result = cachedFracture(source, settings.pieces, settings.seed);
            material = interiorMaterial(source.materials, settings.interiorColor);
            const materials = [...source.materials, material];
            const middle = source.min.clone().add(source.max).multiplyScalar(0.5);
            const spread = source.max.clone().sub(source.min).length() * 0.06;
            for (const piece of result.pieces) {
                const geometry = new THREE.BufferGeometry();
                geometry.setAttribute('position', new THREE.BufferAttribute(piece.positions, 3));
                geometry.setAttribute('normal', new THREE.BufferAttribute(piece.normals, 3));
                geometry.setAttribute('uv', new THREE.BufferAttribute(piece.uvs, 2));
                for (const g of piece.groups) geometry.addGroup(g.start, g.count, g.material);
                made.push(geometry);
                const mesh = new THREE.Mesh(geometry, materials);
                const centre = new THREE.Vector3(...piece.centre);
                const out = centre.clone().sub(middle);
                mesh.position.copy(centre).addScaledVector(out.lengthSq() > 1e-9 ? out.normalize() : out, spread);
                mesh.castShadow = true;
                mesh.raycast = () => undefined;
                group.add(mesh);
            }
            // The model hides while its pieces show.
            hidden = collectHostMeshes(host, objectId, node => node === anchor.current).filter(mesh => mesh.visible);
            for (const mesh of hidden) mesh.visible = false;
        };
        let timer = window.setTimeout(build, 0);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
            for (const mesh of hidden) mesh.visible = true;
            group.clear();
            for (const geometry of made) geometry.dispose();
            material?.dispose();
        };
    }, [objectId, settings.preview, settings.pieces, settings.seed, settings.interiorColor, group]);

    return (
        <group ref={anchor}>
            <primitive object={group} />
        </group>
    );
};

const DestructibleRender: React.FC<ComponentRenderProps> = ({ object, component, mode }) => {
    const settings = useMemo(() => readDestructibleSettings(component), [component]);
    return mode === 'runtime'
        ? <DestructibleRuntime objectId={object.id} settings={settings} />
        : <DestructiblePreview objectId={object.id} settings={settings} />;
};

export const DESTRUCTIBLE_COMPONENT: ComponentDefinition = {
    type: DESTRUCTIBLE_COMPONENT_TYPE,
    label: 'Destructible',
    description: 'Breaks the object into pieces when its health runs out: shots and explosions take it down, and a heavy body (a car) hitting it at Break Speed breaks it at once. Give it a Collider so shots and vehicles can reach it. Solid, roughly convex models (walls, crates, pillars, rocks, panes) break best.',
    props: [
        { key: 'health', label: 'Health', type: 'number', default: DESTRUCTIBLE_DEFAULTS.health, min: 0, max: 1e6, step: 5 },
        { key: 'pieces', label: 'Pieces', type: 'number', default: DESTRUCTIBLE_DEFAULTS.pieces, min: MIN_FRACTURE_PIECES, max: MAX_FRACTURE_PIECES, step: 1 },
        { key: 'breakSpeed', label: 'Break speed (m/s, 0 never)', type: 'number', default: DESTRUCTIBLE_DEFAULTS.breakSpeed, min: 0, max: 200, step: 0.5 },
        { key: 'scatter', label: 'Scatter (m/s)', type: 'number', default: DESTRUCTIBLE_DEFAULTS.scatter, min: 0, max: 50, step: 0.1 },
        { key: 'density', label: 'Density (kg/m³)', type: 'number', default: DESTRUCTIBLE_DEFAULTS.density, min: 10, max: 20000, step: 50 },
        { key: 'life', label: 'Pieces stay (s, 0 always)', type: 'number', default: DESTRUCTIBLE_DEFAULTS.life, min: 0, max: 3600, step: 1 },
        { key: 'interiorColor', label: 'Inside colour', type: 'color', default: DESTRUCTIBLE_DEFAULTS.interiorColor },
        { key: 'dust', label: 'Dust and chips', type: 'boolean', default: DESTRUCTIBLE_DEFAULTS.dust },
        { key: 'sound', label: 'Sound (id or name; blank: crunch)', type: 'string', default: DESTRUCTIBLE_DEFAULTS.sound },
        { key: 'seed', label: 'Pattern', type: 'number', default: DESTRUCTIBLE_DEFAULTS.seed, min: 0, max: 1e6, step: 1 },
        { key: 'preview', label: 'Preview pieces (editor)', type: 'boolean', default: DESTRUCTIBLE_DEFAULTS.preview },
    ],
    Render: DestructibleRender,
};
