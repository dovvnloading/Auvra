import * as THREE from 'three';
import { LOOK_REACH_STEP } from '../runtime/lighting/distanceShadows';
import { chooseLodLevel, lodPixelsPerUnit, type MeshLodLevel } from './meshLod';

/**
 * INSTANCE CULLING
 *
 * What a view needs of each placed instance (components/Environment/InstancedLevelLayer.tsx draws them):
 *  - seen: in the view, or where the camera could bring it before the set is chosen again;
 *  - casting: off-screen, but its shadow can fall into the view;
 *  - unseen: neither.
 * Every test errs toward keeping: an instance kept for nothing costs a little, one dropped wrongly pops.
 *
 * A set is chosen for one camera and trusted while that camera stays inside the room it was chosen with,
 * which is checked at every draw. Past that room, or for any other camera (a probe's, the sky's overhead
 * one, a bake's), a draw takes every instance, so nothing rests on how often the set is chosen or on who
 * else draws the scene.
 *
 * Each level's instance buffer holds all its instances, the seen first, then the casting, then the rest, and
 * the mesh's count says how many a draw takes. Their order changes as the view turns, so nothing may read
 * an instance's index from frame to frame in those meshes: they say so with userData.shuffledInstances.
 */

/** How far the camera may turn from where a set was chosen, as the chord of the angle (2 sin(angle / 2)): some 11 degrees. */
export const CULL_TURN_ROOM = 0.2;
/** How far it may move from there, in world units. */
export const CULL_MOVE_ROOM = 2;
/** Room around an instance's bounds, as a share of their radius: wind bends what is drawn past them. */
const CULL_BOUNDS_ROOM = 1.5;
/** The share of the room at which the set is chosen again, not waiting for the next interval. */
const RESORT_SHARE = 0.5;
/** The share of the room a draw trusts the set to; the rest is left for the frame's jitter. */
export const CULL_TRUST_SHARE = 0.9;
/** The same for a shadow map: a cascade's map stays for a few frames (DistanceShadowLights.tsx), and the rest is left for those. */
export const CULL_SHADOW_TRUST_SHARE = 0.5;
/** How far, as a share, a projection may change before a set chosen under it is no longer trusted. */
const PROJECTION_TOLERANCE = 1e-3;

/** A layer no camera looks through: what lands on it is read by rays and decals, and never drawn. */
export const UNDRAWN_LAYER = 31;

export const INSTANCE_SEEN = 0;
export const INSTANCE_CASTING = 1;
export const INSTANCE_UNSEEN = 2;
/** How many of those there are, and so how many slots of a tally each detail level has. */
export const INSTANCE_NEEDS = 3;

/** The parts of the camera's matrices a set depends on. The frame's jitter goes in the rest (temporalStage.ts). */
const ROTATION_ELEMENTS = [0, 1, 2, 4, 5, 6, 8, 9, 10];
const PROJECTION_ELEMENTS = [0, 5, 10, 14];
/** Where a view's pose holds the eye, and the projection's elements. */
const POSE_EYE = 9;
const POSE_PROJECTION = 12;
const POSE_FLOATS = 16;
const PLANE_FLOATS = 24;
/** Direction away from the light and its map's depth; the point it aims at and its map's radius; how fast that direction climbs each plane. */
const DIRECTIONAL_FLOATS = 14;
/** Where a point or spot light is, and how far its shadows reach. */
const LOCAL_FLOATS = 4;

/** Everything a sort reads of a camera and the scene's shadow lights, shared by every part drawn through that camera. */
export interface CullView {
    camera: THREE.Camera | null;
    /** Goes up whenever a sort could come out differently. */
    version: number;
    /** The renderer's frame this view last looked at the camera, and how many frames it has looked at. */
    stamp: number;
    frame: number;
    pixelsPerUnit: number;
    /** The rotation, eye and projection the set is chosen for. */
    pose: Float64Array;
    /** The view's six planes, each normal x, y, z and constant: inside is where all come out positive. */
    planes: Float64Array;
    directional: Float64Array;
    directionalCount: number;
    local: Float64Array;
    localCount: number;
}

