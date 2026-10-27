import type { WeaponSettings } from '../types';

/**
 * PLAYER WEAPONS
 *
 * A player blueprint carries a list of weapons; the player holds one at a time. Each frame the
 * controller steps the weapon state with that frame's input and fires the shots it reports. The
 * state keeps every weapon's ammunition, so switching away and back keeps a half-empty magazine.
 */

/** A weapon with every field filled in and kept in range. */
type OptionalWeaponField = 'attachmentId' | 'muzzleSocket' | 'fireClip' | 'aimClip' | 'reloadClip';
export type ResolvedWeapon = Required<Omit<WeaponSettings, OptionalWeaponField>> & Pick<WeaponSettings, OptionalWeaponField>;

/** The weapon a blueprint without weapons fires: what the player always had. */
export const DEFAULT_WEAPON: ResolvedWeapon = {
    id: 'default', name: 'Weapon', fireMode: 'auto', fireRate: 1 / 0.15, damage: 10, magazine: 0, reserve: -1,
    reloadSeconds: 1.5, spread: 0, pellets: 1, projectileSpeed: 60,
    attachmentId: null, muzzleSocket: null, fireClip: null, aimClip: null, reloadClip: null,
};

const number = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

const clip = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);

export const resolveWeapon = (weapon: WeaponSettings): ResolvedWeapon => ({
    id: weapon.id,
    name: typeof weapon.name === 'string' && weapon.name.trim() ? weapon.name.trim() : DEFAULT_WEAPON.name,
    fireMode: weapon.fireMode === 'semi' ? 'semi' : 'auto',
    fireRate: number(weapon.fireRate, DEFAULT_WEAPON.fireRate, 0.1, 60),
    damage: number(weapon.damage, DEFAULT_WEAPON.damage, 0, 100000),
    magazine: Math.round(number(weapon.magazine, DEFAULT_WEAPON.magazine, 0, 10000)),
    reserve: Math.round(number(weapon.reserve, DEFAULT_WEAPON.reserve, -1, 100000)),
    reloadSeconds: number(weapon.reloadSeconds, DEFAULT_WEAPON.reloadSeconds, 0, 30),
    spread: number(weapon.spread, DEFAULT_WEAPON.spread, 0, 45),
    pellets: Math.round(number(weapon.pellets, DEFAULT_WEAPON.pellets, 1, 32)),
    projectileSpeed: number(weapon.projectileSpeed, DEFAULT_WEAPON.projectileSpeed, 1, 1000),
    attachmentId: weapon.attachmentId ?? null,
    muzzleSocket: clip(weapon.muzzleSocket),
    fireClip: clip(weapon.fireClip),
    aimClip: clip(weapon.aimClip),
    reloadClip: clip(weapon.reloadClip),
});

/** A blueprint's weapons, resolved; the default weapon when it has none. */
export const resolveWeapons = (weapons: readonly WeaponSettings[] | undefined): ResolvedWeapon[] =>
    weapons?.length ? weapons.map(resolveWeapon) : [DEFAULT_WEAPON];

export interface WeaponAmmo {
    /** Rounds in the magazine. */
    loaded: number;
    /** Rounds carried besides; -1 is unlimited. */
    reserve: number;
}

export interface WeaponState {
    /** Index of the weapon held. */
    active: number;
    ammo: WeaponAmmo[];
    /** Seconds until the reload in progress finishes; 0 when not reloading. */
    reloading: number;
    /** Seconds until the next shot may fire. */
    cooldown: number;
    /** Seconds the first shot of a press waits for the firing pose (hip fire). */
    warmup: number;
    /** A semi-automatic weapon has fired for the current press. */
    triggerSpent: boolean;
}

/** Full magazines and reserves for each weapon, holding the first. */
export const createWeaponState = (weapons: readonly ResolvedWeapon[]): WeaponState => ({
    active: 0,
    ammo: weapons.map(weapon => ({ loaded: weapon.magazine, reserve: weapon.reserve })),
    reloading: 0,
    cooldown: 0,
    warmup: 0,
    triggerSpent: false,
});

