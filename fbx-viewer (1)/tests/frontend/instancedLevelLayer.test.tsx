import { act } from '@testing-library/react';
import { _roots, createRoot, extend } from '@react-three/fiber';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { InstancedLevelLayer } from '../../components/Environment/InstancedLevelLayer';
import { MeshLodContext } from '../../components/Scene/useMeshLod';
import { OcclusionCullingLayer } from '../../runtime/OcclusionCullingLayer';
import { canReceiveDecal } from '../../runtime/components/decalComponent';
import { drawsSurface } from '../../runtime/gbuffer';
import { isStaticLightingMesh } from '../../runtime/lighting/bakedLighting';
import { OCCLUSION_HIDDEN_ANSWERS, OCCLUSION_RENDER_ORDER, OCCLUSION_VISIBLE_INTERVAL } from '../../runtime/occlusionCulling';
import { raysSeeMaterial, RayScene } from '../../runtime/raytracing/rayScene';
import { drawsVelocity } from '../../runtime/temporal/velocityBuffer';
import type { LevelObject, LoadedModelData } from '../../types';
import { UNDRAWN_LAYER } from '../../utils/instanceCulling';
import { meshLodReady } from '../../utils/meshLod';

/*
 * The instanced layer on a real scene graph with a stand-in renderer: which meshes it mounts, what each holds,
 * and that the frame loop and the draw hooks work together. How it looks is checked in the running engine.
 */

const modelOf = (geometry: THREE.BufferGeometry): LoadedModelData => {
    const object = new THREE.Group();
    object.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));
    return { id: 'model', name: 'model', url: '', object, animations: [], category: 'prop', isPlacedInScene: true } as unknown as LoadedModelData;
};

const placedAt = (...positions: [number, number, number][]): LevelObject[] => positions.map((position, index) => ({
    id: `object-${index}`, levelId: 'level', modelId: 'model', name: 'prop', position, rotation: [0, 0, 0], scale: [1, 1, 1], type: 'prop',
}));

/** The camera stands at the origin looking down -Z: this one is in view, this one behind it, this one in view. */
const THREE_PROPS: [number, number, number][] = [[0, 0, -30], [0, 0, 60], [5, 0, -40]];

extend(THREE as unknown as Record<string, new () => unknown>);

// A graph with a vertex offset takes a compiled shader to bind; what matters here is what the layer does about one.
vi.mock('../../runtime/materials/graphMaterial', async (importOriginal) => ({
    ...await importOriginal<typeof import('../../runtime/materials/graphMaterial')>(),
    materialGraphOffsetsVertices: (material: THREE.Material) => material.userData.offsetsVertices === true,
}));

const mount = async (element: React.ReactNode, queryContext?: unknown) => {
    const canvas = document.createElement('canvas');
    const gl = { render: vi.fn(), setSize: vi.fn(), setPixelRatio: vi.fn(), domElement: canvas, info: { render: { frame: 0 } }, shadowMap: { enabled: true }, getContext: () => queryContext };
    const root = createRoot(canvas);
    root.configure({
        gl: gl as unknown as THREE.WebGLRenderer, frameloop: 'never', shadows: true, size: { width: 1600, height: 900, top: 0, left: 0 },
        camera: { position: [0, 0, 0], fov: 60, near: 0.1, far: 1000 },
    });
    await act(async () => { root.render(element); });
    await act(async () => { await meshLodReady; });
    const state = () => _roots.get(canvas)!.store.getState();
    const camera = state().camera as THREE.PerspectiveCamera;
    camera.lookAt(0, 0, -1);
    camera.updateMatrixWorld();
    const frame = () => {
        gl.info.render.frame++;
        for (const subscription of state().internal.subscribers) subscription.ref.current(subscription.store.getState(), 0.016);
    };
    const instanced = (): THREE.InstancedMesh[] => {
        const found: THREE.InstancedMesh[] = [];
        state().scene.traverse((node) => { if ((node as THREE.InstancedMesh).isInstancedMesh) found.push(node as THREE.InstancedMesh); });
        return found;
    };
    return { root, camera, gl, scene: state().scene, frame, instanced };
};

