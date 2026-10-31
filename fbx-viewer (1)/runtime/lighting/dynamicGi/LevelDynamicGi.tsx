import React, { useContext, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import type { LevelObject } from '../../../types';
import { canDrawFloat } from '../../keptDepth';
import type { RayFilter } from '../../raytracing/rayScene';
import { ShadowDetailContext } from '../DistanceShadowLights';
import { DYNAMIC_GI_UNIFORMS, setSceneGi } from './giMaterials';
import { PROBE_VIEW_FRAGMENT, PROBE_VIEW_VERTEX } from './giShaders';
import { DynamicGi } from './giSystem';
import { PROBES_PER_CASCADE, resolveDynamicGiSettings, type DynamicGiSettings } from './probeGrid';

export const DYNAMIC_GI_COMPONENT_TYPE = 'dynamicGi';

/** Level objects rays can meet: the rest are markers, sounds and spawns. */
const TRACED_TYPES = new Set<LevelObject['type']>(['prop', 'foliage', 'terrain']);

/** The level's settings: those of the first enabled component, or null with none. */
export const dynamicGiSettingsOf = (levelObjects: readonly LevelObject[]): DynamicGiSettings | null => {
    for (const object of levelObjects) {
        for (const component of object.components ?? []) {
            if (component.type === DYNAMIC_GI_COMPONENT_TYPE && component.enabled !== false) return resolveDynamicGiSettings(component.props);
        }
    }
    return null;
};

/** Which meshes rays see: a level's solid things, its terrain once rather than in its pieces, and characters. */
export const tracedMeshFilter = (levelObjects: readonly LevelObject[]): RayFilter => {
    const ids = new Set(levelObjects.filter(object => TRACED_TYPES.has(object.type)).map(object => object.id));
    return (mesh) => {
        if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) return true;
        let owner: string | undefined;
        let layer = false;
        for (let node: THREE.Object3D | null = mesh; node; node = node.parent) {
            // A terrain's drawn pieces change with distance; its whole mesh stays, hidden, beside them.
            if (node.userData?.isTerrain && !mesh.userData?.isTerrain) return false;
            if (node.userData?.staticLighting === true) layer = true;
            if (owner === undefined && typeof node.userData?.levelObjectId === 'string') owner = node.userData.levelObjectId;
        }
        return layer || (owner !== undefined && ids.has(owner));
    };
};

interface GiRunner {
    camera: THREE.Camera;
}

interface SharedGi {
    gi: DynamicGi;
    /** Each view of a level mounts its own runner; one gathers, and all of them read. */
    runners: GiRunner[];
}

/**
 * The runner that gathers: the first view with a perspective camera, which stands in the level. An orthographic
 * view's camera stands far outside it, and the probes follow the camera.
 */
export const gatheringRunner = <T extends GiRunner>(runners: readonly T[]): T | undefined =>
    runners.find(runner => (runner.camera as THREE.PerspectiveCamera).isPerspectiveCamera) ?? runners[0];

const shared = new WeakMap<THREE.WebGLRenderer, SharedGi>();

const DISPOSE_AFTER_MS = 1500;

/** The system gathering light for `gl`, if any: for checks and for anything that reports on it. */
export const dynamicGiFor = (gl: THREE.WebGLRenderer): DynamicGi | null => shared.get(gl)?.gi ?? null;

const RayView: React.FC<{ gi: DynamicGi }> = ({ gi }) => {
    const camera = useThree(state => state.camera);
    const geometry = useMemo(() => {
        const triangle = new THREE.BufferGeometry();
        triangle.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
        return triangle;
    }, []);
    useEffect(() => () => geometry.dispose(), [geometry]);
    const viewport = useMemo(() => new THREE.Vector4(), []);
    return (
        <mesh
            geometry={geometry}
            material={gi.rayViewMaterial}
            frustumCulled={false}
            renderOrder={2000000}
            raycast={() => undefined}
            onBeforeRender={(renderer) => {
                const uniforms = gi.rayViewMaterial.uniforms;
                renderer.getCurrentViewport(viewport);
                (uniforms.viewportOrigin.value as THREE.Vector2).set(viewport.x, viewport.y);
                (uniforms.viewportSize.value as THREE.Vector2).set(viewport.z, viewport.w);
                (uniforms.inverseViewProjection.value as THREE.Matrix4).multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse);
                camera.getWorldPosition(uniforms.rayOrigin.value as THREE.Vector3);
                gi.rayViewMaterial.uniformsNeedUpdate = true;
            }}
        />
    );
};

