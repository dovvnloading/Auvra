import * as THREE from 'three';
import { boneKey, boneNamesUnder, findBone, maskClip, trackNodeName } from './boneMask';

/** Default fade-in of a montage, and of the crossfade from the montage it interrupts, in seconds. */
export const DEFAULT_MONTAGE_BLEND_IN = 0.15;

/** Default fade-out of a montage in seconds; a one-shot's fade-out ends exactly at the clip end. */
export const DEFAULT_MONTAGE_BLEND_OUT = 0.2;

/**
 * The mixer averages the actions on each property by weight, so a montage of weight w over base
 * actions weighing 1 in total shows w / (1 + w) of its pose. Taking a share s of the pose needs
 * w = s / (1 - s); this is the least share left to the base pose, which keeps w finite.
 */
const MIN_BASE_SHARE = 1e-4;

const _poseAbove = new THREE.Quaternion();
const _clipAbove = new THREE.Quaternion();
const _clipRotation = new THREE.Quaternion();
const _turn = new THREE.Quaternion();

/** Options for {@link MontagePlayer.play}. */
export interface MontageOptions {
    /** Fade-in, and crossfade from an interrupted montage, in seconds (default 0.15). */
    blendIn?: number;
    /** Fade-out in seconds (default 0.2); a one-shot's fade-out ends exactly at the clip end. */
    blendOut?: number;
    /** Playback rate (default 1); negative plays backwards from the end, 0 holds until stopped. */
    rate?: number;
    /** Only this bone and its descendants are affected; the whole body when omitted. */
    maskBone?: string;
    /** Repeat until stopped or interrupted instead of playing once. */
    loop?: boolean;
    /**
     * Add the clip's motion (relative to its first frame) on top of the pose instead of replacing
     * it: a flinch over a run keeps the legs running. Additive montages interrupt only each other.
     */
    additive?: boolean;
    /**
     * Keep the mask bone turned as the clip turns it relative to the character, not relative to the
     * bones above it (a mesh-space rotation blend): an aim held over a strafe still points where the
     * aim clip points, whatever the legs' clip does with the hips. Needs a mask bone; not additive.
     */
    meshSpaceRotation?: boolean;
    /**
     * Called once when the montage no longer affects the pose and its actions are gone, with
     * `interrupted` true when stop() or another play() ended it before the clip finished.
     */
    onEnd?: (interrupted: boolean) => void;
}

/** Tracks played by the same set of montages. */
interface PartPlan {
    tracks: string[];
    /** The other montages that play these tracks too. */
    overlaps: MontageLayer[];
}

/** One mixer action playing part of a montage's tracks. */
interface MontagePart extends PartPlan {
    action: THREE.AnimationAction;
    clip: THREE.AnimationClip;
}

/** A mesh-space montage's mask bone and the nodes above it, top first, with the clip's rotation of each it animates. */
interface MeshSpaceRoot {
    bone: THREE.Object3D;
    above: { node: THREE.Object3D; rotation: THREE.Interpolant | null }[];
}

interface MontageLayer {
    /** The clip as played, masked when a mask bone was given. */
    clip: THREE.AnimationClip;
    /** Set for a mesh-space montage (MontageOptions.meshSpaceRotation). */
    meshSpace: MeshSpaceRoot | null;
    tracks: Set<string>;
    parts: MontagePart[];
    blendIn: number;
    blendOut: number;
    rate: number;
    loop: boolean;
    additive: boolean;
    onEnd?: (interrupted: boolean) => void;
    /** Fade-in progress, 0 to 1. */
    rise: number;
    /** Ceiling while fading out after stop() or an interruption; 1 until then. */
    release: number;
    /** How fast `release` falls, per second. */
    releaseRate: number;
    interrupted: boolean;
    /** Share of the pose this montage takes on its tracks, 0 to 1. */
    weight: number;
}

const seconds = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;

/** The share a one-shot's fade-out allows at clip `time`, reaching 0 exactly at the clip end. */
const endShare = (layer: MontageLayer, time: number): number => {
    if (layer.loop || layer.rate === 0) return 1;
    const left = layer.rate > 0 ? layer.clip.duration - time : time;
    if (left <= 0) return 0;
    return layer.blendOut > 0 ? Math.min(1, left / Math.abs(layer.rate) / layer.blendOut) : 1;
};