export const newCullView = (): CullView => ({
    camera: null, version: 0, stamp: -1, frame: 0, pixelsPerUnit: 0,
    pose: new Float64Array(POSE_FLOATS), planes: new Float64Array(PLANE_FLOATS),
    directional: new Float64Array(0), directionalCount: 0, local: new Float64Array(0), localCount: 0,
});

/**
 * Whether a set chosen for `view` still holds for `camera` as it is now, with `share` of the room used at
 * most. Any other camera is not covered at all.
 */
export const viewCovers = (view: CullView, camera: THREE.Camera, share: number): boolean => {
    if (view.camera !== camera) return false;
    const { pose } = view;
    const world = camera.matrixWorld.elements;
    let turned = 0;
    for (let k = 0; k < ROTATION_ELEMENTS.length; k++) {
        const change = world[ROTATION_ELEMENTS[k]] - pose[k];
        turned += change * change;
    }
    // Between two rotations the squares of their differences add up to twice the square of the chord.
    const turn = CULL_TURN_ROOM * share;
    if (turned > 2 * turn * turn) return false;
    const x = world[12] - pose[POSE_EYE], y = world[13] - pose[POSE_EYE + 1], z = world[14] - pose[POSE_EYE + 2];
    const move = CULL_MOVE_ROOM * share;
    if (x * x + y * y + z * z > move * move) return false;
    const projection = camera.projectionMatrix.elements;
    for (let k = 0; k < PROJECTION_ELEMENTS.length; k++) {
        const held = pose[POSE_PROJECTION + k];
        if (Math.abs(projection[PROJECTION_ELEMENTS[k]] - held) > Math.abs(held) * PROJECTION_TOLERANCE) return false;
    }
    return true;
};

let _changed = false;
const put = (into: Float64Array, at: number, value: number): void => {
    if (into[at] === value) return;
    into[at] = value;
    _changed = true;
};

const withRoom = (array: Float64Array, floats: number): Float64Array => {
    if (array.length >= floats) return array;
    const grown = new Float64Array(floats);
    grown.set(array);
    return grown;
};

const _frustum = new THREE.Frustum();
const _viewProjection = new THREE.Matrix4();
const _lightAt = new THREE.Vector3();
const _lightAim = new THREE.Vector3();
const _away = new THREE.Vector3();
const _apart = new THREE.Vector3();
const _eye = new THREE.Vector3();

type ShadowLight = THREE.DirectionalLight | THREE.PointLight | THREE.SpotLight;

/** Where a directional light's shadows can fall: along the light, so inside the column its map looks down. */
interface ShadowColumn {
    away: THREE.Vector3;
    aim: THREE.Vector3;
    depth: number;
    radius: number;
}

/** How close to 1 two directions' cosine must be for their lights to count as one sun. */
const SAME_WAY = 0.999999;

/**
 * Reads what a sort needs from `camera` (its matrices up to date) and the shadow lights into `view`, whose
 * version goes up only if any of it changed.
 */
