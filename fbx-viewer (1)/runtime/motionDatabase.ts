import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { findBone } from './ik';
import { MotionDatabase, SAMPLE_RATE, type MotionClipSamples, type MotionSample } from './motionMatching';
import { clipLoops, copyClipRange } from '../utils/clipRanges';
import { bindPoseRig, mirroredClipName } from '../utils/animationBinding';
import { mirrorHumanoidClip } from '../utils/retargeting';

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

/** A foot within this share of the hips' height of its lowest point may be planted... */
const PLANTED_HEIGHT = 0.06;
/** ...if it moves slower than this many hips heights a second over the ground. */
const PLANTED_SPEED = 0.3;
/** Contacts are the majority over this many samples, so one stray sample does not flicker a foot up or down. */
const CONTACT_FILTER = 5;

/**
 * Marks when each foot is planted (`contacts`): near its lowest and nearly still over the ground, with
 * lone samples either way voted away by their neighbours. A looping clip's ends see each other.
 */
export const footContacts = (samples: MotionSample[], loop: boolean): void => {
    const n = samples.length;
    if (!n) return;
    const body = Math.max(1e-3, samples.reduce((sum, sample) => sum + sample.hips.y, 0) / n
        - Math.min(...samples.map(sample => Math.min(sample.leftFoot.y, sample.rightFoot.y))));
    const at = (i: number) => samples[loop ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i))];
    const planted = (['leftFoot', 'rightFoot'] as const).map((foot) => {
        const lowest = Math.min(...samples.map(sample => sample[foot].y));
        return samples.map((sample, i) => {
            const before = at(i - 1)[foot], after = at(i + 1)[foot];
            // Across a loop's seam the neighbours are a lap apart: the step there is not known, so it counts as still.
            const span = (loop || (i > 0 && i < n - 1)) ? 2 : 1;
            let speed = Math.hypot(after.x - before.x, after.z - before.z) * SAMPLE_RATE / span;
            if (loop && (i === 0 || i === n - 1)) speed = 0;
            return sample[foot].y <= lowest + PLANTED_HEIGHT * body && speed <= PLANTED_SPEED * body;
        });
    });
    const half = Math.floor(CONTACT_FILTER / 2);
    const vote = (flags: boolean[], i: number): boolean => {
        let down = 0;
        for (let k = -half; k <= half; k++) {
            const j = loop ? (((i + k) % n) + n) % n : Math.max(0, Math.min(n - 1, i + k));
            if (flags[j]) down++;
        }
        return down * 2 > CONTACT_FILTER;
    };
    samples.forEach((sample, i) => { sample.contacts = [vote(planted[0], i), vote(planted[1], i)]; });
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
        // A series that does not loop is averaged over a window that shrinks evenly toward its ends, so a
        // steady change (a clip setting off or stopping) keeps its pace there instead of stalling.
        const reach = loop ? half : Math.min(half, i, n - 1 - i);
        let sum = 0;
        for (let j = i - reach; j <= i + reach; j++) sum += at(j);
        return sum / (2 * reach + 1);
    });
};

/**
 * The heading of the bone named `name` in the model's bind pose (facing 0), or null without a skinned
 * mesh to pose. Posed on a copy of its own: putting a skeleton in its bind pose rewrites bones from the
 * skin's bind matrices, which on a model placed at a different size can leave the bones no clip moves
 * (the legs' lengths, say) out of place for sampling.
 */
