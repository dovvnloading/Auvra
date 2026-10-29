import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { findBone } from './ik';
import { MotionDatabase, SAMPLE_RATE, type MotionClipSamples, type MotionSample } from './motionMatching';

/**
 * Builds a motion matching database from a character's own clips: each clip played on a copy of the
 * model at SAMPLE_RATE, its hips and feet read in the model's space. A clip made "in place" (its hips
 * do not travel) is given the travel its feet show: the foot on the ground slides back under the body
 * as fast as the body would move forward, so that slide, turned round, is the clip's motion. The root
 * and facing are then evened out over about a stride, so they follow the body's course rather than
 * the sway of each step.
 */

/** Below this many metres of hips travel over a clip, it is taken to be in place. */
const IN_PLACE_TRAVEL = 0.15;
/** How near its lowest a foot must be to stand on the ground, as a share of the hips' height above it. */
const CONTACT_HEIGHT = 0.08;
/** Seconds either side the root and facing are averaged over. */
const SMOOTHING = 0.35;

const _position = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();

const yawOf = (bone: THREE.Object3D): number => {
    bone.getWorldQuaternion(_quaternion);
    _forward.set(0, 0, 1).applyQuaternion(_quaternion);
    return Math.atan2(_forward.x, _forward.z);
};

const point = (bone: THREE.Object3D) => {
    bone.getWorldPosition(_position);
    return { x: _position.x, y: _position.y, z: _position.z };
};

/** Gives an in-place clip the travel its planted foot shows, in place of its still root. */
export const travelFromFeet = (samples: MotionSample[]): void => {
    if (samples.length < 2) return;
    const ground = Math.min(...samples.map(sample => Math.min(sample.leftFoot.y, sample.rightFoot.y)));
    const reach = CONTACT_HEIGHT * Math.max(1e-3, ...samples.map(sample => sample.hips.y - ground));
    // Each frame's travel is the standing (lower) foot's slide under the hips, turned round; with both feet up it is not known.
    const steps = samples.map((now, i) => {
        if (i === 0) return null;
        const before = samples[i - 1];
        const left = now.leftFoot.y + before.leftFoot.y <= now.rightFoot.y + before.rightFoot.y;
        const foot = left ? now.leftFoot : now.rightFoot;
        const was = left ? before.leftFoot : before.rightFoot;
        if (Math.max(foot.y, was.y) > ground + reach) return null;
        return { x: (was.x - before.hips.x) - (foot.x - now.hips.x), z: (was.z - before.hips.z) - (foot.z - now.hips.z) };
    });
    const known = steps.filter((step): step is { x: number; z: number } => step !== null);
    const usual = known.length
        ? { x: known.reduce((sum, step) => sum + step.x, 0) / known.length, z: known.reduce((sum, step) => sum + step.z, 0) / known.length }
        : { x: 0, z: 0 };
    let x = 0, z = 0;
    samples.forEach((now, i) => {
        if (i > 0) {
            const step = steps[i] ?? usual;
            x += step.x;
            z += step.z;
        }
        // The body and feet keep their places relative to the root; the root moves.
        const dx = x - now.root.x, dz = z - now.root.z;
        now.root = { x, y: now.root.y, z };
        now.hips = { x: now.hips.x + dx, y: now.hips.y, z: now.hips.z + dz };
        now.leftFoot = { x: now.leftFoot.x + dx, y: now.leftFoot.y, z: now.leftFoot.z + dz };
        now.rightFoot = { x: now.rightFoot.x + dx, y: now.rightFoot.y, z: now.rightFoot.z + dz };
    });
};

/** `values` averaged over `half` samples either side; a looping series carries on past its ends by its change per lap. */
export const smoothSeries = (values: readonly number[], loop: boolean, half: number): number[] => {
    const n = values.length;
    if (n < 3 || half < 1) return values.slice();
    const lap = loop ? (values[n - 1] - values[0]) * n / (n - 1) : 0;
    const at = (j: number) => {
        if (!loop) return values[Math.max(0, Math.min(n - 1, j))];
        const laps = Math.floor(j / n);
        return values[j - laps * n] + lap * laps;
    };
    return values.map((_, i) => {
        let sum = 0;
        for (let j = i - half; j <= i + half; j++) sum += at(j);
        return sum / (2 * half + 1);
    });
};

