import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useGameContent } from '../GameContentContext';
import { decodeGarmentCache, GARMENT_CACHE_LIMITS, sampleGarmentCache, type GarmentCache } from '../garments/cache';
import { fittingBakeRecipe, fittingDigest, readFittingBake } from '../garments/bake';
import type { LevelComponent } from '../../types';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { cookGarment, createSleevelessTop, readGarmentPattern, type CookedGarment } from '../garments/pattern';
import { GARMENT_STEP, GarmentSimulation } from '../garments/solver';
import { FITTING_TORSO, fittingOffsetAt, GARMENT_FABRICS, type GarmentFabric } from '../garments/fitting';
import { GarmentStrainMap, type GarmentStrainView } from '../garments/strain';
import { findBone, isDescendantOf } from '../ik';
import { windAt, windTime, type WindVec } from '../wind';
import type { ComponentDefinition, ComponentRenderProps } from './types';

export interface GarmentSettings {
    fabric: GarmentFabric;
    color: string;
    wind: number;
    animateTorso: boolean;
    showTorso: boolean;
    selfCollision: boolean;
    followBone: string;
    strainView: GarmentStrainView;
}

const DEFAULT_COLOR = '#2b8990';
export function readGarmentSettings(component: LevelComponent): GarmentSettings {
    const p = component.props;
    return {
        fabric: p.fabric === 'linen' || p.fabric === 'silk' ? p.fabric : 'cotton',
        color: typeof p.color === 'string' && /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : DEFAULT_COLOR,
        wind: typeof p.wind === 'number' && Number.isFinite(p.wind) ? THREE.MathUtils.clamp(p.wind, 0, 4) : 1,
        animateTorso: p.animateTorso !== false,
        showTorso: p.showTorso !== false,
        selfCollision: p.selfCollision === true,
        followBone: typeof p.followBone === 'string' ? p.followBone.trim() : '',
        strainView: p.strainView === 'warp' || p.strainView === 'weft' || p.strainView === 'shear' ? p.strainView : 'off',
    };
}

export function cookComponentGarment(value: unknown): CookedGarment {
    return cookGarment(value === undefined ? createSleevelessTop() : readGarmentPattern(value));
}

// This proxy uses the solver's upright capsule, scaled in X. Its dimensions are in owner-local metres.
const MAX_FRAME_STEPS = 8;
const _unitUp = new THREE.Vector3(0, 1, 0);

/** Owns the CPU simulation, presentation mesh and fitting body of exactly one level-component instance. */
export class GarmentInstance {
    readonly root = new THREE.Group();
    readonly simulation: GarmentSimulation;
    readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    readonly torso: THREE.Mesh<THREE.CapsuleGeometry, THREE.MeshStandardMaterial>;
    private readonly capsule = { ...FITTING_TORSO };
    private readonly colliders = [this.capsule];
    private readonly pins = new THREE.Matrix4();
    private readonly inverseRotation = new THREE.Quaternion();
    private readonly down = new THREE.Vector3();
    private readonly ambient = new THREE.Vector3();
    private readonly sample = new THREE.Vector3();
    private readonly windScratch = { x: 0, y: 0, z: 0 };
    private strainMap?: GarmentStrainMap;
    private strainView: GarmentStrainView = 'off';
    private readonly boneOrigin = new THREE.Vector3();
    private readonly previousOffset = new THREE.Vector3();
    private readonly endOffset = new THREE.Vector3();
    private readonly offset = new THREE.Vector3();
    private followName = '';
    private bone: THREE.Object3D | null = null;
    private searchDelay = 0;
    private missingBoneReported = false;
    private carry = 0;
    private time = 0;

