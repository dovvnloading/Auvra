import * as THREE from 'three';

/**
 * AWARENESS
 *
 * How an AI comes to notice a target, rather than knowing it the instant it is in view: each
 * moment the target can be seen fills a meter, faster the nearer it is and the closer to straight
 * ahead, slower out of the corner of the eye (peripheral vision), not at all behind a wall. A
 * target right next to the AI is noticed at once whichever way it faces. Half-full, the AI is
 * suspicious and goes to look where it glimpsed the target; full, it is alerted and gives chase.
 * Out of sight the meter holds for a moment, then fades; an alerted AI calms down only once it
 * has faded below suspicion. A noise makes it at least suspicious.
 */

export interface AwarenessTuning {
    /** The farthest the target can be seen (world units). */
    range: number;
    /** The cone seen in full, in degrees across. */
    centralFov: number;
    /** The wider cone seen out of the corner of the eye, in degrees across. */
    peripheralFov: number;
    /** Within this distance the target is noticed at once, whichever way the AI faces. */
    nearRadius: number;
    /** Seconds to notice a target close by and straight ahead; farther or to the side takes longer. */
    reactionSeconds: number;
    /** Seconds a full meter takes to fade once the target is out of sight (after a short hold). */
    forgetSeconds: number;
}

export const DEFAULT_AWARENESS_TUNING: AwarenessTuning = {
    range: 15,
    centralFov: 120,
    peripheralFov: 200,
    nearRadius: 4,
    reactionSeconds: 0.5,
    forgetSeconds: 6,
};

/** The meter's level at which the AI becomes suspicious. */
export const SUSPICIOUS_LEVEL = 0.35;
/** Out of sight, the meter holds this long before it fades. */
const HOLD_SECONDS = 1.5;
/** How much a target out of the corner of the eye counts, against one straight ahead. */
const PERIPHERAL_FACTOR = 0.3;
/** How much a target at the edge of sight range counts, against one close by. */
const FAR_FACTOR = 0.2;
/** Up to this share of the range, distance does not slow noticing. */
const NEAR_SHARE = 0.25;

const smoothstep = (edge0: number, edge1: number, x: number): number => {
    const t = Math.min(1, Math.max(0, (x - edge0) / Math.max(edge1 - edge0, 1e-6)));
    return t * t * (3 - 2 * t);
};

const _toTarget = new THREE.Vector3();

/**
 * How fast seeing the target fills the meter, per second: 0 when it cannot be seen, Infinity when
 * it is close enough to be noticed at once.
 */
export const sightRate = (
    tuning: AwarenessTuning,
    eye: THREE.Vector3,
    forward: THREE.Vector3,
    target: THREE.Vector3,
    lineOfSight: boolean,
): number => {
    _toTarget.subVectors(target, eye);
    _toTarget.y = 0;
    const distance = _toTarget.length();
    if (distance >= tuning.range) return 0;
    if (distance < tuning.nearRadius) return Infinity;
    if (!lineOfSight) return 0;
    const flatForward = Math.hypot(forward.x, forward.z);
    const cosine = flatForward > 1e-6 && distance > 1e-6 ? (forward.x * _toTarget.x + forward.z * _toTarget.z) / (flatForward * distance) : 1;
    const angle = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(cosine, -1, 1)));
    const central = tuning.centralFov / 2;
    const peripheral = Math.max(tuning.peripheralFov / 2, central);
    if (angle > peripheral) return 0;
    // Full across the central cone, PERIPHERAL_FACTOR out to the peripheral edge.
    const angleFactor = angle <= central ? 1 : PERIPHERAL_FACTOR;
    const distanceFactor = THREE.MathUtils.lerp(1, FAR_FACTOR, smoothstep(tuning.range * NEAR_SHARE, tuning.range, distance));
    return (angleFactor * distanceFactor) / Math.max(tuning.reactionSeconds, 1e-3);
};

export type AwarenessStage = 'unaware' | 'suspicious' | 'alerted';

/** One AI's meter (see the module comment). */
export class Awareness {
    /** 0 (unaware) to 1 (alerted). */
    level = 0;
    alerted = false;
    private outOfSight = Infinity;

    /** `forgetSeconds`: how long a full meter takes to fade once the target is out of sight. */
    constructor(readonly forgetSeconds = DEFAULT_AWARENESS_TUNING.forgetSeconds) {}

    /** Advances the meter by `delta` seconds of seeing at `rate` (sightRate), having heard a noise or not. */
    update(rate: number, heard: boolean, delta: number): AwarenessStage {
        if (rate > 0) {
            this.level = Math.min(1, this.level + rate * delta);
            this.outOfSight = 0;
        } else {
            this.outOfSight += delta;
            if (this.outOfSight > HOLD_SECONDS) this.level = Math.max(0, this.level - delta / Math.max(this.forgetSeconds, 1e-3));
        }
        if (heard) this.level = Math.max(this.level, SUSPICIOUS_LEVEL);
        if (this.level >= 1) this.alerted = true;
        else if (this.level < SUSPICIOUS_LEVEL) this.alerted = false;
        return this.stage;
    }

    /** Alerts it at once: it was hurt, or told by another. */
    alert(): void {
        this.level = 1;
        this.alerted = true;
        this.outOfSight = 0;
    }

    get stage(): AwarenessStage {
        return this.alerted ? 'alerted' : this.level >= SUSPICIOUS_LEVEL ? 'suspicious' : 'unaware';
    }
}