/** How many instances a pass takes of `mesh`, seen from `camera`. */
const taken = (mesh: THREE.InstancedMesh, camera: THREE.Camera, pass: 'draw' | 'shadow'): number => {
    const renderer = {} as THREE.WebGLRenderer;
    const scene = new THREE.Scene();
    const material = mesh.material as THREE.Material;
    if (pass === 'draw') {
        mesh.onBeforeRender(renderer, scene, camera, mesh.geometry, material, new THREE.Group());
        const count = mesh.count;
        mesh.onAfterRender(renderer, scene, camera, mesh.geometry, material, new THREE.Group());
        return count;
    }
    const args = [renderer, scene, camera, new THREE.OrthographicCamera(), mesh.geometry, new THREE.MeshDepthMaterial(), null] as unknown as Parameters<THREE.Mesh['onBeforeShadow']>;
    mesh.onBeforeShadow(...args);
    const count = mesh.count;
    mesh.onAfterShadow(...args);
    return count;
};

const placedZ = (mesh: THREE.InstancedMesh): number[] => {
    const matrix = new THREE.Matrix4();
    const zs: number[] = [];
    for (let index = 0; index < mesh.count; index++) {
        mesh.getMatrixAt(index, matrix);
        zs.push(matrix.elements[14]);
    }
    return zs;
};

