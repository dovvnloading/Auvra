import * as THREE from 'three';
import type { TimelineClipSample } from './evaluate';

/**
 * TIMELINE CLIP POSER
 *
 * Poses a character from a timeline's animation clips at any time, forwards, backwards or jumping
 * (the editor scrubs; play steps): each clip's keyframe tracks are sampled directly at the clip's own
 * time, with no mixer keeping state. The clips playing together are averaged by their weights, and the
 * result is laid over the pose the character already has (its own animation, or its rest pose) by how
 * much the clips cover it, so where they fade out the character's own animation shows through.
 */

type Property = 'position' | 'quaternion' | 'scale';

interface Binding {
    node: THREE.Object3D;
    property: Property;
    interpolant: THREE.Interpolant;
}

/** A clip to pose with: the clip itself, where in it, and its weight. */
export interface PoseLayer {
    clip: THREE.AnimationClip;
    time: number;
    weight: number;
    loop: boolean;
}

/** Where a clip is at `time`: wrapped round when it loops, else held at its ends. */
export const clipTime = (clip: THREE.AnimationClip, time: number, loop: boolean): number => {
    const duration = clip.duration;
    if (!(duration > 0)) return 0;
    if (loop) return ((time % duration) + duration) % duration;
    return Math.min(duration, Math.max(0, time));
};

const PROPERTIES: readonly string[] = ['position', 'quaternion', 'scale'];

interface Accumulator {
    node: THREE.Object3D;
    property: Property;
    /** Sum of the weights so far, and the running average. */
    total: number;
    vector: THREE.Vector3;
    quaternion: THREE.Quaternion;
}

const _quaternion = new THREE.Quaternion();
const _vector = new THREE.Vector3();

export class ClipPoser {
    private readonly bindings = new Map<THREE.AnimationClip, Binding[]>();
    private readonly accumulators = new Map<string, Accumulator>();

    constructor(readonly root: THREE.Object3D) {}

    /** The tracks of `clip` that move this root's nodes (transforms only), bound once. */
    private bind(clip: THREE.AnimationClip): Binding[] {
        let bindings = this.bindings.get(clip);
        if (bindings) return bindings;
        bindings = [];
        for (const track of clip.tracks) {
            const parsed = THREE.PropertyBinding.parseTrackName(track.name);
            if (!PROPERTIES.includes(parsed.propertyName) || parsed.propertyIndex !== undefined) continue;
            const node = THREE.PropertyBinding.findNode(this.root, parsed.nodeName) as THREE.Object3D | null;
            if (!node || !(node as THREE.Object3D).isObject3D) continue;
            // Every track has the factory its interpolation set (the typings leave it out).
            const interpolant = (track as unknown as { createInterpolant(): THREE.Interpolant }).createInterpolant();
            bindings.push({ node, property: parsed.propertyName as Property, interpolant });
        }
        this.bindings.set(clip, bindings);
        return bindings;
    }

    /** The nodes `layers` move: what a pose guard should look after. */
    nodes(layers: readonly PoseLayer[]): THREE.Object3D[] {
        const nodes = new Set<THREE.Object3D>();
        for (const layer of layers) for (const binding of this.bind(layer.clip)) nodes.add(binding.node);
        return [...nodes];
    }

    /**
     * Poses the root's nodes from `layers`: their clips averaged by weight, then mixed over the pose the
     * nodes have now by the layers' cover (their weights added, at most 1). Returns that cover.
     */
    apply(layers: readonly PoseLayer[]): number {
        const live = layers.filter(layer => layer.weight > 0);
        if (live.length === 0) return 0;
        const cover = Math.min(1, live.reduce((sum, layer) => sum + layer.weight, 0));
        this.accumulators.clear();
        for (const layer of live) {
            const at = clipTime(layer.clip, layer.time, layer.loop);
            for (const binding of this.bind(layer.clip)) {
                const values = binding.interpolant.evaluate(at);
                const key = `${binding.node.uuid}.${binding.property}`;
                let entry = this.accumulators.get(key);
                if (!entry) {
                    entry = { node: binding.node, property: binding.property, total: 0, vector: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
                    this.accumulators.set(key, entry);
                }
                entry.total += layer.weight;
                // Each layer pulls the running average toward itself by its share of the weight so far.
                const share = layer.weight / entry.total;
                if (binding.property === 'quaternion') {
                    _quaternion.fromArray(values as unknown as number[]).normalize();
                    if (entry.total === layer.weight) entry.quaternion.copy(_quaternion);
                    else entry.quaternion.slerp(_quaternion, share);
                } else {
                    _vector.fromArray(values as unknown as number[]);
                    if (entry.total === layer.weight) entry.vector.copy(_vector);
                    else entry.vector.lerp(_vector, share);
                }
            }
        }
        for (const entry of this.accumulators.values()) {
            // A node only some of the layers move is covered only by those layers.
            const amount = Math.min(cover, entry.total);
            if (entry.property === 'quaternion') entry.node.quaternion.slerp(entry.quaternion, amount);
            else entry.node[entry.property].lerp(entry.vector, amount);
        }
        return cover;
    }
}

/** The last part of a clip name: FBX takes are often named `Armature|Walk`. */
const shortName = (name: string) => name.slice(name.lastIndexOf('|') + 1).trim().toLowerCase();

/** The clip `name` asks for: the exact name, else the same name without an `Armature|` style prefix, ignoring case. */
export const findTimelineClip = (clips: readonly THREE.AnimationClip[], name: string): THREE.AnimationClip | null => {
    if (!name) return null;
    return clips.find(clip => clip.name === name) ?? clips.find(clip => shortName(clip.name) === shortName(name)) ?? null;
};

/** The layers `samples` ask for from `clips`, leaving out clips the model does not have. */
export const poseLayers = (clips: readonly THREE.AnimationClip[], samples: readonly TimelineClipSample[]): PoseLayer[] => samples.flatMap(sample => {
    const clip = findTimelineClip(clips, sample.clip);
    return clip ? [{ clip, time: sample.time, weight: sample.weight, loop: sample.loop }] : [];
});