const restYaw = (model: THREE.Object3D, name: string): number | null => {
    const copy = cloneSkinned(model);
    copy.position.set(0, 0, 0);
    copy.quaternion.identity();
    const skinned: THREE.SkinnedMesh[] = [];
    copy.traverse(node => { if ((node as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(node as THREE.SkinnedMesh); });
    const bone = findBone(copy, name);
    if (!skinned.length || !bone) return null;
    skinned[0].skeleton.pose();
    copy.updateMatrixWorld(true);
    return yawOf(bone);
};

const wrapAngle = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

/** A clip's ends differing by less than this share of the hips' height in the feet's places... */
const LOOP_POSE_GAP = 0.25;
/** ...and by less than this many hips heights a second in speed, plus this share of the faster end's speed... */
const LOOP_SPEED_GAP = 0.3;
const LOOP_SPEED_SHARE = 0.25;
/** ...and turning less than this over the clip (radians), its end flows back into its start. */
const LOOP_TURN = Math.PI / 4;

/** A point seen from a character at `root` facing `facing` (forward +z), as motion matching describes clips. */
const fromCharacter = (point: { x: number; y: number; z: number }, root: { x: number; y: number; z: number }, facing: number) => {
    const dx = point.x - root.x, dz = point.z - root.z;
    const c = Math.cos(facing), s = Math.sin(facing);
    return { x: dx * c - dz * s, y: point.y - root.y, z: dx * s + dz * c };
};

/**
 * Whether a sampled clip loops, for one its import does not say: its end (`end`, the pose at its very
 * last moment, else its last sample) flows back into its first moment, with the feet in the same places
 * under the body, the same speed, and no turn round. A start (standing to walking), a stop, a turn of
 * 180 degrees or a landing plays once.
 */
export const looksLooping = (samples: readonly MotionSample[], end: MotionSample = samples[samples.length - 1]): boolean => {
    const n = samples.length;
    if (n < 4) return true;
    const ground = Math.min(...samples.map(sample => Math.min(sample.leftFoot.y, sample.rightFoot.y)));
    const body = Math.max(1e-3, samples.reduce((sum, sample) => sum + sample.hips.y, 0) / n - ground);
    // The pose at the clip's very end, which a loop brings back to its first.
    const first = samples[0], last = end;
    let gap = 0;
    for (const foot of ['leftFoot', 'rightFoot'] as const) {
        const a = fromCharacter(first[foot], first.hips, first.facing);
        const b = fromCharacter(last[foot], last.hips, last.facing);
        gap = Math.max(gap, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
    }
    gap = Math.max(gap, Math.abs((first.hips.y - ground) - (last.hips.y - ground)));
    // Speed over the first and the last quarter, so the sway within a stride evens out.
    const span = Math.max(3, Math.floor((n - 1) / 4));
    const speed = (from: number, to: number) => Math.hypot(samples[to].root.x - samples[from].root.x, samples[to].root.z - samples[from].root.z) * SAMPLE_RATE / (to - from);
    const startSpeed = speed(0, span), endSpeed = speed(n - 1 - span, n - 1);
    const speedGap = Math.abs(startSpeed - endSpeed);
    const turn = Math.abs(last.facing - first.facing);
    return gap < LOOP_POSE_GAP * body
        && speedGap < LOOP_SPEED_GAP * body + LOOP_SPEED_SHARE * Math.max(startSpeed, endSpeed)
        && turn < LOOP_TURN;
};

/**
 * A clip sampled for matching on a copy of `model`, or null when the model has no hips and feet to read.
 * `loop` says whether it loops; left out, that is read from the clip itself (looksLooping).
 */
export const sampleClip = (model: THREE.Object3D, clip: THREE.AnimationClip, loopAsSaid?: boolean): MotionClipSamples | null => {
    const copy = cloneSkinned(model);
    copy.position.set(0, 0, 0);
    copy.quaternion.identity();
    const hips = findBone(copy, 'Hips');
    const leftFoot = findBone(copy, 'LeftFoot');
    const rightFoot = findBone(copy, 'RightFoot');
    if (!hips || !leftFoot || !rightFoot) return null;
    // The way the character faces is the chest's: in a strafe the hips swing toward the travel while
    // the chest keeps facing ahead.
    const chest = findBone(copy, 'Spine2') ?? findBone(copy, 'Spine1') ?? findBone(copy, 'Spine') ?? hips;
    const rest = restYaw(model, chest.name);
    const mixer = new THREE.AnimationMixer(copy);
    mixer.clipAction(clip).play();
    const count = Math.max(2, Math.round(clip.duration * SAMPLE_RATE));
    const samples: MotionSample[] = [];
    let heading = 0, lastYaw = 0;
    for (let i = 0; i < count; i++) {
        mixer.setTime(Math.min(clip.duration, i / SAMPLE_RATE));
        copy.updateMatrixWorld(true);
        // Facing is the chest's heading from the bind pose's, followed round without wrapping.
        const yaw = yawOf(chest);
        heading = i === 0 ? wrapAngle(yaw - (rest ?? yaw)) : heading + wrapAngle(yaw - lastYaw);
        lastYaw = yaw;
        const at = point(hips);
        samples.push({ root: { x: at.x, y: 0, z: at.z }, facing: heading, hips: at, leftFoot: point(leftFoot), rightFoot: point(rightFoot) });
    }
    // The pose at the clip's very end (the samples stop a frame short of it), to tell whether it loops;
    // read a hair before it, as the clip repeats and its full length is its start again.
    mixer.setTime(Math.max(0, clip.duration - 1e-4));
    copy.updateMatrixWorld(true);
    const endYaw = yawOf(chest);
    const endHips = point(hips);
    const end: MotionSample = { root: { x: endHips.x, y: 0, z: endHips.z }, facing: heading + wrapAngle(endYaw - lastYaw), hips: endHips, leftFoot: point(leftFoot), rightFoot: point(rightFoot) };
    mixer.stopAllAction();
    mixer.uncacheRoot(copy);
    const first = samples[0].root, last = samples[samples.length - 1].root;
    if (Math.hypot(last.x - first.x, last.z - first.z) < IN_PLACE_TRAVEL) travelFromFeet(samples);
    const loop = loopAsSaid ?? looksLooping(samples, end);
    footContacts(samples, loop);
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
    const sampled = clips.map(clip => sampleClip(model, clip, clipLoops(clip))).filter((entry): entry is MotionClipSamples => entry !== null);
    const database = sampled.length > 0 ? new MotionDatabase(sampled) : null;
    databases.set(key, database);
    if (databases.size > MAX_DATABASES) databases.delete(databases.keys().next().value as string);
    return database;
};

/** A database built in the background, and the mirrored copies of its clips it was built with. */
export interface BuiltMotionDatabase {
    database: MotionDatabase | null;
    /** Each clip's mirrored copy (left and right swapped), named by mirroredClipName: the player plays one when matching picks it. */
    mirrored: THREE.AnimationClip[];
}

/** Lets the browser draw a frame before the next piece of work. */
const nextSlice = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0); });

