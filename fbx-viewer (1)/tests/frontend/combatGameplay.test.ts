import { afterEach, describe, expect, it, vi } from 'vitest';
import { flowNodeOutputValue, type FlowNode } from '../../hooks/levelBlueprintNodes/flow';
import { WORLD_NODE_DEFINITIONS, WORLD_NODE_EXECUTORS, type WorldNodeServices, type WorldNodeType } from '../../hooks/levelBlueprintNodes/world';
import { startingHealth } from '../../components/Sandbox/hooks/useEntityHealth';
import { applyPickup, readPickupSettings } from '../../runtime/components/pickupComponent';
import { createLevelVariablesStore } from '../../runtime/levelVariables';
import { playerActions } from '../../runtime/playerActions';
import { isSaveGameData } from '../../runtime/saveGame';
import { parseScriptCommand } from '../../runtime/scripting/ScriptRuntime';
import {
  addAmmo, createWeaponState, giveWeapon, resolveWeapon, restoreWeapons, saveWeapons, stepWeapons, type WeaponInput,
} from '../../runtime/weapons';

const idle: WeaponInput = { firing: false, firePressed: false, reloadPressed: false, nextWeaponPressed: false, firstShotDelay: 0 };
const next: WeaponInput = { ...idle, nextWeaponPressed: true };
const press: WeaponInput = { ...idle, firing: true, firePressed: true };

const pistol = resolveWeapon({ id: 'p', name: 'Pistol', fireMode: 'semi', magazine: 12, reserve: 24 });
const rifle = resolveWeapon({ id: 'r', name: 'Rifle', magazine: 30, reserve: 60, startsOwned: false });
const knife = resolveWeapon({ id: 'k', name: 'Knife', magazine: 0, reserve: -1 });

describe('weapons the player carries', () => {
  it('starts with the weapons carried from the start and skips the others when switching', () => {
    const weapons = [pistol, rifle, knife];
    const state = createWeaponState(weapons);
    expect(state.owned).toEqual([true, false, true]);
    stepWeapons(state, weapons, next, 0.1);
    expect(state.active).toBe(2);
    stepWeapons(state, weapons, next, 0.1);
    expect(state.active).toBe(0);
  });

  it('holds nothing and fires nothing until a weapon is given, then takes it in hand', () => {
    const weapons = [rifle];
    const state = createWeaponState(weapons);
    expect(stepWeapons(state, weapons, press, 0.1).shots).toBe(0);
    expect(giveWeapon(state, weapons, 'rifle')).toBe(true);
    expect(stepWeapons(state, weapons, press, 0.1).shots).toBe(1);
  });

  it('gives a carried weapon a magazine and takes rounds only for weapons that use them', () => {
    const weapons = [pistol, rifle, knife];
    const state = createWeaponState(weapons);
    expect(giveWeapon(state, weapons, 'Pistol')).toBe(true);
    expect(state.ammo[0].reserve).toBe(36);
    expect(giveWeapon(state, weapons, 'Rifle')).toBe(true);
    expect([state.active, state.owned[1]]).toEqual([1, true]);
    expect(addAmmo(state, weapons, 10)).toBe(true);
    expect(state.ammo[1].reserve).toBe(70);
    expect(addAmmo(state, weapons, 5, 'knife')).toBe(false);
    expect(addAmmo(state, weapons, 5, 'missing')).toBe(false);
    expect(giveWeapon(state, weapons, ' ')).toBe(false);
  });

  it('saves and restores what is carried, held and loaded, kept within the magazine', () => {
    const weapons = [pistol, rifle];
    const state = createWeaponState(weapons);
    giveWeapon(state, weapons, 'Rifle');
    state.ammo[1].loaded = 7;
    const saved = saveWeapons(state, weapons);
    const fresh = createWeaponState(weapons);
    restoreWeapons(fresh, weapons, { ...saved, items: saved.items.map(item => (item.id === 'p' ? { ...item, loaded: 99 } : item)) });
    expect([fresh.active, fresh.owned, fresh.ammo[1].loaded, fresh.ammo[0].loaded]).toEqual([1, [true, true], 7, 12]);
  });
});

describe('player actions', () => {
  afterEach(() => vi.restoreAllMocks());

  it('do nothing until registered, ignore amounts that are not above 0, and unregister only their own handlers', () => {
    expect(playerActions.heal(10)).toBe(false);
    const heal = vi.fn(() => true);
    const off = playerActions.register({ heal });
    expect(playerActions.heal(0)).toBe(false);
    expect(playerActions.heal(10)).toBe(true);
    const other = playerActions.register({ heal: () => false });
    off();
    expect(playerActions.heal(10)).toBe(false);
    other();
    expect(heal).toHaveBeenCalledTimes(1);
  });

  it('route pickups by what they give', () => {
    const handlers = { heal: vi.fn(() => true), addAmmo: vi.fn(() => true), giveWeapon: vi.fn(() => true) };
    const off = playerActions.register(handlers);
    const pickup = (props: Record<string, unknown>) => readPickupSettings({ id: 'c', type: 'pickup', enabled: true, props });
    applyPickup(pickup({ kind: 'health', amount: 30 }));
    applyPickup(pickup({ kind: 'ammo', amount: 12.4, weapon: ' Rifle ' }));
    applyPickup(pickup({ kind: 'weapon', weapon: 'Shotgun' }));
    expect(pickup({ kind: 'bogus', radius: -4 })).toMatchObject({ kind: 'health', radius: 0.1, respawn: 0 });
    off();
    expect(handlers.heal).toHaveBeenCalledWith(30);
    expect(handlers.addAmmo).toHaveBeenCalledWith(12, 'Rifle');
    expect(handlers.giveWeapon).toHaveBeenCalledWith('Shotgun');
  });
});

