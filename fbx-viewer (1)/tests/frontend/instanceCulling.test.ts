import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { fitCascade, viewSliceSphere } from '../../runtime/lighting/distanceShadows';
import {
    classifyInstance, CULL_MOVE_ROOM, CULL_TRUST_SHARE, CULL_TURN_ROOM, cullViewFor, gateInstanceDraws, INSTANCE_CASTING, INSTANCE_NEEDS, INSTANCE_SEEN, INSTANCE_UNSEEN,
    newCullView, prepareCullView, sortPlacedInstances, SPHERE_FLOATS, viewCovers, writeSortedInstances, type CullView, type PlacedInstances,
} from '../../utils/instanceCulling';
import type { MeshLodLevel } from '../../utils/meshLod';

/*
 * Which placed instances a view needs: never one a camera within the set's room can see or be shaded by,
 * and how the buffers and the draws follow from that. How it looks in motion is checked in the running engine.
 */

const look = (position: [number, number, number], target: [number, number, number], fov = 60, aspect = 16 / 9): THREE.PerspectiveCamera => {
    const camera = new THREE.PerspectiveCamera(fov, aspect, 0.1, 1000);
    camera.position.set(...position);
    camera.lookAt(...target);
    camera.updateMatrixWorld();
    return camera;
};

const viewOf = (camera: THREE.Camera, lights: Parameters<typeof prepareCullView>[2] = [], pixelsPerUnit = 0): CullView => {
    const view = newCullView();
    prepareCullView(view, camera, lights, pixelsPerUnit);
    return view;
};

const classify = (view: CullView, camera: THREE.Camera, point: [number, number, number], radius = 0.5): number => {
    const eye = camera.getWorldPosition(new THREE.Vector3());
    return classifyInstance(view, point[0], point[1], point[2], radius, eye.distanceTo(new THREE.Vector3(...point)));
};

/** A sun's map as the sky fits it: `towardSun`, around what `camera` sees out to `distance`. */
const fittedSun = (camera: THREE.Camera, towardSun: THREE.Vector3, distance = 250): THREE.DirectionalLight => {
    const light = new THREE.DirectionalLight();
    light.castShadow = true;
    light.shadow.mapSize.set(2048, 2048);
    const centre = new THREE.Vector3();
    fitCascade(light, centre, viewSliceSphere(camera, distance, centre), towardSun);
    light.updateMatrixWorld();
    light.shadow.camera.updateMatrixWorld();
    return light;
};

/** The same every run: a failure can be looked at again. */
const seeded = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Turns and moves `camera` nearly as far as a draw trusts a set for, about a random axis and along a random way. */
const nudge = (camera: THREE.PerspectiveCamera, random: () => number): void => {
    const share = CULL_TRUST_SHARE * 0.98;
    const axis = new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5).normalize();
    camera.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, 2 * Math.asin((CULL_TURN_ROOM * share) / 2)));
    camera.position.add(new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5).normalize().multiplyScalar(CULL_MOVE_ROOM * share));
    camera.updateMatrixWorld();
};

const inside = (camera: THREE.Camera): THREE.Frustum =>
    new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));

describe('what the camera sees', () => {
    const camera = look([0, 0, 0], [0, 0, -1]);
    const view = viewOf(camera);

    it('keeps what is in view and drops what is behind or far to the side', () => {
        expect(classify(view, camera, [0, 0, -20])).toBe(INSTANCE_SEEN);
        expect(classify(view, camera, [0, 0, 40])).toBe(INSTANCE_UNSEEN);
        expect(classify(view, camera, [200, 0, -20])).toBe(INSTANCE_UNSEEN);
    });

    it('keeps what stands around the camera, and what is big enough to reach the view', () => {
        expect(classify(view, camera, [0, 0, 1])).toBe(INSTANCE_SEEN);
        expect(classify(view, camera, [0, 0, 40], 10)).toBe(INSTANCE_UNSEEN);
        expect(classify(view, camera, [0, 0, 40], 40)).toBe(INSTANCE_SEEN);
    });

    it('never drops a sphere that a camera within the room can see', () => {
        const random = seeded(11);
        let checked = 0;
        for (let round = 0; round < 200; round++) {
            const moving = look(
                [random() * 100 - 50, random() * 20, random() * 100 - 50],
                [random() * 100 - 50, random() * 20, random() * 100 - 50],
                30 + random() * 60, 0.5 + random() * 2,
            );
            const chosen = viewOf(moving);
            const eye = moving.position.clone();
            const spheres = Array.from({ length: 200 }, () => new THREE.Sphere(
                eye.clone().add(new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5).multiplyScalar(300)), random() * 4,
            ));
            nudge(moving, random);
            expect(viewCovers(chosen, moving, CULL_TRUST_SHARE)).toBe(true);
            const frustum = inside(moving);
            for (const sphere of spheres) {
                if (!frustum.intersectsSphere(sphere)) continue;
                checked++;
                expect(classifyInstance(chosen, sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius, eye.distanceTo(sphere.center))).toBe(INSTANCE_SEEN);
            }
        }
        expect(checked).toBeGreaterThan(1000);
    });

    it('works through an orthographic view, near plane behind the camera and all', () => {
        const top = new THREE.OrthographicCamera(-50, 50, 25, -25, -100, 100);
        top.position.set(0, 50, 0);
        top.lookAt(0, 0, 0);
        top.updateMatrixWorld();
        const seen = viewOf(top);
        const at = (point: [number, number, number]) => classify(seen, top, point);
        expect(at([10, 0, 10])).toBe(INSTANCE_SEEN);
        // Far along the side the ortho view has no side planes to speak of.
        expect(at([400, 0, 0])).toBe(INSTANCE_UNSEEN);
    });
});

