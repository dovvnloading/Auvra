import type * as THREE from 'three';
import type { DebrisOptions } from './debris';
import type { ClothCollider } from './cloth';
import type { FractureResult } from './fracture';
import type { SurfaceKind } from './surfaces';
import { abilityActors, damageActor, type AbilityCharacter } from './abilities';

/**
 * DESTRUCTIBLES AND COMBAT
 *
 * What can be broken this session (objects with a Destructible component), and the combat services
 * shots, explosions and scripts reach them through: impact effects, character damage in an area
 * and pushing loose bodies. The level runtime's Destruction layer fills the services in; each
 * Destructible registers itself as it mounts.
 */

export type Vec3 = { x: number; y: number; z: number };

export interface DestructibleHandle {
    readonly objectId: string;
    /** Its middle in the world, and how far it reaches from there, m. */
    centre(): Vec3;
    radius(): number;
    health(): number;
    maxHealth(): number;
    broken(): boolean;
    /**
     * Takes `amount` of damage, from a hit at `point` travelling along `direction` (either may be
     * null); breaks it at 0 health. True when this broke it.
     */
    damage(amount: number, point: Vec3 | null, direction: Vec3 | null): boolean;
    /** Breaks it at once, its pieces flung from `point` (null: its middle) at about `speed` m/s on top of its own scatter. */
    breakApart(point: Vec3 | null, direction: Vec3 | null, speed?: number): boolean;
}

const handles = new Map<string, DestructibleHandle>();
const brokenListeners = new Set<(objectId: string) => void>();

export const destructibles = {
    /** Adds one; returns how to remove it again. */
    register(handle: DestructibleHandle): () => void {
        handles.set(handle.objectId, handle);
        return () => {
            if (handles.get(handle.objectId) === handle) handles.delete(handle.objectId);
        };
    },
    get(objectId: string | null | undefined): DestructibleHandle | null {
        return objectId ? handles.get(objectId) ?? null : null;
    },
    all(): DestructibleHandle[] {
        return [...handles.values()];
    },
    /** Those whose reach overlaps a sphere, with how far their middle is from its centre. */
    within(centre: Vec3, radius: number): { handle: DestructibleHandle; distance: number }[] {
        const found: { handle: DestructibleHandle; distance: number }[] = [];
        for (const handle of handles.values()) {
            if (handle.broken()) continue;
            const c = handle.centre();
            const distance = Math.hypot(c.x - centre.x, c.y - centre.y, c.z - centre.z);
            if (distance - handle.radius() <= radius) found.push({ handle, distance: Math.max(0, distance - handle.radius() * 0.5) });
        }
        return found;
    },
    clear(): void {
        handles.clear();
    },
    /** Called with each object as it breaks; returns how to stop listening. */
    onBroken(listener: (objectId: string) => void): () => void {
        brokenListeners.add(listener);
        return () => { brokenListeners.delete(listener); };
    },
    /** Tells the listeners an object broke (its Destructible calls this). */
    reportBroken(objectId: string): void {
        for (const listener of [...brokenListeners]) listener(objectId);
    },
};

/** What an explosion does. */
export interface ExplosionRequest {
    centre: Vec3;
    /** Reach, m: damage and push fall to nothing at its edge. */
    radius: number;
    /** Damage at the centre. */
    damage: number;
    /** How hard it throws what it reaches, as a change of speed at the centre, m/s. */
    force: number;
}

/** The services the session's Destruction layer provides. */
export interface CombatServices {
    /** A bullet or blow landing on `surface` at `point`, facing `normal`; strength 0-1 sizes the effect. */
    impact(surface: SurfaceKind, point: Vec3, normal: Vec3, strength: number): void;
    /** Characters (the player and enemies) in reach take damage, less further out. */
    damageCharacters(centre: Vec3, radius: number, damage: number): number;
    /** Loose bodies in reach are thrown outward; how many. */
    pushBodies(centre: Vec3, radius: number, speed: number): number;
    /** The blast's look and sound. */
    explosionEffect(centre: Vec3, radius: number): void;
    /** Puts a broken object's pieces into the world (see DebrisWorld.spawn); how many came loose. */
    spawnDebris(result: FractureResult, materials: THREE.Material[], matrix: THREE.Matrix4, options: DebrisOptions): number;
    /** An object breaking: dust and chips in `color` and the crunch, sized by its reach. */
    breakEffect(centre: Vec3, radius: number, color: string): void;
    /** A loose body's velocity before this frame's physics step (by its physics handle); null if not moving. */
    velocityBefore(bodyHandle: number): Vec3 | null;
    /** The characters (the player and enemies) as upright capsules, for cloth to rest against. */
    characterCapsules(): ClothCollider[];
    /** The living characters, for abilities to aim at and reach. */
    characters(): AbilityCharacter[];
}

const NO_COMBAT: CombatServices = {
    impact: () => undefined,
    damageCharacters: () => 0,
    pushBodies: () => 0,
    explosionEffect: () => undefined,
    spawnDebris: () => 0,
    breakEffect: () => undefined,
    velocityBefore: () => null,
    characterCapsules: () => [],
    characters: () => [],
};

const providers: Partial<CombatServices>[] = [];
let services: CombatServices = NO_COMBAT;

/** The session's combat services; inert outside play. */
export const combat = (): CombatServices => services;

/**
 * Provides some of the session's combat services (the Destruction layer most, the projectile
 * manager character damage); returns how to withdraw them again.
 */
export const provideCombat = (part: Partial<CombatServices>): (() => void) => {
    providers.push(part);
    services = Object.assign({}, NO_COMBAT, ...providers);
    return () => {
        const index = providers.indexOf(part);
        if (index >= 0) providers.splice(index, 1);
        services = Object.assign({}, NO_COMBAT, ...providers);
    };
};

/** How much of an explosion reaches `distance` from its centre: all at the centre, none at its edge. */
export const explosionFalloff = (distance: number, radius: number): number => {
    if (!(radius > 0) || distance >= radius) return 0;
    const t = Math.max(0, distance) / radius;
    return 1 - t * t;
};

/** An explosion: damages characters and destructibles in reach, throws loose bodies, and shows itself. What it reached. */
export const explode = (request: ExplosionRequest): { characters: number; bodies: number; broken: number } => {
    const radius = Math.max(0, request.radius);
    const world = combat();
    world.explosionEffect(request.centre, radius);
    const characters = request.damage > 0 ? world.damageCharacters(request.centre, radius, request.damage) : 0;
    let broken = 0;
    for (const { handle, distance } of destructibles.within(request.centre, radius)) {
        const share = explosionFalloff(distance, radius);
        if (share <= 0) continue;
        const c = handle.centre();
        const away = { x: c.x - request.centre.x, y: c.y - request.centre.y, z: c.z - request.centre.z };
        const length = Math.hypot(away.x, away.y, away.z) || 1;
        const direction = { x: away.x / length, y: away.y / length, z: away.z / length };
        if (handle.damage(request.damage * share, request.centre, direction)) broken++;
    }
    // Actors with health (an Abilities component) are hurt too, less their armour.
    if (request.damage > 0) {
        for (const { actor, distance } of abilityActors.within('runtime', request.centre, radius)) {
            const share = explosionFalloff(distance, radius);
            if (share > 0) damageActor(actor, request.damage * share);
        }
    }
    // After breaking, so the new pieces are thrown too.
    const bodies = request.force > 0 ? world.pushBodies(request.centre, radius, request.force) : 0;
    return { characters, bodies, broken };
};