    constructor(private readonly cooked: CookedGarment, fabric: GarmentSettings['fabric'], selfCollision = false) {
        this.simulation = new GarmentSimulation(cooked, { ...GARMENT_FABRICS[fabric], ...(selfCollision ? { selfCollision: true } : {}) });
        this.simulation.reset();
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(this.simulation.positions, 3).setUsage(THREE.DynamicDrawUsage));
        geometry.setAttribute('uv', new THREE.BufferAttribute(cooked.restUV, 2));
        geometry.setIndex(new THREE.BufferAttribute(cooked.indices, 1));
        geometry.computeVertexNormals();
        (geometry.getAttribute('normal') as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
        geometry.computeBoundingSphere();
        const material = new THREE.MeshStandardMaterial({ color: DEFAULT_COLOR, metalness: 0, roughness: 0.88, side: THREE.DoubleSide });
        this.mesh = new THREE.Mesh(geometry, material);
        this.mesh.name = 'Garment';
        this.mesh.castShadow = this.mesh.receiveShadow = true;
        this.torso = new THREE.Mesh(new THREE.CapsuleGeometry(FITTING_TORSO.radius, FITTING_TORSO.height - 2 * FITTING_TORSO.radius, 8, 32),
            new THREE.MeshStandardMaterial({ color: '#c1a489', roughness: 0.9 }));
        this.torso.name = 'Garment fitting torso';
        this.torso.position.y = FITTING_TORSO.y + FITTING_TORSO.height / 2;
        this.torso.scale.x = FITTING_TORSO.radiusX / FITTING_TORSO.radius;
        this.root.add(this.mesh, this.torso);
    }

    // The fitting body is about half a metre long. Sample Auvra's field at its center,
    // then let each simulated triangle compute drag against its own velocity and normal.
    private readonly wind = (_x: number, _y: number, _z: number, out: WindVec): WindVec => {
        out.x = this.ambient.x;
        out.y = this.ambient.y;
        out.z = this.ambient.z;
        return out;
    };

    /** Capture the translation of the named bone relative to its first pose, restricted to this actor. */
    private boneOffset(name: string, objectId: string, dt: number): boolean {
        const host = this.root.parent;
        if (this.followName !== name || (this.bone && (!host || !isDescendantOf(this.bone, host)))) {
            this.followName = name;
            this.bone = null;
            this.searchDelay = 0;
            this.missingBoneReported = false;
        }
        this.endOffset.set(0, 0, 0);
        if (!name) return true;
        if (!host) return false;
        if (!this.bone) {
            this.searchDelay -= dt;
            if (this.searchDelay > 0) return false;
            const candidate = findBone(host, name, node => node === this.root ||
                (node !== host && node.userData.levelObjectId !== undefined && node.userData.levelObjectId !== objectId));
            // findBone also searches arbitrary named scene objects. This control specifically binds a bone.
            if (!candidate || !(candidate as THREE.Bone).isBone) {
                if (!this.missingBoneReported) frontendDiagnostics.warning('garment_bone_unavailable');
                this.missingBoneReported = true;
                this.searchDelay = 0.5;
                return false;
            }
            this.missingBoneReported = false;
            this.bone = candidate;
            this.root.worldToLocal(candidate.getWorldPosition(this.boneOrigin));
            this.previousOffset.set(0, 0, 0);
        }
        this.root.worldToLocal(this.bone.getWorldPosition(this.endOffset)).sub(this.boneOrigin);
        return true;
    }

    private updateSurface(settings: GarmentSettings, moved: boolean): void {
        const { material, geometry } = this.mesh;
        const overlay = settings.strainView !== 'off';
        if (settings.strainView !== 'off' && (moved || this.strainView !== settings.strainView)) {
            if (!this.strainMap) {
                this.strainMap = new GarmentStrainMap(this.cooked);
                geometry.setAttribute('color', new THREE.BufferAttribute(this.strainMap.colors, 3).setUsage(THREE.DynamicDrawUsage));
            }
            this.strainMap.update(this.simulation.positions, settings.strainView);
            geometry.getAttribute('color').needsUpdate = true;
        }
        this.strainView = settings.strainView;
        if (material.vertexColors !== overlay) {
            material.vertexColors = overlay;
            material.needsUpdate = true;
        }
        material.color.set(overlay ? '#ffffff' : settings.color);
    }

    private publishGeometry(): void {
        const geometry = this.mesh.geometry;
        geometry.getAttribute('position').needsUpdate = true;
        geometry.computeVertexNormals();
        geometry.computeBoundingSphere();
        if (geometry.boundingBox) geometry.computeBoundingBox();
    }