describe('what shades the view', () => {
    // Looking down -Z, with the sun low on the right: shadows fall toward the left, across the view.
    const camera = look([0, 2, 0], [0, 2, -1]);
    const towardSun = new THREE.Vector3(1, 0.3, 0).normalize();
    const sun = fittedSun(camera, towardSun);
    const view = viewOf(camera, [sun]);

    it('keeps an off-screen prop whose shadow falls into the view', () => {
        expect(classify(view, camera, [100, 10, -30], 2)).toBe(INSTANCE_CASTING);
    });

    it('drops one whose shadow falls away from the view, or that no map reaches', () => {
        expect(classify(view, camera, [-200, 10, -30], 2)).toBe(INSTANCE_UNSEEN);
        expect(classify(view, camera, [0, 10, 80], 2)).toBe(INSTANCE_UNSEEN);
        // High up to the right: with a wide map it shades the far view; a tight one covers nothing out there.
        expect(classify(view, camera, [500, 150, -300], 2)).toBe(INSTANCE_CASTING);
        expect(classify(viewOf(camera, [fittedSun(camera, towardSun, 30)]), camera, [500, 150, -300], 2)).toBe(INSTANCE_UNSEEN);
    });

    it('counts a sun and its cascades as one column round all their maps', () => {
        const maps = [30, 100, 250].map(distance => fittedSun(camera, towardSun, distance));
        const all = viewOf(camera, maps);
        expect(all.directionalCount).toBe(1);
        expect(classify(all, camera, [500, 150, -300], 2)).toBe(INSTANCE_CASTING);
        expect(classify(viewOf(camera, [...maps].reverse()), camera, [500, 150, -300], 2)).toBe(INSTANCE_CASTING);
        // Another sun is its own column.
        const moon = fittedSun(camera, new THREE.Vector3(-1, 0.3, 0).normalize());
        const both = viewOf(camera, [...maps, moon]);
        expect(both.directionalCount).toBe(2);
        expect(classify(both, camera, [-500, 150, -300], 2)).toBe(INSTANCE_CASTING);
        expect(classify(all, camera, [-500, 150, -300], 2)).toBe(INSTANCE_UNSEEN);
    });

    it('drops the same prop once shadows are off', () => {
        expect(classify(viewOf(camera), camera, [100, 10, -30], 2)).toBe(INSTANCE_UNSEEN);
    });

    it('keeps whatever stands between a seen point and the sun, for a camera within the room', () => {
        const random = seeded(23);
        let casting = 0;
        let checked = 0;
        for (let round = 0; round < 60; round++) {
            const moving = look([random() * 40 - 20, 2 + random() * 10, random() * 40 - 20], [random() * 200 - 100, random() * 4, random() * 200 - 100]);
            const toward = new THREE.Vector3(random() - 0.5, 0.15 + random(), random() - 0.5).normalize();
            const light = fittedSun(moving, toward);
            const chosen = viewOf(moving, [light]);
            const eye = moving.position.clone();
            nudge(moving, random);
            // The map as it would be fitted for the camera now.
            const refit = fittedSun(moving, toward);
            refit.shadow.updateMatrices(refit);
            const map = new THREE.Matrix4().multiplyMatrices(refit.shadow.camera.projectionMatrix, refit.shadow.camera.matrixWorldInverse);
            for (let sample = 0; sample < 400; sample++) {
                // A point the view sees now, mostly toward the edge of its picture: what the camera has just brought in.
                const edge = () => (random() < 0.5 ? -1 : 1) * (0.7 + random() * 0.3);
                const ray = new THREE.Vector3(edge(), edge(), 0.5).unproject(moving).sub(moving.position).normalize();
                const seenPoint = moving.position.clone().addScaledVector(ray, 1 + random() * 300);
                const onMap = seenPoint.clone().applyMatrix4(map);
                if (Math.abs(onMap.x) > 1 || Math.abs(onMap.y) > 1 || Math.abs(onMap.z) > 1) continue;
                // Something on the line from there to the sun, still inside what the map holds.
                const caster = seenPoint.clone().addScaledVector(toward, random() * 600);
                const casterOnMap = caster.clone().applyMatrix4(map);
                if (Math.abs(casterOnMap.z) > 1) continue;
                const found = classifyInstance(chosen, caster.x, caster.y, caster.z, 0.5, eye.distanceTo(caster));
                checked++;
                expect(found).not.toBe(INSTANCE_UNSEEN);
                if (found === INSTANCE_CASTING) casting++;
            }
        }
        expect(checked).toBeGreaterThan(500);
        expect(casting).toBeGreaterThan(100);
    });

    it('keeps what stands in the light of a point or spot lamp near the view, and not of one far from it', () => {
        const lamp = new THREE.PointLight(0xffffff, 1, 15);
        lamp.castShadow = true;
        lamp.position.set(12, 2, -10);
        lamp.updateMatrixWorld();
        const lit = viewOf(camera, [lamp]);
        expect(classify(lit, camera, [22, 2, -10])).toBe(INSTANCE_CASTING);
        expect(classify(lit, camera, [40, 2, -10])).toBe(INSTANCE_UNSEEN);
        const faraway = new THREE.SpotLight(0xffffff, 1, 15);
        faraway.castShadow = true;
        faraway.position.set(0, 2, 200);
        faraway.updateMatrixWorld();
        expect(classify(viewOf(camera, [faraway]), camera, [0, 2, 195])).toBe(INSTANCE_UNSEEN);
    });

    it('drops most of a field around the camera, even so', () => {
        const random = seeded(5);
        const noon = fittedSun(camera, new THREE.Vector3(0.3, 1, 0.2).normalize());
        const field = viewOf(camera, [noon]);
        const tally = [0, 0, 0];
        for (let index = 0; index < 20000; index++) {
            const angle = random() * Math.PI * 2;
            const out = Math.sqrt(random()) * 300;
            tally[classify(field, camera, [Math.cos(angle) * out, 0, Math.sin(angle) * out], 1)]++;
        }
        expect(tally[INSTANCE_UNSEEN]).toBeGreaterThan(20000 * 0.5);
        expect(tally[INSTANCE_SEEN]).toBeGreaterThan(20000 * 0.1);
    });
});