export const prepareCullView = (view: CullView, camera: THREE.Camera, lights: readonly ShadowLight[], pixelsPerUnit: number): void => {
    _changed = view.camera !== camera || view.pixelsPerUnit !== pixelsPerUnit;
    view.camera = camera;
    view.pixelsPerUnit = pixelsPerUnit;
    const { pose, planes } = view;
    const world = camera.matrixWorld.elements;
    ROTATION_ELEMENTS.forEach((element, k) => put(pose, k, world[element]));
    for (let k = 0; k < 3; k++) put(pose, POSE_EYE + k, world[12 + k]);
    PROJECTION_ELEMENTS.forEach((element, k) => put(pose, POSE_PROJECTION + k, camera.projectionMatrix.elements[element]));
    _frustum.setFromProjectionMatrix(_viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    _frustum.planes.forEach((plane, p) => {
        put(planes, p * 4, plane.normal.x);
        put(planes, p * 4 + 1, plane.normal.y);
        put(planes, p * 4 + 2, plane.normal.z);
        put(planes, p * 4 + 3, plane.constant);
    });

    view.local = withRoom(view.local, lights.length * LOCAL_FLOATS);
    _eye.set(world[12], world[13], world[14]);
    const columns: ShadowColumn[] = [];
    let localCount = 0;
    for (const light of lights) {
        light.getWorldPosition(_lightAt);
        const sun = light as THREE.DirectionalLight;
        if (sun.isDirectionalLight) {
            sun.target.getWorldPosition(_lightAim);
            _away.subVectors(_lightAim, _lightAt).normalize();
            const box = sun.shadow.camera;
            const depth = box.far - box.near;
            // Round the map's corners, and it follows the camera: it can turn or move, and a zoom re-fits it a step wider.
            const halfSide = Math.max(Math.abs(box.left), Math.abs(box.right), Math.abs(box.top), Math.abs(box.bottom));
            const follows = _lightAim.distanceTo(_eye) * CULL_TURN_ROOM + CULL_MOVE_ROOM;
            const radius = halfSide * Math.SQRT2 * LOOK_REACH_STEP + follows;
            const same = columns.find(column => column.away.dot(_away) > SAME_WAY);
            if (!same) {
                columns.push({ away: _away.clone(), aim: _lightAim.clone(), depth, radius });
                continue;
            }
            // A sun and its cascades: one column round all their maps, so an instance is looked at once.
            const along = _apart.subVectors(_lightAim, same.aim).dot(_away);
            const between = Math.sqrt(Math.max(0, _apart.lengthSq() - along * along));
            if (radius > same.radius) same.aim.copy(_lightAim);
            same.radius = Math.max(same.radius, radius, Math.min(same.radius, radius) + between);
            same.depth = Math.max(same.depth, depth);
            continue;
        }
        // As far as its light goes, as three.js draws its map. One whose light stops short of the view is no matter.
        const reach = (light as THREE.PointLight).distance || light.shadow.camera.far;
        const room = reach + _lightAt.distanceTo(_eye) * CULL_TURN_ROOM + CULL_MOVE_ROOM;
        let reachesView = true;
        for (let p = 0; p < 6; p++) {
            if (planes[p * 4] * _lightAt.x + planes[p * 4 + 1] * _lightAt.y + planes[p * 4 + 2] * _lightAt.z + planes[p * 4 + 3] + room < 0) reachesView = false;
        }
        if (!reachesView) continue;
        const at = localCount++ * LOCAL_FLOATS;
        put(view.local, at, _lightAt.x);
        put(view.local, at + 1, _lightAt.y);
        put(view.local, at + 2, _lightAt.z);
        put(view.local, at + 3, reach);
    }
    view.directional = withRoom(view.directional, columns.length * DIRECTIONAL_FLOATS);
    columns.forEach((column, index) => {
        const at = index * DIRECTIONAL_FLOATS;
        const { away, aim } = column;
        put(view.directional, at, away.x);
        put(view.directional, at + 1, away.y);
        put(view.directional, at + 2, away.z);
        put(view.directional, at + 3, column.depth);
        put(view.directional, at + 4, aim.x);
        put(view.directional, at + 5, aim.y);
        put(view.directional, at + 6, aim.z);
        put(view.directional, at + 7, column.radius);
        for (let p = 0; p < 6; p++) {
            put(view.directional, at + 8 + p, planes[p * 4] * away.x + planes[p * 4 + 1] * away.y + planes[p * 4 + 2] * away.z);
        }
    });
    if (view.directionalCount !== columns.length || view.localCount !== localCount) _changed = true;
    view.directionalCount = columns.length;
    view.localCount = localCount;
    if (_changed) view.version++;
};

/** How far above each of the view's planes the instance in hand stands, with its room. */
const _heights = new Float64Array(6);
/** What an instance shades can be farther from the eye than it is, by as far as its shadow fell, and has that much more room. */
const SWEPT_ROOM = CULL_TURN_ROOM;

/** Whether an off-screen instance's shadow can fall into the view: `bounds` is its radius with room, `room` that and the camera's. */
const castsIntoView = (view: CullView, x: number, y: number, z: number, bounds: number, room: number): boolean => {
    const { local, directional, planes } = view;
    for (let light = 0, at = 0; light < view.localCount; light++, at += LOCAL_FLOATS) {
        const dx = x - local[at], dy = y - local[at + 1], dz = z - local[at + 2];
        const reach = local[at + 3] + bounds;
        if (dx * dx + dy * dy + dz * dz <= reach * reach) return true;
    }
    let measured = false;
    for (let light = 0, at = 0; light < view.directionalCount; light++, at += DIRECTIONAL_FLOATS) {
        const dx = x - directional[at + 4], dy = y - directional[at + 5], dz = z - directional[at + 6];
        const along = dx * directional[at] + dy * directional[at + 1] + dz * directional[at + 2];
        const column = directional[at + 7] + bounds;
        if (dx * dx + dy * dy + dz * dz - along * along > column * column) continue;
        if (!measured) {
            measured = true;
            for (let p = 0, plane = 0; p < 6; p++, plane += 4) {
                _heights[p] = planes[plane] * x + planes[plane + 1] * y + planes[plane + 2] * z + planes[plane + 3] + room;
            }
        }
        // The instance swept along the light as far as the map is deep: is any of that inside all six planes at once?
        let enters = 0;
        let leaves = directional[at + 3];
        for (let p = 0; p < 6 && enters <= leaves; p++) {
            const climb = directional[at + 8 + p] + SWEPT_ROOM;
            const height = _heights[p];
            if (climb > 0) {
                if (height < 0 && -height / climb > enters) enters = -height / climb;
            } else if (height < 0) {
                leaves = -1;
            } else if (climb < 0 && -height / climb < leaves) {
                leaves = -height / climb;
            }
        }
        if (enters <= leaves) return true;
    }
    return false;
};

/**
 * What `view` needs of an instance: the middle of its bounds at (x, y, z), their `radius`, `distance` from the
 * eye. The room in each test covers all the camera can do inside the set's room: a plane's normal turns by at
 * most the chord of the angle, so a point's height over it changes by no more than its distance from the eye
 * times that, plus how far the eye moved.
 */
export const classifyInstance = (view: CullView, x: number, y: number, z: number, radius: number, distance: number): number => {
    const { planes } = view;
    const bounds = radius * CULL_BOUNDS_ROOM;
    const room = bounds + distance * CULL_TURN_ROOM + CULL_MOVE_ROOM;
    for (let at = 0; at < PLANE_FLOATS; at += 4) {
        if (planes[at] * x + planes[at + 1] * y + planes[at + 2] * z + planes[at + 3] + room < 0) {
            return castsIntoView(view, x, y, z, bounds, room) ? INSTANCE_CASTING : INSTANCE_UNSEEN;
        }
    }
    return INSTANCE_SEEN;
};

/** Floats of an instance in PlacedInstances.spheres: the middle of its bounds, their radius, its scale. */
export const SPHERE_FLOATS = 5;

/** A part's instances as placed, the hidden left out. */
export interface PlacedInstances {
    count: number;
    /** Sixteen floats each. */
    matrices: Float32Array;
    spheres: Float32Array;
}

/** Above this many bits, what sortPlacedInstances returns says which levels' members changed, not only their order. */
const MEMBERS_SHIFT = 16;

/**
 * Sorts every instance into a detail level and what the view needs of it, as `level * INSTANCE_NEEDS + need` in
 * `assigned` (negative: not yet sorted), and counts each slot in `tally`. `keepAll` takes every instance as
 * seen. Returns which levels changed, for writeSortedInstances: 0 when none did. Allocates nothing.
 */
export const sortPlacedInstances = (
    placed: PlacedInstances, levels: readonly MeshLodLevel[], view: CullView, keepAll: boolean, assigned: Int8Array, tally: Int32Array,
): number => {
    tally.fill(0);
    const { spheres } = placed;
    const { pose, pixelsPerUnit } = view;
    const eyeX = pose[POSE_EYE], eyeY = pose[POSE_EYE + 1], eyeZ = pose[POSE_EYE + 2];
    let changed = 0;
    for (let index = 0, at = 0; index < placed.count; index++, at += SPHERE_FLOATS) {
        const x = spheres[at], y = spheres[at + 1], z = spheres[at + 2];
        const dx = x - eyeX, dy = y - eyeY, dz = z - eyeZ;
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const level = chooseLodLevel(levels, spheres[at + 4], distance, pixelsPerUnit);
        const slot = level * INSTANCE_NEEDS + (keepAll ? INSTANCE_SEEN : classifyInstance(view, x, y, z, spheres[at + 3], distance));
        tally[slot]++;
        const was = assigned[index];
        if (was === slot) continue;
        assigned[index] = slot;
        const left = was < 0 ? level : Math.floor(was / INSTANCE_NEEDS);
        changed |= (1 << level) | (1 << left);
        if (left !== level || was < 0) changed |= (1 << (level + MEMBERS_SHIFT)) | (1 << (left + MEMBERS_SHIFT));
    }
    return changed;
};

let _next = new Int32Array(0);
let _bounds = new Float64Array(0);

/**
 * Writes the instances of the `changed` levels into their meshes as `assigned` and `tally` have them: the
 * seen first, then the casting, then the rest. A mesh rests with its count at all of them, so whatever reads it
 * between draws finds the whole level; only what it holds changes uploads, and only as much as it holds.
 */
export const writeSortedInstances = (
    placed: PlacedInstances, assigned: Int8Array, tally: Int32Array, changed: number, meshes: readonly (THREE.InstancedMesh | null)[],
): void => {
    if (!changed) return;
    const levels = tally.length / INSTANCE_NEEDS;
    if (_next.length < tally.length) _next = new Int32Array(tally.length);
    if (_bounds.length < levels * 6) _bounds = new Float64Array(levels * 6);
    const targets: (Float32Array | null)[] = [];
    let membersChanged = false;
    for (let level = 0; level < levels; level++) {
        const slot = level * INSTANCE_NEEDS;
        _next[slot + INSTANCE_SEEN] = 0;
        _next[slot + INSTANCE_CASTING] = tally[slot + INSTANCE_SEEN];
        _next[slot + INSTANCE_UNSEEN] = tally[slot + INSTANCE_SEEN] + tally[slot + INSTANCE_CASTING];
        _bounds.fill(Infinity, level * 6, level * 6 + 3);
        _bounds.fill(-Infinity, level * 6 + 3, level * 6 + 6);
        const mesh = meshes[level];
        targets.push(mesh && (changed & (1 << level)) ? mesh.instanceMatrix.array as Float32Array : null);
        if (changed & (1 << (level + MEMBERS_SHIFT))) membersChanged = true;
    }
    const { matrices, spheres } = placed;
    for (let index = 0; index < placed.count; index++) {
        const slot = assigned[index];
        const level = Math.floor(slot / INSTANCE_NEEDS);
        const target = targets[level];
        if (!target) continue;
        const to = _next[slot]++ * 16;
        const from = index * 16;
        for (let k = 0; k < 16; k++) target[to + k] = matrices[from + k];
    }
    if (membersChanged) {
        for (let index = 0, at = 0; index < placed.count; index++, at += SPHERE_FLOATS) {
            const box = Math.floor(assigned[index] / INSTANCE_NEEDS) * 6;
            const radius = spheres[at + 3];
            for (let axis = 0; axis < 3; axis++) {
                const middle = spheres[at + axis];
                if (middle - radius < _bounds[box + axis]) _bounds[box + axis] = middle - radius;
                if (middle + radius > _bounds[box + 3 + axis]) _bounds[box + 3 + axis] = middle + radius;
            }
        }
    }
    for (let level = 0; level < levels; level++) {
        const mesh = meshes[level];
        if (!mesh || !targets[level]) continue;
        const slot = level * INSTANCE_NEEDS;
        const total = tally[slot] + tally[slot + 1] + tally[slot + 2];
        mesh.count = total;
        if (changed & (1 << (level + MEMBERS_SHIFT))) {
            // The bounds follow the instances now held, so the whole set is culled correctly.
            const sphere = mesh.boundingSphere ?? (mesh.boundingSphere = new THREE.Sphere());
            const at = level * 6;
            if (total) {
                sphere.center.set((_bounds[at] + _bounds[at + 3]) / 2, (_bounds[at + 1] + _bounds[at + 4]) / 2, (_bounds[at + 2] + _bounds[at + 5]) / 2);
                sphere.radius = Math.hypot(_bounds[at + 3] - _bounds[at], _bounds[at + 4] - _bounds[at + 1], _bounds[at + 5] - _bounds[at + 2]) / 2;
            } else {
                sphere.makeEmpty();
            }
        }
        if (!total) continue;
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, total * 16);
        mesh.instanceMatrix.needsUpdate = true;
    }
};