    /** Display-only playback on a dedicated instance, never a restart state for the live solver. */
    presentCachedPose(positions: ArrayLike<number>, torsoCenter: THREE.Vector3, settings: GarmentSettings): void {
        if (positions.length !== this.simulation.positions.length) throw new Error('Garment cache vertex count differs from the mesh');
        this.simulation.positions.set(positions);
        this.root.visible = true;
        this.torso.visible = settings.showTorso;
        this.torso.position.copy(torsoCenter);
        this.updateSurface(settings, true);
        this.publishGeometry();
    }

    advance(dt: number, settings: GarmentSettings, objectId: string): void {
        this.torso.visible = settings.showTorso;
        if (!(dt > 0) || !Number.isFinite(dt)) {
            this.updateSurface(settings, false);
            return;
        }
        this.root.updateWorldMatrix(true, false);
        this.root.visible = this.boneOffset(settings.followBone, objectId, dt);
        if (!this.root.visible) return;
        this.root.getWorldQuaternion(this.inverseRotation).invert();
        this.down.copy(_unitUp).negate().applyQuaternion(this.inverseRotation);
        if (settings.wind > 0) {
            this.sample.copy(this.torso.position).applyMatrix4(this.root.matrixWorld);
            windAt(this.sample.x, this.sample.y, this.sample.z, windTime(), this.windScratch);
            this.ambient.set(this.windScratch.x, this.windScratch.y, this.windScratch.z)
                .applyQuaternion(this.inverseRotation).multiplyScalar(settings.wind);
        }

        const elapsed = Math.min(dt, GARMENT_STEP * MAX_FRAME_STEPS);
        const oldCarry = this.carry;
        this.carry += elapsed;
        let changed = false;
        for (let consumed = GARMENT_STEP - oldCarry; this.carry + 1e-12 >= GARMENT_STEP; consumed += GARMENT_STEP) {
            this.carry = Math.max(0, this.carry - GARMENT_STEP);
            const next = this.time + GARMENT_STEP;
            this.offset.lerpVectors(this.previousOffset, this.endOffset, Math.min(1, consumed / elapsed));
            if (!settings.followBone) fittingOffsetAt(next, settings.animateTorso, this.offset);
            this.capsule.x = this.offset.x;
            this.capsule.y = FITTING_TORSO.y + this.offset.y;
            this.capsule.z = this.offset.z;
            this.pins.makeTranslation(this.offset.x, this.offset.y, this.offset.z);
            const accepted = this.simulation.step(GARMENT_STEP, this.pins.elements,
                settings.wind > 0 ? this.wind : null, this.colliders, null, this.down);
            if (!accepted) break;
            this.time = next;
            this.torso.position.set(this.capsule.x, this.capsule.y + FITTING_TORSO.height / 2, this.capsule.z);
            changed = true;
        }
        this.previousOffset.copy(this.endOffset);
        this.updateSurface(settings, changed);
        if (changed) this.publishGeometry();
    }

    dispose(): void {
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
        this.torso.geometry.dispose();
        this.torso.material.dispose();
    }
}

const CachedGarment: React.FC<{
    instance: GarmentInstance; settings: GarmentSettings; cache: GarmentCache; loop: boolean;
}> = ({ instance, settings, cache, loop }) => {
    const elapsed = useRef(0);
    const output = useMemo(() => new Float32Array(cache.vertexCount * 3), [cache]);
    const center = useMemo((): [number, number, number] => [0, 0, 0], []);
    const vector = useMemo(() => new THREE.Vector3(), []);
    useFrame((_state, dt) => {
        const t = loop && cache.duration > 0 ? elapsed.current % cache.duration : Math.min(elapsed.current, cache.duration);
        sampleGarmentCache(cache, t, output, center);
        instance.presentCachedPose(output, vector.fromArray(center), settings);
        if (Number.isFinite(dt) && dt > 0) elapsed.current += dt;
    });
    return <primitive object={instance.root} />;
};