describe('how long a set holds', () => {
    it('holds through a small turn and move, and for no other camera', () => {
        const camera = look([0, 0, 0], [0, 0, -1]);
        const view = viewOf(camera);
        expect(viewCovers(view, camera, 1)).toBe(true);
        expect(viewCovers(view, look([0, 0, 0], [0, 0, -1]), 1)).toBe(false);
        camera.rotateY(2 * Math.asin((CULL_TURN_ROOM * 0.8) / 2));
        camera.updateMatrixWorld();
        expect(viewCovers(view, camera, 1)).toBe(true);
        expect(viewCovers(view, camera, 0.5)).toBe(false);
        camera.rotateY(0.3);
        camera.updateMatrixWorld();
        expect(viewCovers(view, camera, 1)).toBe(false);
    });

    it('counts a roll, and a move', () => {
        const camera = look([0, 0, 0], [0, 0, -1]);
        const view = viewOf(camera);
        camera.rotateZ(0.5);
        camera.updateMatrixWorld();
        expect(viewCovers(view, camera, 1)).toBe(false);
        const walker = look([0, 0, 0], [0, 0, -1]);
        const walked = viewOf(walker);
        walker.position.x = CULL_MOVE_ROOM * 0.8;
        walker.updateMatrixWorld();
        expect(viewCovers(walked, walker, 1)).toBe(true);
        walker.position.x = CULL_MOVE_ROOM * 1.2;
        walker.updateMatrixWorld();
        expect(viewCovers(walked, walker, 1)).toBe(false);
    });

    it('takes no notice of the frame jitter, but does of a zoom', () => {
        const camera = look([0, 0, 0], [0, 0, -1]);
        const view = viewOf(camera);
        const before = camera.projectionMatrix.clone();
        camera.projectionMatrix.elements[8] -= 0.002;
        camera.projectionMatrix.elements[9] -= 0.002;
        expect(viewCovers(view, camera, CULL_TRUST_SHARE)).toBe(true);
        camera.projectionMatrix.copy(before);
        camera.fov = 90;
        camera.updateProjectionMatrix();
        expect(viewCovers(view, camera, CULL_TRUST_SHARE)).toBe(false);
    });

    it('looks once a frame, and only calls for a sort when something a sort reads has changed', () => {
        const camera = look([0, 0, 0], [0, 0, -1]);
        const view = cullViewFor(camera, null, 1, 800, 4);
        const version = view.version;
        for (let stamp = 2; stamp < 20; stamp++) cullViewFor(camera, null, stamp, 800, 4);
        expect(cullViewFor(camera, null, 20, 800, 4)).toBe(view);
        expect(view.version).toBe(version);

        // A little: at the next interval. Not yet here, the same frame, nor before the interval comes round.
        camera.position.x = CULL_MOVE_ROOM * 0.1;
        camera.updateMatrixWorld();
        cullViewFor(camera, null, 20, 800, 4);
        expect(view.version).toBe(version);
        for (let stamp = 21; stamp < 25; stamp++) cullViewFor(camera, null, stamp, 800, 4);
        expect(view.version).toBe(version + 1);

        // Far enough to use up a share of the room: straight away, whatever the interval says.
        const settled = view.version;
        camera.position.x += CULL_MOVE_ROOM * 0.7;
        camera.updateMatrixWorld();
        cullViewFor(camera, null, 26, 800, 1000000);
        expect(view.version).toBe(settled + 1);
    });

    it('finds the shadow lights under the root it is given', () => {
        const camera = look([0, 2, 0], [0, 2, -1]);
        const scene = new THREE.Scene();
        scene.add(fittedSun(camera, new THREE.Vector3(1, 0.3, 0).normalize()));
        const dark = new THREE.DirectionalLight();
        scene.add(dark);
        const view = cullViewFor(camera, scene, 1, 800, 4);
        expect(view.directionalCount).toBe(1);
        expect(classify(view, camera, [100, 10, -30], 2)).toBe(INSTANCE_CASTING);
    });
});