/** The hips' heading in the model's bind pose (facing 0), or null without a skinned mesh to pose. */
const restYaw = (copy: THREE.Object3D, hips: THREE.Object3D): number | null => {
    const skinned: THREE.SkinnedMesh[] = [];
    copy.traverse(node => { if ((node as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(node as THREE.SkinnedMesh); });
    if (!skinned.length) return null;
    skinned[0].skeleton.pose();
    copy.updateMatrixWorld(true);
    return yawOf(hips);
};

const wrapAngle = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

/** A clip sampled for matching on a copy of `model`, or null when the model has no hips and feet to read. */
export const sampleClip = (model: THREE.Object3D, clip: THREE.AnimationClip, loop = true): MotionClipSamples | null => {
    const copy = cloneSkinned(model);
    copy.position.set(0, 0, 0);
    copy.quaternion.identity();
    const hips = findBone(copy, 'Hips');
    const leftFoot = findBone(copy, 'LeftFoot');
    const rightFoot = findBone(copy, 'RightFoot');
    if (!hips || !leftFoot || !rightFoot) return null;
    const rest = restYaw(copy, hips);
    const mixer = new THREE.AnimationMixer(copy);
    mixer.clipAction(clip).play();
    const count = Math.max(2, Math.round(clip.duration * SAMPLE_RATE));
    const samples: MotionSample[] = [];
    let heading = 0, lastYaw = 0;
    for (let i = 0; i < count; i++) {
        mixer.setTime(Math.min(clip.duration, i / SAMPLE_RATE));
        copy.updateMatrixWorld(true);
        // Facing is the hips' heading from the bind pose's, followed round without wrapping.
        const yaw = yawOf(hips);
        heading = i === 0 ? wrapAngle(yaw - (rest ?? yaw)) : heading + wrapAngle(yaw - lastYaw);
        lastYaw = yaw;
        const at = point(hips);
        samples.push({ root: { x: at.x, y: 0, z: at.z }, facing: heading, hips: at, leftFoot: point(leftFoot), rightFoot: point(rightFoot) });
    }
    mixer.stopAllAction();
    mixer.uncacheRoot(copy);
    const first = samples[0].root, last = samples[samples.length - 1].root;
    if (Math.hypot(last.x - first.x, last.z - first.z) < IN_PLACE_TRAVEL) travelFromFeet(samples);
    // The root and facing follow the body's course, not the sway of each step.
    const half = Math.round(SMOOTHING * SAMPLE_RATE);
    const xs = smoothSeries(samples.map(sample => sample.root.x), loop, half);
    const zs = smoothSeries(samples.map(sample => sample.root.z), loop, half);
    const facings = smoothSeries(samples.map(sample => sample.facing), loop, half);
    samples.forEach((sample, i) => {
        sample.root = { x: xs[i], y: sample.root.y, z: zs[i] };
        sample.facing = facings[i];
    });
    return { name: clip.name, loop, samples };
};

/** Databases kept, the oldest let go first. */
const MAX_DATABASES = 32;
const databases = new Map<string, MotionDatabase | null>();

/**
 * What a database depends on in a model: its skin (copies of one model share their geometry, so they
 * share databases) and its own scale, the database's units. A model without a skin is its own.
 */
const rigKey = (model: THREE.Object3D): string => {
    let skin = '';
    model.traverse(node => { if (!skin && (node as THREE.SkinnedMesh).isSkinnedMesh) skin = (node as THREE.SkinnedMesh).geometry.uuid; });
    return `${skin || model.uuid}|${model.scale.x.toFixed(5)},${model.scale.y.toFixed(5)},${model.scale.z.toFixed(5)}`;
};

/**
 * The database for `clips` on `model`, built once per rig and clip list and shared by every character
 * made from the same model; null when none can be sampled. `sources` names the clips (by default
 * their ids): pass the model's own clips' ids when `clips` are a mixer's copies of them.
 */
export const motionDatabaseFor = (
    model: THREE.Object3D,
    clips: readonly THREE.AnimationClip[],
    sources: readonly string[] = clips.map(clip => clip.uuid),
): MotionDatabase | null => {
    const key = `${rigKey(model)}|${sources.join('|')}`;
    if (databases.has(key)) return databases.get(key) ?? null;
    const sampled = clips.map(clip => sampleClip(model, clip)).filter((entry): entry is MotionClipSamples => entry !== null);
    const database = sampled.length > 0 ? new MotionDatabase(sampled) : null;
    databases.set(key, database);
    if (databases.size > MAX_DATABASES) databases.delete(databases.keys().next().value as string);
    return database;
};