/**
 * Has `mesh`, the instanced mesh of detail level `level`, draw only what the pass in hand needs: the seen for
 * the camera its set was chosen for, the casting as well in that camera's shadow maps, and for anything else,
 * or once the camera has left the set's room, every instance.
 */
export const gateInstanceDraws = (mesh: THREE.InstancedMesh, level: number, tally: Int32Array, sorted: { view: CullView | null }): void => {
    const slot = level * INSTANCE_NEEDS;
    const everything = () => tally[slot] + tally[slot + 1] + tally[slot + 2];
    const rest = () => { mesh.count = everything(); };
    mesh.onBeforeRender = (_renderer, _scene, camera) => {
        mesh.count = sorted.view && viewCovers(sorted.view, camera, CULL_TRUST_SHARE) ? tally[slot] : everything();
    };
    mesh.onAfterRender = rest;
    mesh.onBeforeShadow = (...args) => {
        // Graph materials teach the shadow's depth material here (runtime/materials/graphMaterial.ts).
        THREE.Mesh.prototype.onBeforeShadow.apply(mesh, args);
        mesh.count = sorted.view && viewCovers(sorted.view, args[2], CULL_SHADOW_TRUST_SHARE) ? tally[slot] + tally[slot + 1] : everything();
    };
    mesh.onAfterShadow = rest;
};