const ProbeView: React.FC = () => {
    const geometry = useMemo(() => {
        const ball = new THREE.SphereGeometry(1, 10, 8);
        const instanced = new THREE.InstancedBufferGeometry();
        instanced.setAttribute('position', ball.getAttribute('position'));
        instanced.setAttribute('normal', ball.getAttribute('normal'));
        instanced.setIndex(ball.getIndex());
        instanced.instanceCount = PROBES_PER_CASCADE;
        ball.dispose();
        return instanced;
    }, []);
    const material = useMemo(() => new THREE.ShaderMaterial({
        vertexShader: PROBE_VIEW_VERTEX,
        fragmentShader: PROBE_VIEW_FRAGMENT,
        uniforms: {
            auvraGiAtlas: DYNAMIC_GI_UNIFORMS.auvraGiAtlas,
            auvraGiGrid: DYNAMIC_GI_UNIFORMS.auvraGiGrid,
            cascadeShown: { value: 0 },
        },
    }), []);
    useEffect(() => () => {
        geometry.dispose();
        material.dispose();
    }, [geometry, material]);
    return <mesh geometry={geometry} material={material} frustumCulled={false} raycast={() => undefined} />;
};

const DynamicGiRunner: React.FC<{ settings: DynamicGiSettings; levelObjects: readonly LevelObject[] }> = ({ settings, levelObjects }) => {
    const gl = useThree(state => state.gl);
    const scene = useThree(state => state.scene);
    const camera = useThree(state => state.camera);
    const runner = useMemo<GiRunner>(() => ({ camera }), []);
    runner.camera = camera;
    // Play falls back on less when it runs slow: as with distance shadows, so with this.
    const detail = useContext(ShadowDetailContext);
    const effective = useMemo<DynamicGiSettings>(() => (detail === 'low' ? { ...settings, quality: 'low' } : settings), [settings, detail]);
    const latest = useRef({ settings: effective, include: tracedMeshFilter(levelObjects) });
    const signature = useMemo(() => levelObjects.map(object => `${object.id}:${object.type}`).join(), [levelObjects]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const include = useMemo(() => tracedMeshFilter(levelObjects), [signature]);
    latest.current = { settings: effective, include };

    const gi = useMemo(() => {
        let entry = shared.get(gl);
        if (!entry) {
            entry = { gi: new DynamicGi(gl), runners: [] };
            shared.set(gl, entry);
        }
        return entry.gi;
    }, [gl]);

    useEffect(() => {
        const entry = shared.get(gl) ?? { gi, runners: [] };
        shared.set(gl, entry);
        entry.runners.push(runner);
        return () => {
            entry.runners.splice(entry.runners.indexOf(runner), 1);
            // A change of layout unmounts one view and mounts another moments later: the light stays for the new one.
            setTimeout(() => {
                if (entry.runners.length > 0 || shared.get(gl) !== entry) return;
                shared.delete(gl);
                entry.gi.dispose();
            }, DISPOSE_AFTER_MS);
        };
    }, [gl, gi, runner]);

    const state = useMemo(() => ({ intensity: 1, indirectOnly: false }), []);
    state.intensity = settings.intensity;
    state.indirectOnly = settings.view === 'lighting';
    useEffect(() => setSceneGi(scene, state), [scene, state]);

    // Ahead of the sky's own frame work and every view's draw.
    useFrame(() => {
        const entry = shared.get(gl);
        if (!entry || gatheringRunner(entry.runners) !== runner) return;
        gi.update(scene, camera, latest.current.include, latest.current.settings);
    }, -2);

    return (
        <>
            {settings.view === 'rays' && <RayView gi={gi} />}
            {settings.view === 'probes' && <ProbeView />}
        </>
    );
};

/** Lights the level with light gathered as it plays, while a Dynamic Global Illumination component is on. */
export const LevelDynamicGi: React.FC<{ levelObjects: readonly LevelObject[] }> = ({ levelObjects }) => {
    const gl = useThree(state => state.gl);
    const settings = useMemo(() => dynamicGiSettingsOf(levelObjects), [levelObjects]);
    if (!settings || !canDrawFloat(gl)) return null;
    return <DynamicGiRunner settings={settings} levelObjects={levelObjects} />;
};
