import * as THREE from 'three';
import { boneKey } from './boneMask';

/**
 * GROUND SPEED OF A CLIP
 *
 * How fast a locomotion clip carries a character over the ground, read from its feet: a planted
 * foot stays put while the body passes over it, so the planted foot's speed relative to the body is
 * the clip's ground speed, whether the clip walks in place (the foot slides back under a still body)
 * or travels (the body moves on past a still foot). A state set to match ground speed plays its
 * clips at the rate that makes that speed the character's own, so planted feet do not slide.
 */

/** Poses sampled per second of clip. */
const SAMPLES_PER_SECOND = 30;
/** A foot counts as planted within this share of its height range above its lowest point. */
const PLANTED_SHARE = 0.15;
/** The slowest and fastest a clip is played to match the ground speed. */
export const MIN_GROUND_SPEED_RATE = 0.5;
export const MAX_GROUND_SPEED_RATE = 2;

/** Feet read most precisely by the toes, else by the ankles. */
const FOOT_PAIRS = [['lefttoebase', 'righttoebase'], ['lefttoe', 'righttoe'], ['leftfoot', 'rightfoot']];
const HIPS_KEYS = ['hips', 'pelvis', 'root'];

const speedCache = new WeakMap<THREE.AnimationClip, Map<string, number>>();

const findByKey = (root: THREE.Object3D, keys: readonly string[]): THREE.Object3D | null => {
    for (const key of keys) {
        let found: THREE.Object3D | null = null;
        root.traverse((node) => {
            if (!found && (node as THREE.Bone).isBone && boneKey(node.name) === key) found = node;
        });
        if (found) return found;
    }
    return null;
};

/** The model's bones alone (no meshes or attachments), placed under a root as the model places them. */
const boneRig = (model: THREE.Object3D): { root: THREE.Object3D; hips: THREE.Object3D } | null => {
    const hips = findByKey(model, HIPS_KEYS);
    if (!hips) return null;
    const copyBones = (bone: THREE.Object3D): THREE.Object3D => {
        const copy = bone.clone(false);
        bone.children.forEach((child) => {
            if ((child as THREE.Bone).isBone) copy.add(copyBones(child));
        });
        return copy;
    };
    const root = new THREE.Group();
    const frame = new THREE.Object3D();
    model.updateMatrixWorld(true);
    if (hips.parent) {
        new THREE.Matrix4().copy(model.matrixWorld).invert().multiply(hips.parent.matrixWorld)
            .decompose(frame.position, frame.quaternion, frame.scale);
    }
    const hipsCopy = copyBones(hips);
    frame.add(hipsCopy);
    root.add(frame);
    return { root, hips: hipsCopy };
};

/**
 * The ground speed `clip` carries `model` at, in the model's own units per second (its own
 * transform left out); 0 when the rig has no hips or feet, or the clip does not move.
 */
export const clipGroundSpeed = (model: THREE.Object3D, clip: THREE.AnimationClip): number => {
    let byModel = speedCache.get(clip);
    if (!byModel) {
        byModel = new Map();
        speedCache.set(clip, byModel);
    }
    const cached = byModel.get(model.uuid);
    if (cached !== undefined) return cached;

    let speed = 0;
    const rig = boneRig(model);
    const feet = rig ? FOOT_PAIRS.map(pair => pair.map(key => findByKey(rig.root, [key]))).find(pair => pair.every(Boolean)) as THREE.Object3D[] | undefined : undefined;
    if (rig && feet && clip.duration > 0) {
        const mixer = new THREE.AnimationMixer(rig.root);
        try {
            mixer.clipAction(clip).play();
            const steps = Math.max(8, Math.ceil(clip.duration * SAMPLES_PER_SECOND));
            const poses: { hips: THREE.Vector3; feet: THREE.Vector3[] }[] = [];
            for (let step = 0; step <= steps; step++) {
                mixer.setTime((clip.duration * step) / steps);
                rig.root.updateMatrixWorld(true);
                poses.push({
                    hips: rig.hips.getWorldPosition(new THREE.Vector3()),
                    feet: feet.map(foot => foot.getWorldPosition(new THREE.Vector3())),
                });
            }
            const lowest = [0, 1].map(side => Math.min(...poses.map(pose => pose.feet[side].y)));
            const highest = [0, 1].map(side => Math.max(...poses.map(pose => pose.feet[side].y)));
            const dt = clip.duration / steps;
            const speeds: number[] = [];
            for (let step = 1; step < poses.length; step++) {
                const pose = poses[step];
                const before = poses[step - 1];
                const side = pose.feet[0].y <= pose.feet[1].y ? 0 : 1;
                if (pose.feet[side].y > lowest[side] + (highest[side] - lowest[side]) * PLANTED_SHARE) continue;
                // The planted foot's travel against the body's, on the ground.
                const dx = (pose.feet[side].x - before.feet[side].x) - (pose.hips.x - before.hips.x);
                const dz = (pose.feet[side].z - before.feet[side].z) - (pose.hips.z - before.hips.z);
                speeds.push(Math.hypot(dx, dz) / dt);
            }
            if (speeds.length) {
                speeds.sort((a, b) => a - b);
                speed = speeds[Math.floor(speeds.length / 2)];
            }
        } finally {
            mixer.stopAllAction();
            mixer.uncacheRoot(rig.root);
        }
    }
    byModel.set(model.uuid, speed);
    return speed;
};

/**
 * The play rate at which clips weighted `weights` (by clip name), whose ground speeds `speedOf`
 * gives (in the same units as `groundSpeed`), carry the character at `groundSpeed`; kept within
 * MIN_GROUND_SPEED_RATE..MAX_GROUND_SPEED_RATE, and 1 when the clips do not move.
 */
export const groundSpeedRate = (
    groundSpeed: number,
    weights: Record<string, number>,
    speedOf: (clipName: string) => number,
): number => {
    let total = 0;
    let natural = 0;
    for (const [name, weight] of Object.entries(weights)) {
        if (!(weight > 0)) continue;
        total += weight;
        natural += weight * speedOf(name);
    }
    if (!(total > 0) || !(natural / total > 1e-6) || !Number.isFinite(groundSpeed)) return 1;
    return THREE.MathUtils.clamp(groundSpeed / (natural / total), MIN_GROUND_SPEED_RATE, MAX_GROUND_SPEED_RATE);
};