describe('the instanced layer in play', () => {
    const box = () => modelOf(new THREE.BoxGeometry(1, 1, 1));

    it('draws what the view sees, gives the rest to everyone else, and keeps one still mesh of the whole set', async () => {
        const { root, camera, frame, instanced } = await mount(<InstancedLevelLayer models={[box()]} levelObjects={placedAt(...THREE_PROPS)} interactive={false} />);
        frame();
        const [drawn, whole] = instanced();
        expect(drawn.userData.shuffledInstances).toBe(true);
        expect(whole.userData.shuffledInstances).toBeUndefined();
        expect(whole.userData.staticLighting).toBe(true);
        expect(whole.layers.isEnabled(UNDRAWN_LAYER)).toBe(true);
        expect(whole.layers.test(new THREE.Layers())).toBe(false);

        // All of them at rest: seen first, the one behind last.
        expect(drawn.count).toBe(3);
        expect(placedZ(drawn)).toEqual([-30, -40, 60]);
        expect(taken(drawn, camera, 'draw')).toBe(2);
        expect(taken(drawn, camera, 'shadow')).toBe(2);
        expect(drawn.count).toBe(3);
        // A probe, the sky's overhead camera, a bake.
        expect(taken(drawn, new THREE.PerspectiveCamera(), 'draw')).toBe(3);
        expect(taken(drawn, new THREE.PerspectiveCamera(), 'shadow')).toBe(3);
        // In the order placed, and it stays that way.
        expect(placedZ(whole)).toEqual([-30, 60, -40]);
        await act(async () => { root.unmount(); });
    });

    it('follows the camera round, with only the drawn mesh changing', async () => {
        const { root, camera, frame, instanced } = await mount(<InstancedLevelLayer models={[box()]} levelObjects={placedAt(...THREE_PROPS)} interactive={false} />);
        frame();
        const [drawn, whole] = instanced();
        const version = drawn.instanceMatrix.version;
        const stillVersion = whole.instanceMatrix.version;

        camera.lookAt(0, 0, 1);
        camera.updateMatrixWorld();
        // Before the next sort the set no longer holds, and nothing is left out.
        expect(taken(drawn, camera, 'draw')).toBe(3);
        frame();
        expect(drawn.instanceMatrix.version).toBeGreaterThan(version);
        expect(placedZ(drawn)).toEqual([60, -30, -40]);
        expect(taken(drawn, camera, 'draw')).toBe(1);
        expect(whole.instanceMatrix.version).toBe(stillVersion);
        expect(placedZ(whole)).toEqual([-30, 60, -40]);
        await act(async () => { root.unmount(); });
    });

    it('does no work while nothing changes', async () => {
        const { root, frame, instanced } = await mount(<InstancedLevelLayer models={[box()]} levelObjects={placedAt(...THREE_PROPS)} interactive={false} />);
        frame();
        const [drawn] = instanced();
        const version = drawn.instanceMatrix.version;
        for (let tick = 0; tick < 12; tick++) frame();
        expect(drawn.instanceMatrix.version).toBe(version);
        await act(async () => { root.unmount(); });
    });

    it('holds off-screen casters in the shadow maps of the view', async () => {
        const sun = new THREE.DirectionalLight();
        sun.castShadow = true;
        sun.position.set(100, 30, -30);
        sun.target.position.set(0, 0, -30);
        sun.shadow.camera.left = sun.shadow.camera.bottom = -100;
        sun.shadow.camera.right = sun.shadow.camera.top = 100;
        sun.shadow.camera.far = 800;
        const { root, camera, frame, instanced, scene } = await mount(
            <>
                <primitive object={sun} />
                <primitive object={sun.target} />
                <InstancedLevelLayer models={[box()]} levelObjects={placedAt([0, 0, -30], [80, 5, -30], [-120, 5, -30])} interactive={false} />
            </>,
        );
        scene.updateMatrixWorld(true);
        frame();
        const [drawn] = instanced();
        // The one in view; the one off to the sunny side; the one the shadows fall away from.
        expect(taken(drawn, camera, 'draw')).toBe(1);
        expect(taken(drawn, camera, 'shadow')).toBe(2);
        expect(placedZ(drawn)).toHaveLength(3);
        expect(new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(drawn.instanceMatrix.array, 16)).x).toBe(80);
        await act(async () => { root.unmount(); });
    });

    it('leaves out what is hidden, from the drawn meshes and the whole set', async () => {
        const hidden = new Set(['object-0']);
        const { root, camera, frame, instanced } = await mount(<InstancedLevelLayer models={[box()]} levelObjects={placedAt(...THREE_PROPS)} interactive={false} hiddenIds={hidden} />);
        frame();
        const [drawn, whole] = instanced();
        expect(drawn.count).toBe(2);
        expect(taken(drawn, camera, 'draw')).toBe(1);
        expect(placedZ(whole)).toEqual([60, -40]);
        await act(async () => { root.unmount(); });
    });

    it('culls whether or not detail levels are on', async () => {
        const { root, camera, frame, instanced } = await mount(
            <MeshLodContext.Provider value={false}>
                <InstancedLevelLayer models={[modelOf(new THREE.SphereGeometry(1, 32, 32))]} levelObjects={placedAt(...THREE_PROPS)} interactive={false} />
            </MeshLodContext.Provider>,
        );
        frame();
        const meshes = instanced();
        expect(meshes).toHaveLength(2);
        expect(taken(meshes[0], camera, 'draw')).toBe(2);
        await act(async () => { root.unmount(); });
    });

    it('spreads a detailed part over its levels, and rays see one whole set whatever those do', async () => {
        const model = modelOf(new THREE.SphereGeometry(1, 32, 32));
        const { root, camera, frame, instanced, scene } = await mount(
            <InstancedLevelLayer models={[model]} levelObjects={placedAt([0, 0, -3], [0, 0, -900], [0, 0, 6], [0, 0, 900])} interactive={false} />,
        );
        frame();
        const meshes = instanced();
        const whole = meshes[meshes.length - 1];
        const drawn = meshes.slice(0, -1);
        expect(drawn.length).toBeGreaterThan(1);
        expect(whole.geometry).toBe(drawn[0].geometry);
        expect(drawn.reduce((sum, mesh) => sum + mesh.count, 0)).toBe(4);
        expect(drawn.every(mesh => mesh.userData.shuffledInstances)).toBe(true);
        expect(whole.count).toBe(4);

        const rays = new RayScene();
        scene.updateMatrixWorld(true);
        rays.settle(scene, () => true, () => [1, 1, 1]);
        expect(rays.stats.instances).toBe(4);
        expect(rays.stats.meshes).toBe(1);
        const tree = rays.sceneNodes.texture.version;
        camera.lookAt(0, 0, 1);
        camera.updateMatrixWorld();
        for (let tick = 0; tick < 20; tick++) {
            frame();
            scene.updateMatrixWorld(true);
            rays.update(scene, () => true, () => [1, 1, 1], Infinity);
        }
        expect(rays.sceneNodes.texture.version).toBe(tree);
        rays.dispose();
        await act(async () => { root.unmount(); });
    });
});

