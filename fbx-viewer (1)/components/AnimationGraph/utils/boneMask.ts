import * as THREE from 'three';

/**
 * A bone name reduced for tolerant matching: the part after any "|" or ":" namespace, lower case,
 * letters and digits only, without a leading "mixamorig" (numbered or not), "armature" or
 * "skeleton". "mixamorig:Spine", "mixamorigSpine", "mixamorig1:Spine" and "spine" all give "spine".
 */
export const boneKey = (name: string): string => {
    const leaf = (name.split(/[|:]/).pop() || name).toLowerCase().replace(/[^a-z0-9]/g, '');
    return leaf.replace(/^(mixamorig\d*|armature|skeleton)/, '') || leaf;
};

/** The node a track animates ("mixamorigSpine.quaternion" -> "mixamorigSpine"), or null if unparsable. */
const trackNodeName = (track: THREE.KeyframeTrack): string | null => {
    try {
        const parsed = THREE.PropertyBinding.parseTrackName(track.name);
        if (parsed.objectName === 'bones' && parsed.objectIndex) return String(parsed.objectIndex);
        return parsed.nodeName || '';
    } catch {
        return null;
    }
};

const preferBone = (objects: THREE.Object3D[]): THREE.Object3D | null =>
    objects.find(object => (object as THREE.Bone).isBone) ?? objects[0] ?? null;

/**
 * The object under `root` (or in a skeleton bound under it) named `boneName`: an exact name match
 * first, then a {@link boneKey} match, preferring bones over other objects. Null when none matches.
 */
export const findBone = (root: THREE.Object3D, boneName: string): THREE.Object3D | null => {
    const key = boneKey(boneName);
    if (!key) return null;
    const candidates = new Set<THREE.Object3D>();
    root.traverse((child) => {
        candidates.add(child);
        const mesh = child as THREE.SkinnedMesh;
        if (mesh.isSkinnedMesh && mesh.skeleton) mesh.skeleton.bones.forEach(bone => candidates.add(bone));
    });
    const all = [...candidates];
    return preferBone(all.filter(object => object.name === boneName))
        ?? preferBone(all.filter(object => object.name && boneKey(object.name) === key));
};

/** Names of the bone matching `boneName` and of every object below it; empty when no bone matches. */
export const boneNamesUnder = (root: THREE.Object3D, boneName: string): Set<string> => {
    const names = new Set<string>();
    findBone(root, boneName)?.traverse((child) => {
        if (child.name) names.add(child.name);
    });
    return names;
};

/**
 * A new clip with copies of only the tracks that animate one of `bones`. Names are compared by
 * {@link boneKey}, so "mixamorigSpine.quaternion" and "Spine.quaternion" both match "Spine". The
 * duration and blend mode are kept, so the masked clip stays in step with the original.
 */
export const maskClip = (clip: THREE.AnimationClip, bones: Set<string>, name?: string): THREE.AnimationClip => {
    const keys = new Set<string>();
    bones.forEach((bone) => {
        const key = boneKey(bone);
        if (key) keys.add(key);
    });
    const tracks = clip.tracks
        .filter((track) => {
            const node = trackNodeName(track);
            return !!node && keys.has(boneKey(node));
        })
        .map(track => track.clone());
    return new THREE.AnimationClip(name ?? clip.name, clip.duration, tracks, clip.blendMode);
};
