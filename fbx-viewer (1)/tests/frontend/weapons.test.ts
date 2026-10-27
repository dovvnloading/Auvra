import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { spreadDirection } from '../../components/Sandbox/hooks/usePlayerCombat';
import { createWeaponState, DEFAULT_WEAPON, resolveWeapon, resolveWeapons, stepWeapons, type WeaponInput } from '../../runtime/weapons';

const idle: WeaponInput = { firing: false, firePressed: false, reloadPressed: false, nextWeaponPressed: false, firstShotDelay: 0 };
const hold: WeaponInput = { ...idle, firing: true };
const press: WeaponInput = { ...idle, firing: true, firePressed: true };

const pistol = resolveWeapon({ id: 'p', name: 'Pistol', fireMode: 'semi', fireRate: 5, magazine: 3, reserve: 4, reloadSeconds: 1 });
const rifle = resolveWeapon({ id: 'r', name: 'Rifle', fireMode: 'auto', fireRate: 10, magazine: 30, reserve: -1 });

describe('weapons', () => {
  it('fills in a weapon and keeps a blueprint without any on the default', () => {
    expect(resolveWeapons(undefined)).toEqual([DEFAULT_WEAPON]);
    const odd = resolveWeapon({ id: 'x', name: ' ', fireRate: -3, pellets: 99, spread: Number.NaN });
    expect([odd.name, odd.fireRate, odd.pellets, odd.spread]).toEqual(['Weapon', 0.1, 32, 0]);
  });

  it('fires an automatic weapon at its rate while held', () => {
    const weapons = [rifle];
    const state = createWeaponState(weapons);
    let shots = stepWeapons(state, weapons, press, 1 / 60).shots;
    for (let frame = 0; frame < 59; frame += 1) shots += stepWeapons(state, weapons, hold, 1 / 60).shots;
    // One second at 10 a second: the first shot at once, then one every 0.1 s.
    expect(shots).toBe(10);
    expect(state.ammo[0].loaded).toBe(20);
  });

  it('fires a semi-automatic weapon once per press', () => {
    const weapons = [pistol];
    const state = createWeaponState(weapons);
    let shots = stepWeapons(state, weapons, press, 0.5).shots;
    shots += stepWeapons(state, weapons, hold, 0.5).shots;
    expect(shots).toBe(1);
    stepWeapons(state, weapons, idle, 0.1);
    expect(stepWeapons(state, weapons, press, 0.1).shots).toBe(1);
  });

  it('reloads from the reserve, on its own when empty, and stops when the reserve runs out', () => {
    const weapons = [pistol];
    const state = createWeaponState(weapons);
    for (let shot = 0; shot < 3; shot += 1) {
      stepWeapons(state, weapons, press, 0.3);
      stepWeapons(state, weapons, idle, 0.3);
    }
    expect(state.ammo[0].loaded).toBe(0);
    // Pulling the trigger on an empty magazine starts the reload; no shot comes out.
    const empty = stepWeapons(state, weapons, press, 0.1);
    expect([empty.shots, empty.reloadStarted]).toEqual([0, true]);
    stepWeapons(state, weapons, idle, 1);
    expect(state.ammo[0]).toEqual({ loaded: 3, reserve: 1 });
    // Firing once and reloading takes the last round from the reserve.
    stepWeapons(state, weapons, press, 0.3);
    stepWeapons(state, weapons, { ...idle, reloadPressed: true }, 0.1);
    stepWeapons(state, weapons, idle, 1);
    expect(state.ammo[0]).toEqual({ loaded: 3, reserve: 0 });
    stepWeapons(state, weapons, press, 0.3);
    expect(stepWeapons(state, weapons, { ...idle, reloadPressed: true }, 0.1).reloadStarted).toBe(false);
  });

  it('switches weapons, keeping each one\'s ammunition and cancelling a reload', () => {
    const weapons = [pistol, rifle];
    const state = createWeaponState(weapons);
    stepWeapons(state, weapons, press, 0.1);
    stepWeapons(state, weapons, { ...idle, reloadPressed: true }, 0.1);
    expect(state.reloading).toBeGreaterThan(0);
    expect(stepWeapons(state, weapons, { ...idle, nextWeaponPressed: true }, 0.1).switched).toBe(true);
    expect([state.active, state.reloading]).toEqual([1, 0]);
    stepWeapons(state, weapons, { ...idle, nextWeaponPressed: true }, 0.1);
    expect([state.active, state.ammo[0].loaded]).toEqual([0, 2]);
  });

  it('holds the first shot of a press for the hip-fire pose', () => {
    const weapons = [rifle];
    const state = createWeaponState(weapons);
    expect(stepWeapons(state, weapons, { ...press, firstShotDelay: 0.1 }, 0.05).shots).toBe(0);
    expect(stepWeapons(state, weapons, hold, 0.05).shots).toBe(0);
    expect(stepWeapons(state, weapons, hold, 0.05).shots).toBe(1);
  });

  it('strays a shot by up to the spread, and not at all without one', () => {
    const forward = () => new THREE.Vector3(0, 0, -1);
    expect(spreadDirection(forward(), 0)).toEqual(forward());
    let widest = 0;
    for (let shot = 0; shot < 200; shot += 1) {
      const angle = THREE.MathUtils.radToDeg(spreadDirection(forward(), 5).angleTo(forward()));
      expect(angle).toBeLessThanOrEqual(5 + 1e-6);
      widest = Math.max(widest, angle);
    }
    expect(widest).toBeGreaterThan(3);
    // The largest draw lands right on the edge of the cone.
    expect(THREE.MathUtils.radToDeg(spreadDirection(forward(), 5, () => 1).angleTo(forward()))).toBeCloseTo(5, 5);
  });
});