describe('the instanced layer behind a wall', () => {
    const IN_VIEW: [number, number, number][] = [[-2, 0, -40], [2, 0, -40], [0, 2, -50]];

    /** Queries that answer as told; the GPU's depth test is what this stands in for. */
    const queryContext = () => {
        const waiting = new Map<object, boolean | null>();
        return {
            ANY_SAMPLES_PASSED_CONSERVATIVE: 0x8d6a, QUERY_RESULT: 0x8866, QUERY_RESULT_AVAILABLE: 0x8867,
            created: 0, deleted: 0,
            createQuery() { this.created += 1; return {}; },
            deleteQuery() { this.deleted += 1; },
            beginQuery: (_target: number, query: object) => { waiting.set(query, null); },
            endQuery: () => undefined,
            getQueryParameter: (query: object, pname: number) => (pname === 0x8867 ? waiting.get(query) !== null : waiting.get(query) ? 1 : 0),
            isContextLost: () => false,
            answerAll: (passed: boolean) => { for (const query of waiting.keys()) if (waiting.get(query) === null) waiting.set(query, passed); },
        };
    };

    const setUp = async (model: LoadedModelData, positions = IN_VIEW, enabled = true) => {
        const context = queryContext();
        const mounted = await mount(
            <OcclusionCullingLayer enabled={enabled}>
                <InstancedLevelLayer models={[model]} levelObjects={placedAt(...positions)} interactive={false} />
            </OcclusionCullingLayer>,
            context,
        );
        const renderer = { renderBufferDirect: vi.fn() } as unknown as THREE.WebGLRenderer & { renderBufferDirect: ReturnType<typeof vi.fn> };
        /** A frame: sorts and answers read, then the camera's pass reaches the queries. */
        const pass = (answer?: boolean) => {
            mounted.frame();
            const driver = mounted.scene.getObjectByName('Occlusion queries') as THREE.Mesh;
            driver.onBeforeRender(renderer, mounted.scene as THREE.Scene, mounted.camera, driver.geometry, driver.material as THREE.Material, new THREE.Group());
            if (answer !== undefined) context.answerAll(answer);
        };
        const drawn = () => mounted.instanced().slice(0, -1);
        const whole = () => mounted.instanced().slice(-1)[0];
        const takenBy = (camera: THREE.Camera, kind: 'draw' | 'shadow') => drawn().reduce((sum, mesh) => sum + taken(mesh, camera, kind), 0);
        return { ...mounted, context, renderer, pass, drawn, whole, takenBy };
    };

    const FRAMES_TO_HIDE = OCCLUSION_VISIBLE_INTERVAL + OCCLUSION_HIDDEN_ANSWERS + 3;
    const detailed = () => modelOf(new THREE.SphereGeometry(1, 32, 32));

    it('skips only the camera\'s own draw while hidden: shadows, rays and other cameras keep them', async () => {
        const { root, camera, pass, renderer, takenBy, whole } = await setUp(detailed());
        pass();
        expect(takenBy(camera, 'draw')).toBe(3);
        for (let run = 0; run < FRAMES_TO_HIDE; run++) pass(false);
        expect(renderer.renderBufferDirect).toHaveBeenCalled();
        expect(takenBy(camera, 'draw')).toBe(0);
        expect(takenBy(camera, 'shadow')).toBe(3);
        expect(takenBy(new THREE.PerspectiveCamera(), 'draw')).toBe(3);
        expect(whole().count).toBe(3);
        await act(async () => { root.unmount(); });
    });

    it('comes back on the first answer that shows', async () => {
        const { root, camera, pass, takenBy } = await setUp(detailed());
        pass();
        for (let run = 0; run < FRAMES_TO_HIDE; run++) pass(false);
        expect(takenBy(camera, 'draw')).toBe(0);
        pass(true);
        pass();
        expect(takenBy(camera, 'draw')).toBe(3);
        await act(async () => { root.unmount(); });
    });

    it('draws everything through a jump of the camera, before the next sort or answer', async () => {
        const { root, camera, pass, takenBy } = await setUp(detailed());
        pass();
        for (let run = 0; run < FRAMES_TO_HIDE; run++) pass(false);
        camera.lookAt(0, 0, 1);
        camera.updateMatrixWorld();
        expect(takenBy(camera, 'draw')).toBe(3);
        pass(false);
        pass(false);
        await act(async () => { root.unmount(); });
    });

    it('never asks about a part whose material moves its own vertices', async () => {
        const model = detailed();
        ((model.object.children[0] as THREE.Mesh).material as THREE.Material).userData.offsetsVertices = true;
        const { root, camera, pass, renderer, takenBy } = await setUp(model);
        pass();
        for (let run = 0; run < FRAMES_TO_HIDE; run++) pass(false);
        expect(renderer.renderBufferDirect).not.toHaveBeenCalled();
        expect(takenBy(camera, 'draw')).toBe(3);
        await act(async () => { root.unmount(); });
    });

    it('never asks about a set too small to be worth it', async () => {
        const { root, camera, pass, renderer, takenBy } = await setUp(modelOf(new THREE.BoxGeometry(1, 1, 1)));
        pass();
        for (let run = 0; run < FRAMES_TO_HIDE; run++) pass(false);
        expect(renderer.renderBufferDirect).not.toHaveBeenCalled();
        expect(takenBy(camera, 'draw')).toBe(3);
        await act(async () => { root.unmount(); });
    });

    it('goes by the box of what it draws: what is well out of view does not stop it hiding, what is near the edge does', async () => {
        const { root, camera, pass, takenBy } = await setUp(detailed(), [...IN_VIEW, [0, 0, 60], [400, 0, -50]]);
        pass();
        for (let run = 0; run < FRAMES_TO_HIDE; run++) pass(false);
        expect(takenBy(camera, 'draw')).toBe(0);
        expect(takenBy(new THREE.PerspectiveCamera(), 'draw')).toBe(5);
        await act(async () => { root.unmount(); });

        // This one stands just past the edge, close enough to come in on a turn: where the query cannot look.
        const wide = await setUp(detailed(), [...IN_VIEW, [55, 0, -50]]);
        wide.pass();
        for (let run = 0; run < FRAMES_TO_HIDE; run++) wide.pass(false);
        expect(wide.takenBy(wide.camera, 'draw')).toBe(4);
        expect(wide.renderer.renderBufferDirect).not.toHaveBeenCalled();
        await act(async () => { wide.root.unmount(); });
    });

    it('asks last among the opaque things, so glass and what is transparent can hide nothing', async () => {
        const { root, scene } = await setUp(detailed());
        const driver = scene.getObjectByName('Occlusion queries') as THREE.Mesh;
        const material = driver.material as THREE.MeshBasicMaterial;
        // three lists by these: what has transmission or is transparent goes in later lists, drawn after this one.
        expect(material.transparent).toBe(false);
        expect((material as unknown as { transmission?: number }).transmission ?? 0).toBe(0);
        // And sorts on the group first, then on the object.
        expect((driver.parent as THREE.Group).isGroup).toBe(true);
        expect(driver.parent!.renderOrder).toBe(OCCLUSION_RENDER_ORDER);
        expect(driver.renderOrder).toBe(OCCLUSION_RENDER_ORDER);
        expect(driver.frustumCulled).toBe(false);
        expect(driver.castShadow).toBe(false);
        await act(async () => { root.unmount(); });
    });

    it('stays out of everything that reads the scene', async () => {
        const { root, scene } = await setUp(detailed());
        const driver = scene.getObjectByName('Occlusion queries') as THREE.Mesh;
        const material = driver.material as THREE.Material;
        // The surface buffer hides it, a velocity is not drawn for it, rays do not see it, and a bake leaves it out.
        expect(drawsSurface(material)).toBe(false);
        expect(drawsVelocity(material)).toBe(false);
        expect(raysSeeMaterial(material)).toBe(false);
        expect(canReceiveDecal(driver)).toBe(false);
        expect(isStaticLightingMesh(driver, new Set())).toBe(false);
        await act(async () => { root.unmount(); });
    });

    it('does nothing with the setting off', async () => {
        const { root, camera, scene, frame, takenBy, context } = await setUp(detailed(), IN_VIEW, false);
        frame();
        expect(scene.getObjectByName('Occlusion queries')).toBeUndefined();
        expect(takenBy(camera, 'draw')).toBe(3);
        expect(context.created).toBe(0);
        await act(async () => { root.unmount(); });
    });

    it('frees its queries with the scene', async () => {
        const { root, pass, context } = await setUp(detailed());
        pass();
        for (let run = 0; run < FRAMES_TO_HIDE; run++) pass(false);
        expect(context.created).toBeGreaterThan(0);
        await act(async () => { root.unmount(); });
        expect(context.deleted).toBe(context.created);
    });
});

