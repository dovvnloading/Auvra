
import { useEffect, useState } from 'react';
import * as THREE from 'three';

export interface AnimationMixerResult {
    mixer: THREE.AnimationMixer | null;
    actionsMap: Record<string, THREE.AnimationAction>;
}

// Global cache to associate mixers with objects without modifying the object's structure (userData)
const mixerCache = new WeakMap<THREE.Group, THREE.AnimationMixer>();

export const useAnimationMixer = (
    modelObject: THREE.Group,
    allClips: THREE.AnimationClip[]
): AnimationMixerResult => {
    const [result, setResult] = useState<AnimationMixerResult>({ mixer: null, actionsMap: {} });

    useEffect(() => {
        if (!modelObject) return;

        // Cleanup legacy/previous mixer if it exists
        const existingMixer = mixerCache.get(modelObject);
        if (existingMixer) {
            existingMixer.stopAllAction();
            existingMixer.uncacheRoot(modelObject);
        }

        const mixer = new THREE.AnimationMixer(modelObject);
        mixerCache.set(modelObject, mixer);

        const actionsMap: Record<string, THREE.AnimationAction> = {};

        // Sanitize & Load Clips
        // DEFENSIVE CHECK: Ensure allClips is valid before iterating
        if (allClips && Array.isArray(allClips)) {
            allClips.forEach((originalClip: THREE.AnimationClip) => {
                if (actionsMap[originalClip.name]) return;

                // Clone to avoid modifying shared assets in memory
                const clip = originalClip.clone();
                const action = mixer.clipAction(clip);
                
                // Configuration
                action.clampWhenFinished = true;
                action.enabled = false; // Start disabled
                action.setEffectiveWeight(0);
                // DO NOT auto-play here. We let the Animator hook manage playback state.

                actionsMap[originalClip.name] = action;
            });
        }

        setResult({ mixer, actionsMap });

        return () => {
            mixer.stopAllAction();
            mixer.uncacheRoot(modelObject);
            mixerCache.delete(modelObject);
        };
    }, [modelObject, allClips]);

    return result;
};