const views = new WeakMap<THREE.Camera, CullView>();
const _lights: ShadowLight[] = [];

const collectShadowLight = (object: THREE.Object3D): void => {
    const light = object as THREE.DirectionalLight & THREE.PointLight & THREE.SpotLight;
    if (object.castShadow && (light.isDirectionalLight || light.isPointLight || light.isSpotLight)) _lights.push(light);
};

/**
 * The view every part drawn through `camera` sorts against, looked at once a frame (`stamp`): every `interval`
 * frames, or sooner once the camera has used up a good share of the room. `shadowRoot` is where its scene's
 * lights are, or null with shadows off.
 */
export const cullViewFor = (camera: THREE.Camera, shadowRoot: THREE.Object3D | null, stamp: number, viewportHeight: number, interval: number): CullView => {
    let view = views.get(camera);
    if (!view) {
        view = newCullView();
        views.set(camera, view);
    }
    if (view.stamp === stamp) return view;
    view.stamp = stamp;
    camera.updateWorldMatrix(true, false);
    if (view.frame++ % interval === 0 || !viewCovers(view, camera, RESORT_SHARE)) {
        shadowRoot?.traverseVisible(collectShadowLight);
        prepareCullView(view, camera, _lights, lodPixelsPerUnit(camera, viewportHeight));
        _lights.length = 0;
    }
    return view;
};
