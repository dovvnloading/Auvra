import { describe, expect, it } from 'vitest';
import {
  createWeaponState, isHoldingWeapon, resolveWeapon, restoreWeapons, stepWeapons, type SavedWeapons, type WeaponInput,
} from '../../runtime/weapons';

const weapons = [
  resolveWeapon({ id: 'pistol', name: 'Pistol', startsOwned: true, fireMode: 'semi', magazine: 6, reserve: 12 }),
  resolveWeapon({ id: 'rifle', name: 'Rifle', startsOwned: false, fireMode: 'auto', magazine: 10, reserve: 20 }),
];
const press: WeaponInput = {
  firing: true, firePressed: true, reloadPressed: false, nextWeaponPressed: false, firstShotDelay: 0,
};

const saved = (active: string, pistolOwned: boolean, rifleOwned: boolean): SavedWeapons => ({
  active,
  items: [
    { id: 'pistol', owned: pistolOwned, loaded: 3, reserve: 4 },
    { id: 'rifle', owned: rifleOwned, loaded: 7, reserve: 9 },
  ],
});

describe('restoring a saved weapon selection', () => {
  it('equips a carried weapon when the saved active ID was removed from the blueprint', () => {
    const state = createWeaponState(weapons);
    expect(state.active).toBe(0); // New blueprint defaults to the pistol.

    restoreWeapons(state, weapons, saved('retired-weapon', false, true));

    expect(state.owned).toEqual([false, true]);
    expect(state.active).toBe(1);
    expect(isHoldingWeapon(state)).toBe(true);
    expect(stepWeapons(state, weapons, press, 1 / 60).shots).toBe(1);
    expect(state.ammo[1]).toEqual({ loaded: 6, reserve: 9 });
  });

  it('does not select a saved active weapon that is now explicitly unowned', () => {
    const state = createWeaponState(weapons);
    restoreWeapons(state, weapons, saved('pistol', false, true));

    expect(state.active).toBe(1);
    expect(isHoldingWeapon(state)).toBe(true);
    expect(state.ammo[0]).toEqual({ loaded: 3, reserve: 4 });
  });

  it('preserves a valid saved selection over the first owned weapon', () => {
    const state = createWeaponState(weapons);
    restoreWeapons(state, weapons, saved('rifle', true, true));

    expect(state.owned).toEqual([true, true]);
    expect(state.active).toBe(1);
    expect(state.ammo[1]).toEqual({ loaded: 7, reserve: 9 });
  });

  it('considers new blueprint weapons not present in the save when choosing a fallback', () => {
    const extended = [
      ...weapons,
      resolveWeapon({ id: 'new', name: 'New weapon', startsOwned: true, magazine: 2 }),
    ];
    const state = createWeaponState(extended);
    // The older save knows only the pistol, which is no longer carried.
    restoreWeapons(state, extended, { active: 'removed', items: [saved('', false, false).items[0]] });

    expect(state.owned).toEqual([false, false, true]);
    expect(state.active).toBe(2);
    expect(isHoldingWeapon(state)).toBe(true);
  });

  it('keeps a safe unarmed state when no saved or new weapon is owned', () => {
    const state = createWeaponState(weapons);
    restoreWeapons(state, weapons, saved('rifle', false, false));

    expect(state.owned).toEqual([false, false]);
    expect(state.active).toBe(0); // Matches createWeaponState's no-weapon fallback.
    expect(isHoldingWeapon(state)).toBe(false);
    expect(stepWeapons(state, weapons, press, 1 / 60).shots).toBe(0);
  });
});
