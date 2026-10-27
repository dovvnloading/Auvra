import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { extractRootMotion, type RootMotion } from '../utils/rootMotion';

export interface AnimationMixerResult {
    mixer: THREE.AnimationMixer | null;
    actionsMap: Record<string, THREE.AnimationAction>;
    /** The source clip for each name (first wins), for one-shot montages. */
    clipsByName: Record<string, THREE.AnimationClip>;
    /** Root travel of each clip played with root motion; its action plays the clip with the travel removed. */
    rootMotions: Record<string, RootMotion>;
}

const EMPTY: AnimationMixerResult = { mixer: null, actionsMap: {}, clipsByName: {}, rootMotions: {} };

// The mixer currently driving each model, so a second runtime on the same model stops the first.
const mixerCache = new WeakMap<THREE.Group, THREE.AnimationMixer>();

/**
 * One mixer per model, rebuilt only when the model, the set of clips (by identity) or the clips
 * played with root motion change, not whenever a caller passes a new array.
 */
export const useAnimationMixer = (
    modelObject: THREE.Group,
    allClips: THREE.AnimationClip[],
    rootMotionClipNames: readonly string[] = []
): AnimationMixerResult => {
    const [result, setResult] = useState<AnimationMixerResult>(EMPTY);
    const clipsRef = useRef(allClips);
    clipsRef.current = allClips;
    const clipKey = useMemo(() => (Array.isArray(allClips) ? allClips.map(clip => clip.uuid).join('|') : ''), [allClips]);
    const rootKey = [...rootMotionClipNames].sort().join('|');

    useEffect(() => {
        if (!modelObject) return;

        const existingMixer = mixerCache.get(modelObject);
        if (existingMixer) {
            existingMixer.stopAllAction();
            existingMixer.uncacheRoot(modelObject);
        }
        const mixer = new THREE.AnimationMixer(modelObject);
        mixerCache.set(modelObject, mixer);
        const actionsMap: Record<string, THREE.AnimationAction> = {};
        const clipsByName: Record<string, THREE.AnimationClip> = {};
        const rootMotions: Record<string, RootMotion> = {};
        const rootNames = new Set(rootKey ? rootKey.split('|') : []);
        const clips = clipsRef.current;

        if (Array.isArray(clips)) {
            clips.forEach((originalClip: THREE.AnimationClip) => {
                if (actionsMap[originalClip.name]) return;
                clipsByName[originalClip.name] = originalClip;

                const motion = rootNames.has(originalClip.name) ? extractRootMotion(originalClip, { root: modelObject }) : null;
                if (motion) rootMotions[originalClip.name] = motion;
                // Clone so the mixer never modifies a shared asset.
                const action = mixer.clipAction(motion ? motion.clip.clone() : originalClip.clone());

                action.clampWhenFinished = true;
                action.enabled = false;
                action.setEffectiveWeight(0);
                // Playback is started by the animator.
                actionsMap[originalClip.name] = action;
            });
        }

        setResult({ mixer, actionsMap, clipsByName, rootMotions });

        return () => {
            mixer.stopAllAction();
            mixer.uncacheRoot(modelObject);
            if (mixerCache.get(modelObject) === mixer) mixerCache.delete(modelObject);
        };
    }, [modelObject, clipKey, rootKey]);

    return result;
};