const GarmentRender: React.FC<ComponentRenderProps> = ({ object, component }) => {
    const settings = readGarmentSettings(component);
    const pattern = component.props.pattern;
    const cooked = useMemo(() => {
        try { return cookComponentGarment(pattern); }
        catch { return null; }
    }, [pattern]);
    const rawBake = component.props.fittingBake;
    const wantsCache = component.props.playback === 'cache';
    const ref = useMemo(() => readFittingBake(rawBake), [rawBake]);
    const { readAssetBytes } = useGameContent();
    const { fabric, animateTorso, selfCollision, followBone } = settings;
    const request = useMemo(() => {
        if (!wantsCache || !cooked || !ref || !readAssetBytes || followBone) return null;
        return { cooked, ref, read: readAssetBytes, input: {
            fabric, animateTorso, selfCollision, pattern: pattern === undefined ? createSleevelessTop() : readGarmentPattern(pattern),
        } };
    }, [wantsCache, cooked, ref, readAssetBytes, followBone, fabric, animateTorso, selfCollision, pattern]);
    const [loaded, setLoaded] = useState<{ request: typeof request; cache: GarmentCache } | null>(null);
    useEffect(() => {
        let current = true;
        setLoaded(null);
        if (request) {
            void (async () => {
                if (await fittingBakeRecipe(request.input) !== request.ref.recipe) throw new Error('Stale garment bake');
                if (!current) return;
                const bytes = await request.read(request.ref.assetId);
                if (!current) return;
                if (bytes.byteLength > GARMENT_CACHE_LIMITS.bytes || await fittingDigest(bytes) !== request.ref.assetId)
                    throw new Error('Garment bake content does not match its asset');
                if (!current) return;
                const cache = decodeGarmentCache(bytes, request.cooked.positions.length / 3);
                if (cache.duration !== request.ref.duration) throw new Error('Garment bake length mismatch');
                setLoaded({ request, cache });
            })().catch(() => { if (current) frontendDiagnostics.warning('garment_cache_unavailable'); });
        } else if (wantsCache) frontendDiagnostics.warning('garment_cache_unavailable');
        return () => { current = false; };
    }, [request, wantsCache]);
    const cache = loaded && loaded.request === request ? loaded.cache : null;
    // An accepted display-only pose must never seed velocities or multipliers in live simulation.
    const garment = useMemo(() => cooked ? new GarmentInstance(cooked, fabric, selfCollision) : null,
        [cooked, fabric, selfCollision, cache]);
    useEffect(() => {
        if (!garment) frontendDiagnostics.warning('garment_invalid_pattern');
        return () => garment?.dispose();
    }, [garment]);
    useFrame((_state, dt) => { if (!cache) garment?.advance(dt, settings, object.id); });
    if (!garment) return null;
    return cache ? <CachedGarment key={ref!.assetId} instance={garment} settings={settings} cache={cache}
        loop={component.props.loopBake === true} /> : <primitive object={garment.root} />;
};

export const GARMENT_COMPONENT: ComponentDefinition = {
    type: 'garment',
    label: 'Garment',
    description: 'A sewn garment simulated on an upright fitting torso, starting with a sleeveless top. Edit its panels and seams in the inspector.',
    props: [
        { key: 'fabric', label: 'Fabric preset', type: 'select', default: 'cotton', options: [
            { label: 'Cotton', value: 'cotton' }, { label: 'Linen', value: 'linen' }, { label: 'Silk', value: 'silk' },
        ] },
        { key: 'color', label: 'Fabric colour', type: 'color', default: DEFAULT_COLOR },
        { key: 'wind', label: 'Wind speed multiplier', type: 'number', default: 1, min: 0, max: 4, step: 0.1 },
        { key: 'showTorso', label: 'Show fitting torso', type: 'boolean', default: true },
        { key: 'animateTorso', label: 'Sway fitting torso', type: 'boolean', default: true },
        { key: 'selfCollision', label: 'Self-collision (preview)', type: 'boolean', default: false },
        { key: 'strainView', label: 'Strain display', type: 'select', default: 'off', options: [
            { label: 'Fabric colour', value: 'off' }, { label: 'Warp extension', value: 'warp' },
            { label: 'Weft extension', value: 'weft' }, { label: 'Shear angle', value: 'shear' },
        ] },
        { key: 'followBone', label: 'Follow bone translation', type: 'string', default: '' },
    ],
    createProps: () => ({ pattern: createSleevelessTop() }),
    Render: GarmentRender,
};