/** Whether a weapon uses ammunition at all (a magazine of 0 never runs out). */
const usesAmmo = (weapon: ResolvedWeapon): boolean => weapon.magazine > 0;

/** Starts reloading the held weapon when its magazine is not full and there are rounds to load. */
export const startReload = (state: WeaponState, weapons: readonly ResolvedWeapon[]): boolean => {
    const weapon = weapons[state.active];
    const ammo = state.ammo[state.active];
    if (!weapon || !ammo || !usesAmmo(weapon) || state.reloading > 0) return false;
    if (ammo.loaded >= weapon.magazine || ammo.reserve === 0) return false;
    state.reloading = Math.max(weapon.reloadSeconds, 1e-3);
    return true;
};

/** Holds weapon `index` (wrapping), cancelling a reload in progress. Returns whether it changed. */
export const switchWeapon = (state: WeaponState, weapons: readonly ResolvedWeapon[], index: number): boolean => {
    if (weapons.length < 2) return false;
    const next = ((index % weapons.length) + weapons.length) % weapons.length;
    if (next === state.active) return false;
    state.active = next;
    state.reloading = 0;
    state.cooldown = 0;
    state.triggerSpent = false;
    return true;
};

export interface WeaponInput {
    firing: boolean;
    /** Fire went down this frame. */
    firePressed: boolean;
    reloadPressed: boolean;
    nextWeaponPressed: boolean;
    /** The first shot of a press waits this long (seconds), for a hip-fire pose to come up. */
    firstShotDelay: number;
}

export interface WeaponStep {
    /** Shots fired this frame. */
    shots: number;
    /** A reload started this frame. */
    reloadStarted: boolean;
    /** The held weapon changed this frame. */
    switched: boolean;
}

/**
 * Advances the weapons by `delta` seconds. Automatic weapons fire at their rate while Fire is held,
 * semi-automatic ones once per press. An empty magazine reloads on its own when Fire is pressed (or
 * held); a reload moves rounds from the reserve into the magazine when it finishes.
 */
export const stepWeapons = (state: WeaponState, weapons: readonly ResolvedWeapon[], input: WeaponInput, delta: number): WeaponStep => {
    const result: WeaponStep = { shots: 0, reloadStarted: false, switched: false };
    if (input.nextWeaponPressed) result.switched = switchWeapon(state, weapons, state.active + 1);
    const weapon = weapons[state.active];
    const ammo = state.ammo[state.active];
    if (!weapon || !ammo) return result;

    if (state.reloading > 0) {
        state.reloading -= delta;
        if (state.reloading <= 0) {
            state.reloading = 0;
            const wanted = weapon.magazine - ammo.loaded;
            const taken = ammo.reserve < 0 ? wanted : Math.min(wanted, ammo.reserve);
            ammo.loaded += taken;
            if (ammo.reserve >= 0) ammo.reserve -= taken;
        }
    } else if (input.reloadPressed) {
        result.reloadStarted = startReload(state, weapons);
    }

    if (!input.firing) state.triggerSpent = false;
    if (input.firePressed) {
        state.warmup = input.firstShotDelay;
        state.cooldown = 0;
    }
    if (state.cooldown > 0) state.cooldown -= delta;
    if (!input.firing || state.reloading > 0) return result;
    if (state.warmup > 0) {
        state.warmup -= delta;
        return result;
    }
    if (weapon.fireMode === 'semi' && state.triggerSpent) return result;

    const interval = 1 / weapon.fireRate;
    while (state.cooldown <= 0) {
        if (usesAmmo(weapon) && ammo.loaded <= 0) {
            if (startReload(state, weapons)) result.reloadStarted = true;
            break;
        }
        if (usesAmmo(weapon)) ammo.loaded -= 1;
        result.shots += 1;
        state.cooldown += interval;
        if (weapon.fireMode === 'semi') {
            state.triggerSpent = true;
            break;
        }
    }
    return result;
};
