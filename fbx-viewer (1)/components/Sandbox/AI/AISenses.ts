
import * as THREE from 'three';
import { AI_CONFIG } from './AIConfig';

export interface SensoryInput {
    enemyPosition: THREE.Vector3;
    enemyForward: THREE.Vector3;
    targetPosition: THREE.Vector3;
    distToTarget: number;
}

export interface SensoryOutput {
    canSee: boolean;
    dirToTarget: THREE.Vector3;
}

/**
 * Calculates whether the AI can perceive the target based on vision cone and hearing distance.
 */
export const checkVisibility = (input: SensoryInput): SensoryOutput => {
    const { enemyPosition, enemyForward, targetPosition, distToTarget } = input;
    const { DISTANCES, SENSES } = AI_CONFIG;

    // Calculate direction
    const dirToTarget = new THREE.Vector3().subVectors(targetPosition, enemyPosition).normalize();

    // Check Angle (Dot Product)
    // Dot 1.0 = directly in front, 0 = side, -1 = behind
    const viewDot = enemyForward.dot(dirToTarget);
    
    // Convert FOV degrees to Dot threshold
    // e.g. 120deg total FOV = 60deg half angle. cos(60) = 0.5.
    const fovThreshold = Math.cos((SENSES.FOV_ANGLE / 2) * (Math.PI / 180));

    // Perception Logic:
    // 1. Must be within Aggro Range
    // 2. AND (Within FOV Angle OR Close enough to hear)
    const canSee = distToTarget < DISTANCES.AGGRO && (viewDot > fovThreshold || distToTarget < DISTANCES.HEARING);

    return { canSee, dirToTarget };
};

/** What the AI's surroundings tell it this frame, from the AI controller (see runtime/perception.ts). */
export interface Perception {
    /** Whether a ray from its eyes reaches the target: nothing solid stands in between. */
    lineOfSight: boolean;
    /** Where a noise it heard since the last frame came from, if it heard one. */
    heard: THREE.Vector3 | null;
}

/** Everything in sight and nothing heard: an AI without a perception source (tests, inert physics). */
export const OPEN_PERCEPTION: Perception = { lineOfSight: true, heard: null };

/**
 * Whether the AI sees the target: within `sightRange`, and either in its vision cone with nothing
 * in the way, or close enough (AI_CONFIG's HEARING distance) to notice it whichever way it faces.
 */
export const seesTarget = (input: SensoryInput, sightRange: number, perception: Perception = OPEN_PERCEPTION): boolean => {
    const { distToTarget } = input;
    if (distToTarget >= sightRange) return false;
    if (distToTarget < AI_CONFIG.DISTANCES.HEARING) return true;
    const { canSee: inCone } = checkVisibility({ ...input, distToTarget: AI_CONFIG.DISTANCES.HEARING });
    return inCone && perception.lineOfSight;
};