describe('the instanced layer in the editor', () => {
    const box = () => modelOf(new THREE.BoxGeometry(1, 1, 1));

    it('keeps one mesh per part in the view being picked in, its instance ids the objects\'', async () => {
        const { root, frame, instanced } = await mount(<InstancedLevelLayer models={[box()]} levelObjects={placedAt(...THREE_PROPS)} interactive selectedIds={new Set()} />);
        frame();
        const meshes = instanced();
        expect(meshes).toHaveLength(1);
        expect(meshes[0].userData.shuffledInstances).toBeUndefined();
        expect(meshes[0].count).toBe(3);
        expect(placedZ(meshes[0])).toEqual([-30, 60, -40]);
        await act(async () => { root.unmount(); });
    });

    it('still picks the right object when the camera has turned', async () => {
        const raycaster = new THREE.Raycaster();
        const { root, camera, frame, instanced } = await mount(<InstancedLevelLayer models={[box()]} levelObjects={placedAt(...THREE_PROPS)} interactive selectedIds={new Set()} />);
        camera.lookAt(0, 0, 1);
        camera.updateMatrixWorld();
        frame();
        const [mesh] = instanced();
        mesh.updateMatrixWorld();
        raycaster.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1));
        expect(raycaster.intersectObject(mesh)[0].instanceId).toBe(1);
        await act(async () => { root.unmount(); });
    });

    it('keeps the selection on a plain part in a view not being picked in, and culls one with nothing selected', async () => {
        const selected = await mount(<InstancedLevelLayer models={[box()]} levelObjects={placedAt(...THREE_PROPS)} interactive={false} selectedIds={new Set(['object-1'])} />);
        const meshes = selected.instanced();
        // The part, and the selection drawn over it.
        expect(meshes).toHaveLength(2);
        expect(meshes.some(mesh => mesh.userData.shuffledInstances)).toBe(false);
        await act(async () => { selected.root.unmount(); });

        const plain = await mount(<InstancedLevelLayer models={[box()]} levelObjects={placedAt(...THREE_PROPS)} interactive={false} selectedIds={new Set()} />);
        expect(plain.instanced()[0].userData.shuffledInstances).toBe(true);
        await act(async () => { plain.root.unmount(); });
    });

    it('sorts by each view\'s own camera, with a set of meshes per view', async () => {
        const first = await mount(<InstancedLevelLayer models={[box()]} levelObjects={placedAt(...THREE_PROPS)} interactive={false} />);
        const second = await mount(<InstancedLevelLayer models={[box()]} levelObjects={placedAt(...THREE_PROPS)} interactive={false} />);
        second.camera.lookAt(0, 0, 1);
        second.camera.updateMatrixWorld();
        first.frame();
        second.frame();
        expect(taken(first.instanced()[0], first.camera, 'draw')).toBe(2);
        expect(taken(second.instanced()[0], second.camera, 'draw')).toBe(1);
        await act(async () => { first.root.unmount(); });
        await act(async () => { second.root.unmount(); });
    });
});