/** Instances along -Z from the camera at the origin: some in view, some behind it. */
const placedAt = (zs: number[]): PlacedInstances => {
    const matrices = new Float32Array(zs.length * 16);
    const spheres = new Float32Array(zs.length * SPHERE_FLOATS);
    zs.forEach((z, index) => {
        new THREE.Matrix4().makeTranslation(index, 0, z).toArray(matrices, index * 16);
        spheres.set([index, 0, z, 0.5, 1], index * SPHERE_FLOATS);
    });
    return { count: zs.length, matrices, spheres };
};

const levelsWith = (...errors: number[]): MeshLodLevel[] => errors.map(error => ({ geometry: new THREE.BoxGeometry(), error, triangles: 1 }));

const matrixX = (mesh: THREE.InstancedMesh, slot: number): number => mesh.instanceMatrix.array[slot * 16 + 12];

/** The levels a sort says it changed. */
const levelsIn = (changed: number): number[] => [0, 1, 2, 3, 4].filter(level => changed & (1 << level));

describe('the instances in the buffers', () => {
    const camera = look([0, 0, 0], [0, 0, -1]);

    it('lays each level out seen first, casting next, the rest last, and rests with them all', () => {
        const light = fittedSun(camera, new THREE.Vector3(0, 0, 1));
        const view = viewOf(camera, [light]);
        // In order: seen, behind (the sun is behind the camera, so it casts along the view), seen, far to the side.
        const placed = placedAt([-20, 100, -30, -1000]);
        placed.spheres.set([900, 0, 500], 3 * SPHERE_FLOATS);
        const levels = levelsWith(0);
        const assigned = new Int8Array(placed.count).fill(-1);
        const tally = new Int32Array(INSTANCE_NEEDS);
        const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), placed.count);
        const changed = sortPlacedInstances(placed, levels, view, false, assigned, tally);
        expect(levelsIn(changed)).toEqual([0]);
        expect([...tally]).toEqual([2, 1, 1]);
        writeSortedInstances(placed, assigned, tally, changed, [mesh]);
        expect(mesh.count).toBe(4);
        expect([matrixX(mesh, 0), matrixX(mesh, 1), matrixX(mesh, 2), matrixX(mesh, 3)]).toEqual([0, 2, 1, 3]);
        expect(mesh.boundingSphere!.containsPoint(new THREE.Vector3(1, 0, 100))).toBe(true);
        // Only as much as it holds goes up.
        expect(mesh.instanceMatrix.updateRanges).toEqual([{ start: 0, count: 64 }]);
        expect(mesh.instanceMatrix.version).toBe(1);
    });

    it('does nothing at all when a sort changes nothing', () => {
        const view = viewOf(camera);
        const placed = placedAt([-20, 100]);
        const levels = levelsWith(0);
        const assigned = new Int8Array(placed.count).fill(-1);
        const tally = new Int32Array(INSTANCE_NEEDS);
        const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), placed.count);
        writeSortedInstances(placed, assigned, tally, sortPlacedInstances(placed, levels, view, false, assigned, tally), [mesh]);
        const version = mesh.instanceMatrix.version;
        const again = sortPlacedInstances(placed, levels, view, false, assigned, tally);
        expect(again).toBe(0);
        writeSortedInstances(placed, assigned, tally, again, [mesh]);
        expect(mesh.instanceMatrix.version).toBe(version);
        expect([...tally]).toEqual([1, 0, 1]);
    });

    it('sorts the off-screen into detail levels too: anything else that draws them wants the same', () => {
        // Pixels per unit high enough that near instances need the full level, and far ones the simple one.
        const view = viewOf(camera, [], 1000);
        const placed = placedAt([-5, -5000, 5, 5000]);
        const levels = levelsWith(0, 0.01);
        const assigned = new Int8Array(placed.count).fill(-1);
        const tally = new Int32Array(levels.length * INSTANCE_NEEDS);
        expect(levelsIn(sortPlacedInstances(placed, levels, view, false, assigned, tally))).toEqual([0, 1]);
        expect([...assigned]).toEqual([
            0 * INSTANCE_NEEDS + INSTANCE_SEEN, 1 * INSTANCE_NEEDS + INSTANCE_UNSEEN,
            0 * INSTANCE_NEEDS + INSTANCE_UNSEEN, 1 * INSTANCE_NEEDS + INSTANCE_UNSEEN,
        ]);
    });

    it('touches only the levels something moved in or out of', () => {
        const view = viewOf(camera, [], 1000);
        const placed = placedAt([-5, -5000]);
        const levels = levelsWith(0, 0.01);
        const assigned = new Int8Array(placed.count).fill(-1);
        const tally = new Int32Array(levels.length * INSTANCE_NEEDS);
        const meshes = levels.map(level => new THREE.InstancedMesh(level.geometry, new THREE.MeshBasicMaterial(), placed.count));
        writeSortedInstances(placed, assigned, tally, sortPlacedInstances(placed, levels, view, false, assigned, tally), meshes);
        expect(meshes.map(mesh => mesh.count)).toEqual([1, 1]);
        const versions = meshes.map(mesh => mesh.instanceMatrix.version);

        // Only the near one goes off-screen, in its own level.
        placed.spheres.set([0, 0, 5], 0);
        const bounds = meshes[0].boundingSphere!.clone();
        const changed = sortPlacedInstances(placed, levels, view, false, assigned, tally);
        expect(levelsIn(changed)).toEqual([0]);
        writeSortedInstances(placed, assigned, tally, changed, meshes);
        expect(meshes[0].instanceMatrix.version).toBe(versions[0] + 1);
        expect(meshes[1].instanceMatrix.version).toBe(versions[1]);
        // The same instances in another order: the level's bounds are not worked out again.
        expect(meshes[0].boundingSphere!.equals(bounds)).toBe(true);
    });

    it('takes every instance as seen when told to keep them all', () => {
        const view = viewOf(camera);
        const placed = placedAt([-20, 100]);
        const assigned = new Int8Array(placed.count).fill(-1);
        const tally = new Int32Array(INSTANCE_NEEDS);
        sortPlacedInstances(placed, levelsWith(0), view, true, assigned, tally);
        expect([...tally]).toEqual([2, 0, 0]);
    });

    it('accounts for every one of 20,000 instances across the levels', () => {
        const random = seeded(3);
        const light = fittedSun(camera, new THREE.Vector3(0.5, 0.6, 0.2).normalize());
        const view = viewOf(camera, [light, light, light], 1000);
        const count = 20000;
        const matrices = new Float32Array(count * 16);
        const spheres = new Float32Array(count * SPHERE_FLOATS);
        for (let index = 0; index < count; index++) {
            spheres.set([random() * 600 - 300, random() * 4, random() * 600 - 300, 1, 1], index * SPHERE_FLOATS);
        }
        const levels = levelsWith(0, 0.01, 0.02, 0.05, 0.1);
        const assigned = new Int8Array(count).fill(-1);
        const tally = new Int32Array(levels.length * INSTANCE_NEEDS);
        const placed = { count, matrices, spheres };
        const meshes = levels.map(level => new THREE.InstancedMesh(level.geometry, new THREE.MeshBasicMaterial(), count));
        const sum = () => tally.reduce((total, value) => total + value, 0);
        writeSortedInstances(placed, assigned, tally, sortPlacedInstances(placed, levels, view, false, assigned, tally), meshes);
        expect(sum()).toBe(count);
        expect(meshes.reduce((total, mesh) => total + mesh.count, 0)).toBe(count);
    });
});

