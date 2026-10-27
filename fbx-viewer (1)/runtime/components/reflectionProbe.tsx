import React, { useContext, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import type { LevelComponent } from '../../types';
import { ComponentHostContext } from './builtins';
import type { ComponentDefinition, ComponentRenderProps } from './types';

/**
 * REFLECTION PROBES
 *
 * A probe renders the scene around its position into a cube map, filters it for rough materials
 * (PMREM) and hands it to every MeshStandardMaterial / MeshPhysicalMaterial whose mesh centre lies
 * within its radius, the nearest probe winning where probes overlap. Meshes get their own copy of the
 * material while a probe lights them, so shared materials elsewhere keep their reflections; leaving
 * every probe's radius gives the original material back.
 */

export type ProbeUpdate = 'once' | 'interval' | 'realtime';

export interface ReflectionProbeSettings {
    radius: number;
    resolution: number;
    intensity: number;
    update: ProbeUpdate;
    /** Seconds between captures for 'interval'. */
    interval: number;
}

export const REFLECTION_PROBE_DEFAULTS: ReflectionProbeSettings = { radius: 10, resolution: 128, intensity: 1, update: 'once', interval: 2 };
const RESOLUTIONS = [64, 128, 256];
const UPDATES: readonly ProbeUpdate[] = ['once', 'interval', 'realtime'];
/** Seconds between checks of which meshes each probe covers. */
export const PROBE_RESCAN_SECONDS = 0.5;
/** 'once' captures again this long after mounting, when models that load late are in the scene. */
const SETTLE_CAPTURE_SECONDS = 1;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const resolveReflectionProbeSettings = (component: LevelComponent): ReflectionProbeSettings => {
    const { radius, resolution, intensity, update, interval } = component.props;
    const finite = (value: unknown, fallback: number, min: number, max: number) =>
        typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback;
    const size = Number(resolution);
    return {
        radius: finite(radius, REFLECTION_PROBE_DEFAULTS.radius, 0.1, 10000),
        resolution: RESOLUTIONS.includes(size) ? size : REFLECTION_PROBE_DEFAULTS.resolution,
        intensity: finite(intensity, REFLECTION_PROBE_DEFAULTS.intensity, 0, 10),
        update: UPDATES.includes(update as ProbeUpdate) ? update as ProbeUpdate : REFLECTION_PROBE_DEFAULTS.update,
        interval: finite(interval, REFLECTION_PROBE_DEFAULTS.interval, 0.1, 600),
    };
};

/** Whether a probe captures this frame: `elapsed` is seconds since its last capture (null: never captured). */
export const shouldCapture = (update: ProbeUpdate, elapsed: number | null, interval: number, sinceMount: number): boolean => {
    if (elapsed === null) return true;
    if (update === 'realtime') return true;
    if (update === 'interval') return elapsed >= interval;
    return sinceMount >= SETTLE_CAPTURE_SECONDS && sinceMount - elapsed < SETTLE_CAPTURE_SECONDS;
};

// --- PROBE REGISTRY AND MESH ASSIGNMENT ---

/** A probe as the assignment sees it. */
export interface ProbeEntry {
    id: string;
    position: THREE.Vector3;
    radius: number;
    texture: THREE.Texture | null;
    intensity: number;
    /** The probe's own object: its meshes are never lit by it. */
    host: THREE.Object3D | null;
}

/** The nearest probe whose radius holds `point`, ties going to the first registered; null when none does. */
export const nearestProbe = (point: THREE.Vector3, probes: Iterable<ProbeEntry>): ProbeEntry | null => {
    let best: ProbeEntry | null = null;
    let bestDistance = Infinity;
    for (const probe of probes) {
        const distance = probe.position.distanceTo(point);
        if (distance <= probe.radius && distance < bestDistance) {
            best = probe;
            bestDistance = distance;
        }
    }
    return best;
};

const probes = new Map<string, ProbeEntry>();

interface Assignment {
    probeId: string;
    original: THREE.Material | THREE.Material[];
    copies: THREE.Material[];
}

const assignments = new Map<THREE.Mesh, Assignment>();

const isProbeMaterial = (material: THREE.Material): material is THREE.MeshStandardMaterial =>
    (material as THREE.MeshStandardMaterial).isMeshStandardMaterial === true;

const lightWith = (assignment: Assignment, probe: ProbeEntry) => {
    for (const copy of assignment.copies) {
        if (!isProbeMaterial(copy)) continue;
        if (copy.envMap !== probe.texture) {
            copy.envMap = probe.texture;
            copy.needsUpdate = true;
        }
        copy.envMapIntensity = probe.intensity;
    }
    assignment.probeId = probe.id;
};

const assign = (mesh: THREE.Mesh, probe: ProbeEntry) => {
    const existing = assignments.get(mesh);
    if (existing) {
        lightWith(existing, probe);
        return;
    }
    const original = mesh.material;
    const list = Array.isArray(original) ? original : [original];
    const copies = list.map(material => (isProbeMaterial(material) ? material.clone() : material));
    mesh.material = Array.isArray(original) ? copies : copies[0];
    const assignment: Assignment = { probeId: probe.id, original, copies };
    assignments.set(mesh, assignment);
    lightWith(assignment, probe);
};

const release = (mesh: THREE.Mesh) => {
    const assignment = assignments.get(mesh);
    if (!assignment) return;
    mesh.material = assignment.original;
    const originals = new Set(Array.isArray(assignment.original) ? assignment.original : [assignment.original]);
    for (const copy of assignment.copies) if (!originals.has(copy)) copy.dispose();
    assignments.delete(mesh);
};

const isDescendant = (node: THREE.Object3D, ancestor: THREE.Object3D | null): boolean => {
    for (let current: THREE.Object3D | null = node; current; current = current.parent) if (current === ancestor) return true;
    return false;
};

const _centre = new THREE.Vector3();
const _sphere = new THREE.Sphere();

/**
 * Re-decides which probe lights each PBR mesh under `scene`: the nearest captured probe whose radius
 * holds the mesh's bounding-sphere centre. Meshes no probe covers get their own material back.
 */
export const updateProbeAssignments = (scene: THREE.Object3D, entries: Iterable<ProbeEntry> = probes.values()): void => {
    const captured = [...entries].filter(probe => probe.texture);
    const seen = new Set<THREE.Mesh>();
    scene.traverse(node => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh || mesh.userData?.auvraWaterSurface) return;
        const assignment = assignments.get(mesh);
        const materials = assignment ? (Array.isArray(assignment.original) ? assignment.original : [assignment.original])
            : Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        if (!materials.some(isProbeMaterial)) return;
        seen.add(mesh);
        const geometry = mesh.geometry;
        if (!geometry.boundingSphere) geometry.computeBoundingSphere();
        mesh.updateWorldMatrix(true, false);
        _sphere.copy(geometry.boundingSphere ?? _sphere.set(_centre.set(0, 0, 0), 0)).applyMatrix4(mesh.matrixWorld);
        const probe = nearestProbe(_sphere.center, captured.filter(entry => !isDescendant(mesh, entry.host)));
        if (probe) assign(mesh, probe);
        else release(mesh);
    });
    // Meshes that left the scene get their materials back too.
    for (const mesh of [...assignments.keys()]) if (!seen.has(mesh)) release(mesh);
};

