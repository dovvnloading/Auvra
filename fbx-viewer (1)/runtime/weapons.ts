import type { WeaponCarry, WeaponSettings } from '../types';

/**
 * PLAYER WEAPONS
 *
 * A player blueprint carries a list of weapons; the player holds one at a time. Each frame the
 * controller steps the weapon state with that frame's input and fires the shots it reports. The
 * state keeps every weapon's ammunition, so switching away and back keeps a half-empty magazine.
 */

/** A weapon with every field filled in and kept in range. */
type OptionalWeaponField = 'attachmentId' | 'muzzleSocket' | 'fireClip' | 'aimClip' | 'reloadClip' | 'carry' | 'supportGrip' | MoveClipField;
export type ResolvedWeapon = Required<Omit<WeaponSettings, OptionalWeaponField>> & Pick<WeaponSettings, OptionalWeaponField>;

/** The weapon a blueprint without weapons fires: what the player always had. */
export const DEFAULT_WEAPON: ResolvedWeapon = {
    id: 'default', name: 'Weapon', fireMode: 'auto', fireRate: 1 / 0.15, damage: 10, magazine: 0, reserve: -1,
    reloadSeconds: 1.5, spread: 0, pellets: 1, projectileSpeed: 60, startsOwned: true,
    attachmentId: null, muzzleSocket: null, fireClip: null, aimClip: null, reloadClip: null, carry: null,
    idleClip: null, walkClip: null, runClip: null, backClip: null, jumpClip: null, supportGrip: null,
};

const number = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

const clip = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);

const vector = (value: unknown): [number, number, number] =>
    (Array.isArray(value) && value.length === 3 && value.every(item => typeof item === 'number' && Number.isFinite(item))
        ? [value[0], value[1], value[2]]
        : [0, 0, 0]);

/** Three finite numbers, or null. */
const point = (value: unknown): [number, number, number] | null =>
    (Array.isArray(value) && value.length === 3 && value.every(item => typeof item === 'number' && Number.isFinite(item))
        ? [value[0], value[1], value[2]]
        : null);

/** A carry placement with a bone and finite offsets, or null (stay in the hand). */
export const resolveCarry = (carry: WeaponCarry | null | undefined): WeaponCarry | null =>
    carry && typeof carry.boneName === 'string' && carry.boneName.trim()
        ? { boneName: carry.boneName.trim(), position: vector(carry.position), rotation: vector(carry.rotation) }
        : null;

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
    startsOwned: weapon.startsOwned !== false,
    attachmentId: weapon.attachmentId ?? null,
    muzzleSocket: clip(weapon.muzzleSocket),
    fireClip: clip(weapon.fireClip),
    aimClip: clip(weapon.aimClip),
    reloadClip: clip(weapon.reloadClip),
    carry: resolveCarry(weapon.carry),
    idleClip: clip(weapon.idleClip),
    walkClip: clip(weapon.walkClip),
    runClip: clip(weapon.runClip),
    backClip: clip(weapon.backClip),
    jumpClip: clip(weapon.jumpClip),
    supportGrip: point(weapon.supportGrip),
});

/** The locomotion a weapon is held with, by what each clip stands in for. */
export type MoveRole = 'idle' | 'walk' | 'run' | 'back' | 'jump';
type MoveClipField = 'idleClip' | 'walkClip' | 'runClip' | 'backClip' | 'jumpClip';
const MOVE_CLIP_FIELDS: Record<MoveRole, MoveClipField> = { idle: 'idleClip', walk: 'walkClip', run: 'runClip', back: 'backClip', jump: 'jumpClip' };

/** Every clip a weapon is held with: its locomotion, aim, fire and reload clips. */
export const weaponClipNames = (weapon: WeaponSettings): string[] =>
    [...Object.values(weaponMoveClips(weapon)), weapon.aimClip, weapon.fireClip, weapon.reloadClip]
        .filter((name): name is string => !!clip(name));

