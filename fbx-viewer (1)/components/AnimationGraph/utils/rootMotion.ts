import * as THREE from 'three';

/** Root travel of a clip: the clip to play with the travel removed, and the source track to sample it from. */
export interface RootMotion {
    /** The source clip with the root's horizontal position pinned to its first key; other tracks are shared, not copied. */
    clip: THREE.AnimationClip;
    /** The source clip's untouched root position track, in the root bone's parent space. */
    track: THREE.VectorKeyframeTrack;
    /** Length of one cycle in seconds (the source clip's duration). */
    duration: number;
}

export interface RootMotionOptions {
    /** Keep the root's vertical (Y) motion in the pose. Defaults to true; false pins Y to its first key as well. */
    keepVertical?: boolean;
    /** The model the clip plays on. When given, the matching bone highest in its hierarchy carries the motion. */
    root?: THREE.Object3D | null;
}

// Last name token of a bone that carries root motion, ranked by how high it usually sits in a rig.
const ROOT_TOKEN_RANK: Record<string, number> = { root: 0, hips: 1, hip: 1, pelvis: 1 };
// 3ds Max Biped puts the travel on "Bip01" / "Bip001", above "Bip01 Pelvis".
const BIPED_ROOT = /^bip\d+$/;
// A token before the name that marks a limb joint ("LeftHip", "L_Hip") rather than the pelvis.
const SIDE_TOKENS = new Set(['l', 'r', 'left', 'right', 'lft', 'rgt']);

type InterpolatedTrack = THREE.KeyframeTrack & {
    createInterpolant: ((result?: Float32Array) => THREE.Interpolant) & { isInterpolantFactoryMethodGLTFCubicSpline?: boolean };
};

/** Lower-case words of a node name's leaf, split on separators and camel case ("mixamorig:LeftUpLeg" -> left, up, leg). */
const nameTokens = (name: string): string[] => {
    const leaf = name.split(/[|:/]/).pop() || name;
    return leaf
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .map(token => token.toLowerCase());
};

/** Rank of a node name as a root motion carrier (lower sits higher in typical rigs), or -1 if it is not one. */
const rootNameRank = (name: string): number => {
    const tokens = nameTokens(name);
    const last = tokens[tokens.length - 1];
    if (!last) return -1;
    if (tokens.length > 1 && SIDE_TOKENS.has(tokens[tokens.length - 2])) return -1;
    if (BIPED_ROOT.test(last)) return 0;
    return ROOT_TOKEN_RANK[last] ?? -1;
};

/** Node a position track animates, or null for any other property or an unparseable name. */
const positionTrackNode = (track: THREE.KeyframeTrack): string | null => {
    try {
        const parsed = THREE.PropertyBinding.parseTrackName(track.name);
        if (parsed.propertyName !== 'position') return null;
        if (parsed.objectName === 'bones') return parsed.objectIndex || null;
        if (parsed.objectName) return null;
        return parsed.nodeName || null;
    } catch {
        return null;
    }
};

const isGltfCubicSpline = (track: THREE.KeyframeTrack): boolean =>
    (track as InterpolatedTrack).createInterpolant?.isInterpolantFactoryMethodGLTFCubicSpline === true;

/**
 * Floats per key and where the position sits inside them: glTF cubic splines store an in-tangent,
 * the value and an out-tangent per key. Null for anything that is not a 3D position track.
 */
const keyLayout = (track: THREE.KeyframeTrack): { stride: number; offset: number } | null => {
    if (track.ValueTypeName !== 'vector' || !track.times.length) return null;
    const stride = track.getValueSize();
    if (stride === 3) return { stride, offset: 0 };
    if (stride === 9 && isGltfCubicSpline(track)) return { stride, offset: 3 };
    return null;
};

/** Number of parents between `nodeName` and `root`, or Infinity when the node is not in the hierarchy. */
const hierarchyDepth = (root: THREE.Object3D, nodeName: string): number => {
    const node = THREE.PropertyBinding.findNode(root, nodeName) as THREE.Object3D | null;
    if (!node) return Infinity;
    let depth = 0;
    for (let current: THREE.Object3D | null = node; current && current !== root; current = current.parent) depth += 1;
    return depth;
};

/**
 * The position track of the clip's hips/root bone (mixamorig Hips, Hips, pelvis, root, Biped Bip01),
 * matched by name regardless of case, rig prefix or separators. When several bones match, the one
 * highest in `root`'s hierarchy wins; without a hierarchy a root bone beats hips/pelvis, then track order.
 */
export const findRootMotionTrack = (
    clip: THREE.AnimationClip,
    root?: THREE.Object3D | null,
): THREE.VectorKeyframeTrack | null => {
    let best: THREE.VectorKeyframeTrack | null = null;
    let bestDepth = Infinity;
    let bestRank = Infinity;
    for (const track of clip.tracks) {
        if (!keyLayout(track)) continue;
        const nodeName = positionTrackNode(track);
        if (!nodeName) continue;
        const rank = rootNameRank(nodeName);
        if (rank < 0) continue;
        const depth = root ? hierarchyDepth(root, nodeName) : 0;
        if (depth < bestDepth || (depth === bestDepth && rank < bestRank)) {
            best = track as THREE.VectorKeyframeTrack;
            bestDepth = depth;
            bestRank = rank;
        }
    }
    return best;
};