/** Splits `plan` by whether `other` plays its tracks too; the shared tracks list `other` as an overlap. */
const splitByLayer = (plan: PartPlan, other: MontageLayer): PartPlan[] => {
    const shared = plan.tracks.filter(name => other.tracks.has(name));
    if (!shared.length) return [plan];
    const overlaps = [...plan.overlaps, other];
    if (shared.length === plan.tracks.length) return [{ tracks: plan.tracks, overlaps }];
    return [
        { tracks: shared, overlaps },
        { tracks: plan.tracks.filter(name => !other.tracks.has(name)), overlaps: plan.overlaps },
    ];
};

/**
 * The action weight that gives `layer` its share of the pose on `part`'s tracks, alongside the
 * other montages playing them and base actions weighing 1. Additive clips use the share as is.
 */
const mixerWeight = (layer: MontageLayer, part: MontagePart): number => {
    if (layer.weight <= 0) return 0;
    const mode = layer.clip.blendMode;
    if (mode === THREE.AdditiveAnimationBlendMode) return layer.weight;
    const shared = part.overlaps.reduce(
        (total, other) => (other.clip.blendMode === mode ? total + other.weight : total),
        layer.weight
    );
    return layer.weight / Math.max(1 - shared, MIN_BASE_SHARE);
};

/**
 * Plays one-shot or looping clips layered over a mixer's base actions, on the whole body or on one
 * bone's subtree. Call update(delta) every frame before mixer.update(delta), with the same delta:
 * it only sets weights. The base actions' weights are taken to sum to 1, as the graph animator
 * keeps them, so a montage at full weight replaces the base pose on the tracks it plays.
 */
export class MontagePlayer {
    private readonly mixer: THREE.AnimationMixer;
    private readonly root: THREE.Object3D;
    private layers: MontageLayer[] = [];
    private current: MontageLayer | null = null;
    private maskedClips = new WeakMap<THREE.AnimationClip, Map<string, THREE.AnimationClip>>();
    private additiveClips = new WeakMap<THREE.AnimationClip, THREE.AnimationClip>();

    /** `root` is where mask bones are looked up; actions bind to the mixer's root, like the base actions. */
    constructor(mixer: THREE.AnimationMixer, root: THREE.Object3D) {
        this.mixer = mixer;
        this.root = root;
    }

    /**
     * Plays `clip` once (or looping) over the base pose, fading in over `blendIn`. Montages of the
     * same kind (additive or not) still playing or fading out crossfade out over the same time and
     * end as interrupted. A mask bone that matches nothing leaves the pose untouched, though the
     * montage still runs and ends.
     */
    play(clip: THREE.AnimationClip, options: MontageOptions = {}): void {
        const blendIn = seconds(options.blendIn, DEFAULT_MONTAGE_BLEND_IN);
        const additive = !!options.additive;
        this.layers.filter(layer => layer.additive === additive).forEach(layer => this.fadeOut(layer, blendIn));

        const played = additive ? this.additiveClip(clip) : clip;
        const source = options.maskBone ? this.maskedClip(played, options.maskBone) : played;
        const rate = typeof options.rate === 'number' && Number.isFinite(options.rate) ? options.rate : 1;
        const layer: MontageLayer = {
            clip: source,
            meshSpace: options.meshSpaceRotation && options.maskBone && !additive ? this.meshSpaceRoot(clip, options.maskBone) : null,
            tracks: new Set(source.tracks.map(track => track.name)),
            parts: [],
            blendIn,
            blendOut: seconds(options.blendOut, DEFAULT_MONTAGE_BLEND_OUT),
            rate,
            loop: !!options.loop && source.duration > 0,
            additive,
            onEnd: options.onEnd,
            rise: blendIn > 0 ? 0 : 1,
            release: 1,
            releaseRate: 0,
            interrupted: false,
            weight: 0,
        };
        const start = rate < 0 ? source.duration : 0;
        layer.weight = Math.min(layer.rise, endShare(layer, start));

        // Each action covers tracks played by the same set of montages, so every track gets
        // exactly its share while montages with different masks crossfade.
        const fading = this.layers.filter(other => other.release > 0);
        let plans: PartPlan[] = [{ tracks: [...layer.tracks], overlaps: [] }];
        fading.forEach((other) => {
            plans = plans.flatMap(plan => splitByLayer(plan, other));
        });
        layer.parts = plans.map(plan => this.createPart(layer, plan, start));
        fading.forEach(other => this.splitLayer(other, layer));

        this.layers.push(layer);
        if (!additive) this.current = layer;
        this.applyWeights();
    }

