import * as THREE from 'three';
import { Blueprint } from '../../types';

/** The part of a SandboxEntityHandle a melee hit needs. */
interface MeleeTarget {
    object: THREE.Object3D;
    takeDamage: (amount: number, point: THREE.Vector3) => void;
}

/** Damage used when a blueprint has no usable 'Damage' stat. */
export const DEFAULT_MELEE_DAMAGE = 10;

/** Height above the target's origin where melee hits land (roughly the torso). */
const MELEE_HIT_HEIGHT = 1.5;

/** Reads a blueprint's 'Damage' stat, falling back to the default for missing or invalid values. */
export const resolveBlueprintDamage = (blueprint: Pick<Blueprint, 'stats'> | null | undefined): number => {
    const value = blueprint?.stats.find(stat => stat.name === 'Damage')?.value;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : DEFAULT_MELEE_DAMAGE;
};

/** Applies a melee hit to the target entity. Used by the Sandbox arena and level play alike. */
export const applyMeleeHit = (target: MeleeTarget | null | undefined, amount: number) => {
    if (!target) return;
    const point = target.object.position.clone();
    point.y += MELEE_HIT_HEIGHT;
    target.takeDamage(amount, point);
};