/** Copy of the root track with the given axes held at the first key's value (and their spline tangents flattened). */
const pinAxes = (track: THREE.VectorKeyframeTrack, axes: number[]): THREE.VectorKeyframeTrack => {
    const layout = keyLayout(track);
    const pinned = track.clone();
    if (!layout) return pinned;
    const { stride, offset } = layout;
    const values = pinned.values;
    const first = axes.map(axis => values[offset + axis]);
    for (let key = 0; key < values.length; key += stride) {
        for (let part = 0; part < stride; part += 3) {
            axes.forEach((axis, index) => {
                values[key + part + axis] = part === offset ? first[index] : 0;
            });
        }
    }
    return pinned;
};

const buildRootMotion = (clip: THREE.AnimationClip, keepVertical: boolean, root?: THREE.Object3D | null): RootMotion | null => {
    const duration = clip.duration;
    if (!Number.isFinite(duration) || duration <= 0) return null;
    const track = findRootMotionTrack(clip, root);
    if (!track) return null;
    const pinned = pinAxes(track, keepVertical ? [0, 2] : [0, 1, 2]);
    const tracks = clip.tracks.map(candidate => (candidate === track ? pinned : candidate));
    return { clip: new THREE.AnimationClip(clip.name, duration, tracks, clip.blendMode), track, duration };
};

const motionCache = new WeakMap<THREE.AnimationClip, Map<string, RootMotion | null>>();

/**
 * Splits a clip's root travel from its pose: the returned clip holds the root bone's X/Z at the first
 * key for every key (Y stays animated unless `keepVertical` is false), and `track` keeps the source
 * travel for `rootMotionDelta`. Null when the clip has no hips/root position track or no duration.
 * Results are cached per clip and options, so repeated calls return the same object.
 */
export const extractRootMotion = (clip: THREE.AnimationClip, options: RootMotionOptions = {}): RootMotion | null => {
    const keepVertical = options.keepVertical !== false;
    const key = `${keepVertical ? 'vertical' : 'flat'}|${options.root?.uuid ?? ''}`;
    let entries = motionCache.get(clip);
    if (!entries) {
        entries = new Map();
        motionCache.set(clip, entries);
    }
    const cached = entries.get(key);
    if (cached !== undefined) return cached;
    const motion = buildRootMotion(clip, keepVertical, options.root);
    entries.set(key, motion);
    return motion;
};

const samplers = new WeakMap<THREE.KeyframeTrack, THREE.Interpolant>();
const fromPosition = new THREE.Vector3();
const cycleStart = new THREE.Vector3();
const cycleEnd = new THREE.Vector3();

/** The root track's value at `time`, with the track's own interpolation (clamped to its first and last keys). */
const sampleRoot = (track: THREE.VectorKeyframeTrack, time: number, target: THREE.Vector3): THREE.Vector3 => {
    let sampler = samplers.get(track);
    if (!sampler) {
        sampler = (track as InterpolatedTrack).createInterpolant();
        samplers.set(track, sampler);
    }
    const value = sampler.evaluate(time);
    return target.set(value[0], value[1], value[2]);
};

/** Root position at `time` along the unrolled loop: each whole cycle adds the full-cycle travel. */
const travelAt = (motion: RootMotion, time: number, looped: boolean, target: THREE.Vector3): THREE.Vector3 => {
    const { duration, track } = motion;
    if (!looped) return sampleRoot(track, THREE.MathUtils.clamp(time, 0, duration), target);
    const cycles = Math.floor(time / duration);
    sampleRoot(track, time - cycles * duration, target);
    if (cycles === 0) return target;
    sampleRoot(track, 0, cycleStart);
    sampleRoot(track, duration, cycleEnd);
    return target.addScaledVector(cycleEnd.sub(cycleStart), cycles);
};

/**
 * Horizontal root travel (X/Z, Y = 0) in the root bone's parent space between two clip times, for
 * forward or reverse playback. Unlooped times clamp to the clip. When looped and both times lie in
 * one cycle (as `AnimationAction.time` does), the shorter way around the loop is taken, so a wrap
 * adds the rest of the cycle plus the start of the next (or the reverse when playing backwards);
 * times outside [0, duration] are read as unwrapped, adding the full-cycle travel per cycle crossed.
 */
export const rootMotionDelta = (
    motion: RootMotion,
    previousTime: number,
    time: number,
    looped: boolean,
    out: THREE.Vector3 = new THREE.Vector3(),
): THREE.Vector3 => {
    const duration = motion.duration;
    if (!Number.isFinite(previousTime) || !Number.isFinite(time) || !Number.isFinite(duration) || duration <= 0) {
        return out.set(0, 0, 0);
    }
    let to = time;
    if (looped && previousTime >= 0 && previousTime <= duration && time >= 0 && time <= duration) {
        const span = time - previousTime;
        if (span <= -duration / 2) to += duration;
        else if (span > duration / 2) to -= duration;
    }
    travelAt(motion, previousTime, looped, fromPosition);
    travelAt(motion, to, looped, out);
    return out.set(out.x - fromPosition.x, 0, out.z - fromPosition.z);
};