    /** Fades every montage out over `blendOut` (default: each montage's own) and ends them as interrupted. */
    stop(blendOut?: number): void {
        this.layers.forEach(layer => this.fadeOut(layer, seconds(blendOut, layer.blendOut)));
        this.current = null;
        this.applyWeights();
    }

    /**
     * True from play() until that montage finishes or is stopped; a stopped one may still be fading
     * out. Additive montages play alongside and do not count.
     */
    isPlaying(): boolean {
        return this.current !== null;
    }

    /** Share of the pose the playing montage takes on its tracks, 0 to 1; 0 when none is playing. */
    weight(): number {
        return this.current ? this.current.weight : 0;
    }

    /**
     * Steps the fades by `delta` seconds (scaled by the mixer's timeScale) and sets the montage
     * weights for the coming mixer.update(delta); it never updates the mixer. Montages that are
     * done are removed first and their onEnd callbacks run last, so a callback may call play().
     */
    update(delta: number): void {
        if (!this.layers.length) return;
        const step = Number.isFinite(delta) && delta > 0 ? delta * this.mixer.timeScale : 0;
        const dt = Math.abs(step);
        const finished: MontageLayer[] = [];

        this.layers.forEach((layer) => {
            layer.rise = layer.blendIn > 0 ? Math.min(1, layer.rise + dt / layer.blendIn) : 1;
            if (layer.releaseRate > 0) layer.release = Math.max(0, layer.release - layer.releaseRate * dt);
            // The mixer advances an action's time before sampling it, so weigh the coming time.
            const time = THREE.MathUtils.clamp(
                layer.parts[0].action.time + step * layer.rate,
                0,
                layer.clip.duration
            );
            const end = endShare(layer, time);
            layer.weight = Math.min(layer.rise, layer.release, end);
            if (end <= 0 || layer.release <= 0) finished.push(layer);
        });

        if (finished.length) {
            const done = new Set(finished);
            this.layers = this.layers.filter(layer => !done.has(layer));
            if (this.current && done.has(this.current)) this.current = null;
            finished.forEach((layer) => {
                layer.weight = 0;
                layer.parts.forEach(part => this.removePart(part));
                layer.parts = [];
            });
            this.layers.forEach(layer => layer.parts.forEach((part) => {
                part.overlaps = part.overlaps.filter(other => !done.has(other));
            }));
        }

        this.applyWeights();
        finished.forEach(layer => layer.onEnd?.(layer.interrupted));
    }

    /**
     * Turns the mask bone of each mesh-space montage by its share of the pose, so it keeps the
     * clip's rotation relative to the character. Call right after mixer.update(): it corrects the
     * pose the mixer just wrote, whose bones above the mask bone are the base pose's.
     */
    applyMeshSpaceRotation(): void {
        this.layers.forEach((layer) => {
            const space = layer.meshSpace;
            if (!space || layer.weight <= 0 || !layer.parts.length) return;
            const time = layer.parts[0].action.time;
            _poseAbove.identity();
            _clipAbove.identity();
            space.above.forEach(({ node, rotation }) => {
                _poseAbove.multiply(node.quaternion);
                _clipAbove.multiply(rotation ? _clipRotation.fromArray(rotation.evaluate(time) as unknown as number[]) : node.quaternion);
            });
            // From the frame the pose puts above the bone to the one the clip puts there.
            _turn.copy(_poseAbove).invert().multiply(_clipAbove);
            space.bone.quaternion.premultiply(_clipRotation.identity().slerp(_turn, layer.weight));
        });
    }

    /** Removes every montage action at once, without fading or calling onEnd, and drops the masked clips. */
    dispose(): void {
        this.layers.forEach(layer => layer.parts.forEach(part => this.removePart(part)));
        this.layers = [];
        this.current = null;
        this.maskedClips = new WeakMap();
        this.additiveClips = new WeakMap();
    }