/**
 * Which weapon a character previewed outside play holds: while `playing` is one of a weapon's own
 * clips, that weapon (in use); while its animation graph plays, the first one carried from the
 * start, as when play starts; otherwise none, every weapon at its carry placement. -1 for none.
 */
export const previewHeldWeapon = (weapons: readonly WeaponSettings[], playing: string | null): number =>
    playing
        ? weapons.findIndex(weapon => weaponClipNames(weapon).includes(playing))
        : weapons.findIndex(weapon => weapon.startsOwned !== false);

/** A weapon's own locomotion clips (see WeaponSettings.idleClip), by role; empty when it has none. */
export const weaponMoveClips = (weapon: Pick<WeaponSettings, MoveClipField> | null | undefined): Partial<Record<MoveRole, string>> => {
    const clips: Partial<Record<MoveRole, string>> = {};
    if (!weapon) return clips;
    (Object.keys(MOVE_CLIP_FIELDS) as MoveRole[]).forEach(role => {
        const name = clip(weapon[MOVE_CLIP_FIELDS[role]]);
        if (name) clips[role] = name;
    });
    return clips;
};

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
    /** Index of the weapon held; it may not be owned when the player carries nothing yet. */
    active: number;
    /** Which weapons the player carries; Next Weapon skips the others. */
    owned: boolean[];
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

