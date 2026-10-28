import { createContext, useContext } from 'react';
import * as THREE from 'three';
import { PLAYER_PHYSICS_ID, type PhysicsQueries } from './physics';

/**
 * AI PERCEPTION
 *
 * What enemies notice, besides what is in front of them:
 *
 * - Sight is blocked by the level: a physics ray from an enemy's eyes to the player's chest must
 *   reach the player (lineOfSight). Walls, rocks and closed doors with colliders hide the player.
 * - Noises carry: gunshots, and whatever the level makes with a Make Noise node, are reported to the
 *   session's NoiseBus with how far they carry. An enemy within that distance hears it and goes to
 *   look where it came from, as it does where it last saw the player.
 */

export interface NoiseEvent {
    position: THREE.Vector3;
    /** How far it carries (world units). */
    radius: number;
    /** Who made it (PLAYER_PHYSICS_ID, an enemy's id, null for the level); nobody hears their own. */
    source: string | null;
    /** Seconds on the bus's clock. */
    time: number;
}

/** Seconds a noise stays on the bus, for listeners that only check now and then. */
const NOISE_LIFETIME = 2;
/** Noises kept at most; a burst of fire past this drops the oldest. */
const MAX_NOISES = 64;
/** How far a gunshot carries when its weapon does not say. */
export const GUNSHOT_NOISE_RADIUS = 40;

/** The noises of one play session. */
export class NoiseBus {
    private readonly events: NoiseEvent[] = [];

    constructor(private readonly clock: () => number = () => performance.now() / 1000) {}

    now(): number {
        return this.clock();
    }

    report(position: THREE.Vector3 | readonly [number, number, number], radius: number, source: string | null = null): void {
        if (!(radius > 0) || !Number.isFinite(radius)) return;
        const at = Array.isArray(position) ? new THREE.Vector3(...position) : (position as THREE.Vector3).clone();
        if (![at.x, at.y, at.z].every(Number.isFinite)) return;
        const time = this.now();
        while (this.events.length && (this.events.length >= MAX_NOISES || time - this.events[0].time > NOISE_LIFETIME)) this.events.shift();
        this.events.push({ position: at, radius, source, time });
    }

    /**
     * The noise `listener` hears that was made after `since` and not by `self`: of those that reach
     * it, the one heard loudest (most carry left over at the listener). Null when none does.
     */
    heardSince(listener: THREE.Vector3, since: number, self: string | null = null, hearing = 1): NoiseEvent | null {
        let best: NoiseEvent | null = null;
        let bestMargin = 0;
        for (const event of this.events) {
            if (event.time <= since || (self !== null && event.source === self)) continue;
            const margin = event.radius * hearing - event.position.distanceTo(listener);
            if (margin > bestMargin || (margin >= 0 && !best)) {
                best = event;
                bestMargin = margin;
            }
        }
        return best;
    }
}

export const NoiseBusContext = createContext<NoiseBus | null>(null);

/** The session's noise bus; null outside a play session (nothing is heard). */
export const useNoiseBus = (): NoiseBus | null => useContext(NoiseBusContext);

/** Height above the feet of a character's eyes and of what others aim their eyes at, as shares of its height. */
export const EYE_HEIGHT = 0.9;
export const CHEST_HEIGHT = 0.6;
/** Within this of the target, an object the ray hits is the target itself (its body or what it holds). */
const SIGHT_TOLERANCE = 0.3;

const heights = new WeakMap<THREE.Object3D, number>();
const _box = new THREE.Box3();

/** A character's height from its bounds (taken once; characters do not change size). */
export const characterHeight = (object: THREE.Object3D): number => {
    let height = heights.get(object);
    if (height === undefined) {
        _box.setFromObject(object);
        height = _box.isEmpty() ? 1.8 : Math.max(0.1, _box.max.y - _box.min.y);
        heights.set(object, height);
    }
    return height;
};

/**
 * Whether nothing solid stands between `eye` and `target`: a physics ray from one to the other
 * hits nothing short of it, or hits the player. `ignore` is an object the ray passes through (the
 * one a sound plays from). Without physics (an inert world) everything is in sight, as before
 * perception took walls into account.
 */
export const lineOfSight = (physics: Pick<PhysicsQueries, 'raycast'>, eye: THREE.Vector3, target: THREE.Vector3, ignore: string | null = null): boolean => {
    const direction = target.clone().sub(eye);
    const distance = direction.length();
    if (distance < 1e-3) return true;
    const hit = physics.raycast(eye, direction, distance, ignore ? { excludeObjectId: ignore } : undefined);
    return !hit || hit.objectId === PLAYER_PHYSICS_ID || hit.distance >= distance - SIGHT_TOLERANCE;
};