/** Gives back every mesh a probe lights (when that probe goes away). */
const releaseProbe = (probeId: string) => {
    for (const [mesh, assignment] of [...assignments]) if (assignment.probeId === probeId) release(mesh);
};

// --- COMPONENT ---

const ReflectionProbeRender: React.FC<ComponentRenderProps> = ({ component, mode }) => {
    const host = useContext(ComponentHostContext);
    const gl = useThree(state => state.gl);
    const scene = useThree(state => state.scene);
    const settings = useMemo(() => resolveReflectionProbeSettings(component), [component]);
    const entry = useMemo<ProbeEntry>(() => ({
        id: component.id, position: new THREE.Vector3(), radius: settings.radius, texture: null, intensity: settings.intensity, host: null,
    }), [component.id, settings.radius, settings.intensity]);
    const timing = useRef({ sinceMount: 0, sinceCapture: null as number | null, sinceScan: Infinity });

    const capture = useMemo(() => {
        const cubeTarget = new THREE.WebGLCubeRenderTarget(settings.resolution, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
        const camera = new THREE.CubeCamera(0.05, 1000, cubeTarget);
        const pmrem = new THREE.PMREMGenerator(gl);
        return { cubeTarget, camera, pmrem, filtered: null as THREE.WebGLRenderTarget | null };
    }, [gl, settings.resolution]);

    useEffect(() => {
        probes.set(entry.id, entry);
        timing.current = { sinceMount: 0, sinceCapture: null, sinceScan: Infinity };
        return () => {
            probes.delete(entry.id);
            releaseProbe(entry.id);
        };
    }, [entry]);

    useEffect(() => () => {
        capture.filtered?.dispose();
        capture.cubeTarget.dispose();
        capture.pmrem.dispose();
    }, [capture]);

    useFrame((_state, delta) => {
        const object = host?.current;
        if (!object) return;
        const step = Math.min(delta, 1);
        const time = timing.current;
        time.sinceMount += step;
        if (time.sinceCapture !== null) time.sinceCapture += step;
        time.sinceScan += step;
        entry.host = object;
        object.getWorldPosition(entry.position);

        if (shouldCapture(settings.update, time.sinceCapture, settings.interval, time.sinceMount)) {
            // The probe's own object (its gizmo, its model) stays out of its picture.
            const wasVisible = object.visible;
            object.visible = false;
            capture.camera.position.copy(entry.position);
            capture.camera.update(gl, scene);
            object.visible = wasVisible;
            const filtered = capture.pmrem.fromCubemap(capture.cubeTarget.texture);
            capture.filtered?.dispose();
            capture.filtered = filtered;
            entry.texture = filtered.texture;
            time.sinceCapture = 0;
            time.sinceScan = Infinity;
        }
        if (time.sinceScan >= PROBE_RESCAN_SECONDS) {
            time.sinceScan = 0;
            updateProbeAssignments(scene);
        }
    });

    if (mode !== 'editor') return null;
    return (
        <mesh raycast={() => null}>
            <sphereGeometry args={[settings.radius, 24, 12]} />
            <meshBasicMaterial color="#38bdf8" wireframe transparent opacity={0.12} depthWrite={false} />
        </mesh>
    );
};

export const REFLECTION_PROBE_COMPONENT: ComponentDefinition = {
    type: 'reflectionProbe',
    label: 'Reflection Probe',
    description: 'Captures the surroundings into a reflection map for the shiny materials within its radius.',
    props: [
        { key: 'radius', label: 'Radius (m)', type: 'number', default: REFLECTION_PROBE_DEFAULTS.radius, min: 0.1, max: 10000, step: 0.5 },
        {
            key: 'resolution', label: 'Resolution', type: 'select', default: String(REFLECTION_PROBE_DEFAULTS.resolution),
            options: RESOLUTIONS.map(size => ({ label: `${size} px`, value: String(size) })),
        },
        { key: 'intensity', label: 'Intensity', type: 'number', default: REFLECTION_PROBE_DEFAULTS.intensity, min: 0, max: 10, step: 0.1 },
        {
            key: 'update', label: 'Update', type: 'select', default: REFLECTION_PROBE_DEFAULTS.update,
            options: [{ label: 'Once (at start)', value: 'once' }, { label: 'Every interval', value: 'interval' }, { label: 'Every frame', value: 'realtime' }],
        },
        { key: 'interval', label: 'Interval (s)', type: 'number', default: REFLECTION_PROBE_DEFAULTS.interval, min: 0.1, max: 600, step: 0.5 },
    ],
    Render: ReflectionProbeRender,
};