/** Full magazines and reserves for each weapon, holding the first one carried from the start. */
export const createWeaponState = (weapons: readonly ResolvedWeapon[]): WeaponState => ({
    active: Math.max(0, weapons.findIndex(weapon => weapon.startsOwned)),
    owned: weapons.map(weapon => weapon.startsOwned),
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

/** Whether the player holds a weapon they carry (not one they have yet to pick up). */
export const isHoldingWeapon = (state: WeaponState): boolean => state.owned[state.active] === true;

/** Holds weapon `index` (wrapping), cancelling a reload in progress. Returns whether it changed. */
export const switchWeapon = (state: WeaponState, weapons: readonly ResolvedWeapon[], index: number): boolean => {
    if (!weapons.length) return false;
    const next = ((index % weapons.length) + weapons.length) % weapons.length;
    if (next === state.active || !state.owned[next]) return false;
    state.active = next;
    state.reloading = 0;
    state.cooldown = 0;
    state.triggerSpent = false;
    return true;
};

/** Switches to the next carried weapon after the held one, wrapping. */
export const switchToNextWeapon = (state: WeaponState, weapons: readonly ResolvedWeapon[]): boolean => {
    for (let step = 1; step < weapons.length; step += 1) {
        const index = (state.active + step) % weapons.length;
        if (state.owned[index]) return switchWeapon(state, weapons, index);
    }
    return false;
};

/** The weapon a pickup, node or script names: by name (any case) or id; blank is the held one. */
export const findWeapon = (state: WeaponState, weapons: readonly ResolvedWeapon[], name?: string | null): number => {
    const wanted = (name ?? '').trim().toLowerCase();
    if (!wanted) return state.active;
    return weapons.findIndex(weapon => weapon.name.toLowerCase() === wanted || weapon.id.toLowerCase() === wanted);
};

/**
 * Adds `rounds` to a carried weapon's reserve (the held one when `name` is blank). False when there
 * is no such weapon, the player does not carry it, or it never runs out (no magazine, unlimited reserve).
 */
export const addAmmo = (state: WeaponState, weapons: readonly ResolvedWeapon[], rounds: number, name?: string | null): boolean => {
    const index = findWeapon(state, weapons, name);
    const weapon = weapons[index];
    const ammo = state.ammo[index];
    if (!weapon || !ammo || !state.owned[index] || !usesAmmo(weapon) || ammo.reserve < 0) return false;
    const added = Math.max(0, Math.round(rounds));
    if (!added) return false;
    ammo.reserve += added;
    return true;
};

/**
 * Gives the player a weapon by name or id. A new one is carried from now on and taken in hand; one
 * already carried gets a magazine of rounds instead. False when nothing changed.
 */
export const giveWeapon = (state: WeaponState, weapons: readonly ResolvedWeapon[], name: string): boolean => {
    if (!name.trim()) return false;
    const index = findWeapon(state, weapons, name);
    const weapon = weapons[index];
    if (!weapon) return false;
    if (state.owned[index]) return addAmmo(state, weapons, weapon.magazine, weapon.id);
    state.owned[index] = true;
    if (!switchWeapon(state, weapons, index)) {
        // It was the held slot already (the player carried nothing): ready it.
        state.reloading = 0;
        state.cooldown = 0;
    }
    return true;
};

/** A weapon state as a save records it: by weapon id, so edits to the weapon list keep what they can. */
export interface SavedWeapons {
    active: string;
    items: { id: string; owned: boolean; loaded: number; reserve: number }[];
}

export const saveWeapons = (state: WeaponState, weapons: readonly ResolvedWeapon[]): SavedWeapons => ({
    active: weapons[state.active]?.id ?? '',
    items: weapons.map((weapon, index) => ({
        id: weapon.id,
        owned: state.owned[index] === true,
        loaded: state.ammo[index]?.loaded ?? 0,
        reserve: state.ammo[index]?.reserve ?? 0,
    })),
});

/** Puts a saved state back. Weapons the save does not know keep their fresh state; rounds stay within the magazine. */
export const restoreWeapons = (state: WeaponState, weapons: readonly ResolvedWeapon[], saved: SavedWeapons): void => {
    weapons.forEach((weapon, index) => {
        const item = saved.items.find(entry => entry.id === weapon.id);
        if (!item) return;
        state.owned[index] = item.owned;
        state.ammo[index] = {
            loaded: Math.max(0, Math.min(weapon.magazine, Math.round(item.loaded))),
            reserve: weapon.reserve < 0 ? -1 : Math.max(0, Math.round(item.reserve)),
        };
    });
    const active = weapons.findIndex(weapon => weapon.id === saved.active);
    if (active >= 0 && state.owned[active]) state.active = active;
    state.reloading = 0;
    state.cooldown = 0;
    state.warmup = 0;
    state.triggerSpent = false;
};

/** Which weapon is held, whether it is in use (aimed, fired or reloaded just now), and which are carried. */
export interface WeaponPose {
    /** Index of the held weapon; -1 when the player holds none. */
    held: number;
    ready: boolean;
    owned: readonly boolean[];
    /** The held weapon is being reloaded: the reload clip has the other hand. */
    reloading?: boolean;
}

/** Where a weapon's model is drawn: in the hand (its attachment as authored), at its carry placement, or not at all. */
export type WeaponPlacement = 'hand' | 'hidden' | WeaponCarry;

/**
 * Where each weapon's attachment goes for a pose, by attachment id. The held weapon is in the hand
 * while in use and at its carry placement otherwise; a weapon carried but not held sits at its carry
 * placement; weapons the player does not carry, and carried ones without a placement, are hidden.
 */
export const weaponPlacements = (weapons: readonly WeaponSettings[], pose: WeaponPose): Map<string, WeaponPlacement> => {
    const placements = new Map<string, WeaponPlacement>();
    weapons.forEach((weapon, index) => {
        if (!weapon.attachmentId || placements.get(weapon.attachmentId) === 'hand') return;
        const carry = resolveCarry(weapon.carry);
        let placement: WeaponPlacement;
        // A weapon with its own locomotion is carried in the hands the whole time it is held.
        if (index === pose.held) placement = pose.ready || !carry || clip(weapon.idleClip) ? 'hand' : carry;
        else if (pose.owned[index] && carry) placement = carry;
        else placement = 'hidden';
        // Two weapons sharing one model: the held one decides.
        if (!placements.has(weapon.attachmentId) || index === pose.held) placements.set(weapon.attachmentId, placement);
    });
    return placements;
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
    if (input.nextWeaponPressed) result.switched = switchToNextWeapon(state, weapons);
    const weapon = weapons[state.active];
    const ammo = state.ammo[state.active];
    if (!weapon || !ammo || !isHoldingWeapon(state)) return result;

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