    /** The mask bone and the nodes between it and the root, with `clip`'s rotation track for each; null when the bone is not under the root. */
    private meshSpaceRoot(clip: THREE.AnimationClip, maskBone: string): MeshSpaceRoot | null {
        const bone = findBone(this.root, maskBone);
        if (!bone) return null;
        const rotations = new Map<string, THREE.KeyframeTrack>();
        clip.tracks.forEach((track) => {
            const node = trackNodeName(track);
            if (node && track.name.endsWith('.quaternion')) rotations.set(boneKey(node), track);
        });
        const above: MeshSpaceRoot['above'] = [];
        let node = bone.parent;
        for (; node && node !== this.root; node = node.parent) {
            const track = rotations.get(boneKey(node.name));
            above.unshift({ node, rotation: track ? new THREE.QuaternionLinearInterpolant(track.times, track.values, 4, new Float32Array(4)) : null });
        }
        return node === this.root ? { bone, above } : null;
    }

    /** The clip as motion relative to its first frame, which adds to the pose under it; built once per clip. */
    private additiveClip(clip: THREE.AnimationClip): THREE.AnimationClip {
        if (clip.blendMode === THREE.AdditiveAnimationBlendMode) return clip;
        let additive = this.additiveClips.get(clip);
        if (!additive) {
            additive = THREE.AnimationUtils.makeClipAdditive(clip.clone());
            this.additiveClips.set(clip, additive);
        }
        return additive;
    }

    /** The clip limited to the mask bone's subtree, built once per (clip, mask bone). */
    private maskedClip(clip: THREE.AnimationClip, maskBone: string): THREE.AnimationClip {
        let byBone = this.maskedClips.get(clip);
        if (!byBone) {
            byBone = new Map();
            this.maskedClips.set(clip, byBone);
        }
        let masked = byBone.get(maskBone);
        if (!masked) {
            masked = maskClip(clip, boneNamesUnder(this.root, maskBone));
            byBone.set(maskBone, masked);
        }
        return masked;
    }

    /** Starts the fade-out, reaching zero within `duration` and never slower than one under way. */
    private fadeOut(layer: MontageLayer, duration: number): void {
        layer.interrupted = true;
        const from = layer.weight;
        if (duration > 0 && from > 0) {
            layer.release = from;
            layer.releaseRate = Math.max(layer.releaseRate, from / duration);
        } else {
            layer.release = 0;
            layer.releaseRate = 0;
        }
        layer.weight = Math.min(layer.weight, layer.release);
    }

    /** Splits `layer`'s actions by whether `other` plays their tracks too, keeping them in step. */
    private splitLayer(layer: MontageLayer, other: MontageLayer): void {
        layer.parts = layer.parts.flatMap((part) => {
            const plans = splitByLayer(part, other);
            if (plans.length === 1) {
                part.overlaps = plans[0].overlaps;
                return [part];
            }
            const parts = plans.map(plan => this.createPart(layer, plan, part.action.time));
            this.removePart(part);
            return parts;
        });
    }

    /** An action of its own for `plan`'s tracks, so the same clip can play in several montages at once. */
    private createPart(layer: MontageLayer, plan: PartPlan, time: number): MontagePart {
        const names = new Set(plan.tracks);
        const source = layer.clip;
        const clip = new THREE.AnimationClip(
            source.name,
            source.duration,
            source.tracks.filter(track => names.has(track.name)),
            source.blendMode
        );
        const action = this.mixer.clipAction(clip);
        action.setLoop(layer.loop ? THREE.LoopRepeat : THREE.LoopOnce, layer.loop ? Infinity : 1);
        action.clampWhenFinished = true;
        action.timeScale = layer.rate;
        action.time = time;
        action.setEffectiveWeight(0);
        action.play();
        return { tracks: plan.tracks, overlaps: plan.overlaps, action, clip };
    }

    private removePart(part: MontagePart): void {
        part.action.stop();
        this.mixer.uncacheClip(part.clip);
    }

    private applyWeights(): void {
        this.layers.forEach(layer => layer.parts.forEach((part) => {
            part.action.setEffectiveWeight(mixerWeight(layer, part));
        }));
    }
}