describe('player nodes', () => {
  const services = (extra: Partial<WorldNodeServices>): WorldNodeServices => ({
    spawnPrefab: () => [], playSound: () => undefined, getObject: () => null, setObjectTransform: () => undefined,
    applyImpulse: () => undefined, raycast: () => null, input: { isDown: () => false },
    vars: createLevelVariablesStore(() => {}), print: () => undefined, ...extra,
  });
  const run = (type: WorldNodeType, inputs: Record<string, unknown>, svc: WorldNodeServices) => {
    const definition = WORLD_NODE_DEFINITIONS.find(entry => entry.type === type)!;
    const node: FlowNode = {
      id: 'n', type, data: { ...definition.data },
      inputs: definition.inputs.map((pin, i) => ({ ...pin, id: `in-${i}` })),
      outputs: definition.outputs.map((pin, i) => ({ ...pin, id: `out-${i}` })),
    };
    const nodeState: Record<string, unknown> = {};
    const fired: unknown[] = [];
    WORLD_NODE_EXECUTORS[type]!(node, {
      evaluate: pin => (pin in inputs ? inputs[pin] : node.data?.[`default_${pin}`] ?? null),
      fire: (pin, data) => fired.push([pin, data]),
      schedule: () => undefined,
      nodeState,
      services: svc,
    });
    return { fired, out: (pin: string) => flowNodeOutputValue(nodeState, pin) };
  };

  it('damage, heal, add ammo and give weapons through the services', () => {
    const damagePlayer = vi.fn(() => true);
    const healPlayer = vi.fn(() => false);
    const addAmmo = vi.fn(() => true);
    const giveWeapon = vi.fn(() => true);
    const svc = services({ damagePlayer, healPlayer, addAmmo, giveWeapon });
    expect(run('DamagePlayer', { Amount: 15 }, svc).fired).toEqual([['Out', { Damaged: true }]]);
    expect(run('HealPlayer', {}, svc).fired).toEqual([['Out', { Healed: false }]]);
    expect(run('AddAmmo', { Rounds: '20', Weapon: ' Rifle ' }, svc).fired).toEqual([['Out', { Added: true }]]);
    expect(run('GiveWeapon', { Weapon: '' }, svc).fired).toEqual([['Out', { Given: false }]]);
    expect(run('DamagePlayer', { Amount: -5 }, svc).fired).toEqual([['Out', { Damaged: false }]]);
    expect([damagePlayer.mock.calls, healPlayer.mock.calls, addAmmo.mock.calls, giveWeapon.mock.calls])
      .toEqual([[[15]], [[25]], [[20, 'Rifle']], []]);
  });

  it('read the player health, zero without a player', () => {
    const node = run('GetPlayerHealth', {}, services({ playerHealth: () => ({ health: 30, max: 120 }) }));
    expect([node.out('Health'), node.out('Max'), node.out('Fraction')]).toEqual([30, 120, 0.25]);
    const none = run('GetPlayerHealth', {}, services({ playerHealth: () => null }));
    expect([none.out('Health'), none.out('Fraction')]).toEqual([0, 0]);
  });
});

describe('player script commands', () => {
  it('accept player commands with an amount above 0 and a weapon name', () => {
    expect(parseScriptCommand({ type: 'damagePlayer', amount: 5 })).toEqual({ type: 'damagePlayer', amount: 5 });
    expect(parseScriptCommand({ type: 'healPlayer', amount: 0 })).toBeNull();
    expect(parseScriptCommand({ type: 'addAmmo', rounds: 9.6, weapon: 'Rifle' })).toEqual({ type: 'addAmmo', rounds: 10, weapon: 'Rifle' });
    expect(parseScriptCommand({ type: 'addAmmo', rounds: 9, extra: 1 })).toBeNull();
    expect(parseScriptCommand({ type: 'giveWeapon', weapon: '' })).toBeNull();
    expect(parseScriptCommand({ type: 'giveWeapon', weapon: 'Rifle' })).toEqual({ type: 'giveWeapon', weapon: 'Rifle' });
  });
});

describe('saved player state', () => {
  const save = (weapons: unknown) => ({
    schema: 1, gameId: 'g', slot: 'auto', savedAt: '', levelId: 'l', destroyedObjectIds: [], variables: {},
    player: { position: [0, 0, 0], rotation: [0, 0, 0], health: 40, stamina: 100, ...(weapons === undefined ? {} : { weapons }) },
  });

  it('keeps older saves without weapons and checks the weapons a save has', () => {
    expect(isSaveGameData(save(undefined))).toBe(true);
    expect(isSaveGameData(save({ active: 'p', items: [{ id: 'p', owned: true, loaded: 3, reserve: 9 }] }))).toBe(true);
    expect(isSaveGameData(save({ active: 'p', items: [{ id: 'p', owned: 'yes', loaded: 3, reserve: 9 }] }))).toBe(false);
  });

  it('starts from saved health kept within 1 and the maximum', () => {
    expect([startingHealth(100), startingHealth(100, 40), startingHealth(100, 0), startingHealth(100, 500)]).toEqual([100, 40, 1, 100]);
  });
});