const builds = new Map<string, { result: BuiltMotionDatabase | null }>();

/**
 * The database for `clips` on `model`, with a mirrored copy of every clip when `mirror` is set (a turn
 * or a step one way then covers the other way too). It is built a clip at a time between frames, so a
 * character does not hitch the first time it matches: null until it is ready, then the same result
 * for every character made from the same model (see motionDatabaseFor for `sources`).
 */
export const motionDatabaseWhenReady = (
    model: THREE.Object3D,
    clips: readonly THREE.AnimationClip[],
    sources: readonly string[] = clips.map(clip => clip.uuid),
    mirror = true,
): BuiltMotionDatabase | null => {
    const key = `${rigKey(model)}|${mirror ? 'mirrored' : 'as-is'}|${sources.join('|')}`;
    const known = builds.get(key);
    if (known) return known.result;
    const entry: { result: BuiltMotionDatabase | null } = { result: null };
    builds.set(key, entry);
    if (builds.size > MAX_DATABASES) builds.delete(builds.keys().next().value as string);
    const own = [...clips];
    void (async () => {
        const mirrored: THREE.AnimationClip[] = [];
        if (mirror) {
            await nextSlice();
            const rig = bindPoseRig(model);
            for (const clip of rig ? own : []) {
                await nextSlice();
                try {
                    const copy = mirrorHumanoidClip(rig!, clip, mirroredClipName(clip.name));
                    copyClipRange(clip, copy);
                    mirrored.push(copy);
                } catch {
                    // A clip that cannot be mirrored is matched as it is.
                }
            }
        }
        const sampled: MotionClipSamples[] = [];
        for (const clip of [...own, ...mirrored]) {
            await nextSlice();
            const samples = sampleClip(model, clip, clipLoops(clip));
            if (samples) sampled.push(samples);
        }
        await nextSlice();
        entry.result = { database: sampled.length > 0 ? new MotionDatabase(sampled) : null, mirrored };
    })().catch(() => {
        entry.result = { database: null, mirrored: [] };
    });
    return null;
};