describe('what a draw takes', () => {
    const setup = () => {
        const camera = look([0, 0, 0], [0, 0, -1]);
        const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 10);
        // Second level of two: 2 seen, 3 casting, 5 unseen.
        const tally = new Int32Array([0, 0, 0, 2, 3, 5]);
        const sorted = { view: viewOf(camera) as CullView | null };
        gateInstanceDraws(mesh, 1, tally, sorted);
        mesh.count = 10;
        const renderer = {} as THREE.WebGLRenderer;
        const scene = new THREE.Scene();
        const geometry = mesh.geometry;
        const draw = (view: THREE.Camera): number => {
            mesh.onBeforeRender(renderer, scene, view, geometry, mesh.material as THREE.Material, new THREE.Group());
            const taken = mesh.count;
            mesh.onAfterRender(renderer, scene, view, geometry, mesh.material as THREE.Material, new THREE.Group());
            expect(mesh.count).toBe(10);
            return taken;
        };
        const shadow = (view: THREE.Camera): number => {
            const args = [renderer, scene, view, new THREE.OrthographicCamera(), geometry, new THREE.MeshDepthMaterial(), new THREE.Group()] as unknown as Parameters<THREE.Mesh['onBeforeShadow']>;
            mesh.onBeforeShadow(...args);
            const taken = mesh.count;
            mesh.onAfterShadow(...args);
            expect(mesh.count).toBe(10);
            return taken;
        };
        return { camera, mesh, sorted, draw, shadow };
    };

    it('is the seen in the view, and the casting as well in its shadow maps', () => {
        const { camera, draw, shadow } = setup();
        expect(draw(camera)).toBe(2);
        expect(shadow(camera)).toBe(5);
    });

    it('is everything for any other camera: another view, a probe, the sky looking down', () => {
        const { draw, shadow } = setup();
        const other = look([0, 50, 0], [0, 0, 0]);
        expect(draw(other)).toBe(10);
        expect(shadow(other)).toBe(10);
    });

    it('is everything once the camera has left the room, so nothing pops however fast it turned', () => {
        const { camera, draw, shadow } = setup();
        camera.rotateY(Math.PI);
        camera.updateMatrixWorld();
        expect(draw(camera)).toBe(10);
        expect(shadow(camera)).toBe(10);
    });

    it('leaves a shadow map more room than a draw, as a map can stay for a few frames', () => {
        const { camera, draw, shadow } = setup();
        camera.rotateY(2 * Math.asin((CULL_TURN_ROOM * 0.7) / 2));
        camera.updateMatrixWorld();
        expect(draw(camera)).toBe(2);
        expect(shadow(camera)).toBe(10);
    });

    it('is everything there is before a first sort', () => {
        const { camera, sorted, draw } = setup();
        sorted.view = null;
        expect(draw(camera)).toBe(10);
    });

    it('still lets graph materials see their shadow draw', () => {
        const { camera, mesh, shadow } = setup();
        const graph = vi.spyOn(THREE.Mesh.prototype, 'onBeforeShadow');
        shadow(camera);
        expect(graph).toHaveBeenCalledTimes(1);
        expect(graph.mock.contexts[0]).toBe(mesh);
        graph.mockRestore();
    });
});
