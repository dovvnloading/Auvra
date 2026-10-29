import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ABILITY_PRESET_IDS, ABILITY_PRESETS, AbilitySystem, DEAD_TAG, INVULNERABLE_TAG, abilityActors, abilityBus, clearStandIns, damageActor,
  damageAfterArmor, pickAbilityTarget, resolveAbilitySet, sanitizeAbilitySet, standInFor, stepStandIns, type AbilityCharacter,
} from '../../runtime/abilities';
import { flowNodeOutputValue, type FlowNode } from '../../hooks/levelBlueprintNodes/flow';
import { WORLD_NODE_DEFINITIONS, WORLD_NODE_EXECUTORS, type WorldNodeServices, type WorldNodeType } from '../../hooks/levelBlueprintNodes/world';
import { abilityEventMatches } from '../../hooks/useLevelBlueprintRuntime';
import { createLevelVariablesStore } from '../../runtime/levelVariables';
import { parseScriptCommand, scriptActorStates } from '../../runtime/scripting/ScriptRuntime';
import { createScriptHost, isScriptSnapshot } from '../../runtime/scripting/scriptApi';
import type { ScriptSnapshot } from '../../runtime/scripting/protocol';
import type { LogicNode } from '../../types';

/*
 * Abilities in the play session: weapons and blasts on actors, stand-ins for characters without the
 * component, what an ability aims at, the presets, and the level script nodes, events and gameplay
 * script API that reach them.
 */

const released: Array<() => void> = [];
afterEach(() => {
  while (released.length) released.pop()!();
  clearStandIns();
});

const placed = (id: string, set = ABILITY_PRESETS.target, at = { x: 0, y: 0, z: 0 }) => {
  const actor = new AbilitySystem(id, set);
  actor.locate = () => at;
  released.push(abilityActors.register('runtime', actor));
  return actor;
};

const character = (id: string, at: { x: number; y: number; z: number }, team: 'Player' | 'Enemy' = 'Enemy') => {
  const hurt: number[] = [];
  const healed: number[] = [];
  const entry: AbilityCharacter = {
    id, team, centre: () => at, isDead: () => false,
    damage: amount => { hurt.push(amount); }, heal: amount => { healed.push(amount); },
  };
  return { entry, hurt, healed };
};

describe('damage and death', () => {
  it('takes damage off health less armour, never on the invulnerable or the dead', () => {
    expect(damageAfterArmor(100, 0)).toBe(100);
    expect(damageAfterArmor(100, 100)).toBe(50);
    expect(damageAfterArmor(100, -50)).toBe(100);
    const fighter = new AbilitySystem('f', ABILITY_PRESETS.fighter);
    expect(damageActor(fighter, 60)).toBe(true);
    // 20 armour: 60 becomes 50.
    expect(fighter.get('health')).toBe(100);
    fighter.addTag(INVULNERABLE_TAG);
    expect(damageActor(fighter, 60)).toBe(false);
    fighter.removeTag(INVULNERABLE_TAG);
    fighter.addTag(DEAD_TAG);
    expect(damageActor(fighter, 60)).toBe(false);
    expect(damageActor(new AbilitySystem('none', sanitizeAbilitySet({})), 10)).toBe(false);
  });

  it('finds actors in reach of a blast', () => {
    placed('near', ABILITY_PRESETS.target, { x: 1, y: 0, z: 0 });
    placed('far', ABILITY_PRESETS.target, { x: 30, y: 0, z: 0 });
    const hit = abilityActors.within('runtime', { x: 0, y: 0, z: 0 }, 5);
    expect(hit.map(entry => entry.actor.id)).toEqual(['near']);
    expect(hit[0].distance).toBe(1);
  });
});

describe('stand-ins for characters', () => {
  it('pass health changes on as damage and healing, and go once nothing lasts on them', () => {
    const { entry, hurt, healed } = character('enemy-1', { x: 0, y: 0, z: 5 });
    const stand = standInFor(entry);
    expect(standInFor(entry)).toBe(stand);
    const mage = new AbilitySystem('mage', ABILITY_PRESETS.mage);
    expect(stand.applyEffect('fireballHit', mage)).toBe(true);
    expect(hurt).toEqual([25]);
    stand.applyEffect('burning', mage);
    for (let i = 0; i < 4; i++) stepStandIns(1);
    expect(hurt).toEqual([25, 4, 4, 4, 4]);
    stand.applyEffect('heal', mage);
    expect(healed).toEqual([30]);
    stepStandIns(0.1);
    // Nothing lasting: let go, and a new stand-in is made next time.
    expect(standInFor(entry)).not.toBe(stand);
  });
});

describe('aiming', () => {
  it('takes what is nearest the middle of the view, within range, never the user or its own team', () => {
    const user = placed('player', ABILITY_PRESETS.mage, { x: 0, y: 0, z: 0 });
    const ahead = placed('ahead', ABILITY_PRESETS.target, { x: 0.5, y: 0, z: -10 });
    placed('aside', ABILITY_PRESETS.target, { x: 8, y: 0, z: -10 });
    placed('beyond', ABILITY_PRESETS.target, { x: 0, y: 0, z: -60 });
    const ally = character('ally', { x: 0, y: 0, z: -5 }, 'Player');
    const enemy = character('enemy', { x: -0.2, y: 0, z: -6 });
    const pick = (characters: AbilityCharacter[], range = 40) => pickAbilityTarget({
      user, from: { x: 0, y: 0, z: 0 }, eye: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: -1 }, range,
      actors: abilityActors.all('runtime'), characters, ownTeam: 'Player',
    });
    expect(pick([])).toBe(ahead);
    // The enemy is better aimed at; the ally is never taken.
    const target = pick([ally.entry, enemy.entry]);
    expect(target?.id).toBe('enemy');
    expect(pick([], 5)).toBeNull();
  });
});

describe('presets', () => {
  it('resolve from a preset or the component\'s own set, and use every effect they name', () => {
    expect(resolveAbilitySet({ preset: 'mage' })).toBe(ABILITY_PRESETS.mage);
    expect(resolveAbilitySet({})).toBe(ABILITY_PRESETS.fighter);
    const own = resolveAbilitySet({ abilities: { attributes: [{ name: 'focus', base: 3 }] } });
    expect(own.attributes.map(attribute => attribute.name)).toEqual(['focus']);
    for (const id of ABILITY_PRESET_IDS) {
      const set = ABILITY_PRESETS[id];
      const effects = new Set(set.effects.map(effect => effect.id));
      for (const ability of set.abilities) for (const effect of [...ability.selfEffects, ...ability.targetEffects]) expect(effects.has(effect)).toBe(true);
      for (const effect of set.startEffects) expect(effects.has(effect)).toBe(true);
    }
  });
});

describe('abilities in level scripts', () => {
  const run = (type: WorldNodeType, inputs: Record<string, unknown>, extra: Partial<WorldNodeServices>) => {
    const definition = WORLD_NODE_DEFINITIONS.find(d => d.type === type)!;
    const node: FlowNode = {
      id: type, type,
      inputs: definition.inputs.map((pin, i) => ({ ...pin, id: `in-${i}` })),
      outputs: definition.outputs.map((pin, i) => ({ ...pin, id: `out-${i}` })),
      data: { ...definition.data },
    };
    const nodeState: Record<string, unknown> = {};
    const services: WorldNodeServices = {
      spawnPrefab: () => [], playSound: () => undefined, getObject: () => null, setObjectTransform: () => undefined,
      applyImpulse: () => undefined, raycast: () => null, input: { isDown: () => false },
      vars: createLevelVariablesStore(() => {}), print: () => undefined, ...extra,
    };
    WORLD_NODE_EXECUTORS[type]!(node, {
      evaluate: name => (name in inputs ? inputs[name] : node.data?.[`default_${name}`] ?? null),
      fire: () => undefined, schedule: () => undefined, nodeState, services,
    });
    return (pin: string) => flowNodeOutputValue(nodeState, pin);
  };

  it('uses abilities, applies and removes effects and changes attributes and tags', () => {
    const useAbility = vi.fn((_actor: string, ability: string) => (ability === 'fireball' ? null : 'cooldown'));
    const used = run('UseAbility', { Actor: 'player', Ability: 'fireball', Target: '' }, { useAbility });
    expect(useAbility).toHaveBeenCalledWith('player', 'fireball', null);
    expect([used('Used'), used('Reason')]).toEqual([true, '']);
    const refused = run('UseAbility', { Actor: 'player', Ability: 'heal' }, { useAbility });
    expect([refused('Used'), refused('Reason')]).toEqual([false, 'cooldown']);
    expect(run('UseAbility', { Actor: '', Ability: 'heal' }, { useAbility })('Reason')).toBe('unknown');

    const applyEffect = vi.fn(() => true);
    expect(run('ApplyEffect', { Target: 'dummy', Effect: 'burning', Source: 'player' }, { applyEffect })('Applied')).toBe(true);
    expect(applyEffect).toHaveBeenCalledWith('dummy', 'burning', 'player');
    expect(run('RemoveEffect', { Actor: 'dummy', Effect: 'burning' }, { removeEffect: () => true })('Removed')).toBe(true);

    const attribute = run('GetAttribute', { Actor: 'player', Attribute: 'mana' }, { attribute: () => ({ value: 60, base: 50, max: 100 }) });
    expect([attribute('Has'), attribute('Value'), attribute('Base'), attribute('Max')]).toEqual([true, 60, 50, 100]);
    expect(run('GetAttribute', { Actor: 'player', Attribute: 'rage' }, { attribute: () => null })('Has')).toBe(false);
    const changeAttribute = vi.fn(() => 40);
    expect(run('ChangeAttribute', { Actor: 'player', Attribute: 'mana', Amount: -20, Set: false }, { changeAttribute })('Value')).toBe(40);
    expect(changeAttribute).toHaveBeenCalledWith('player', 'mana', -20, false);

    expect(run('HasTag', { Actor: 'player', Tag: 'State' }, { hasTag: () => true })('Has Tag')).toBe(true);
    const setTag = vi.fn(() => true);
    run('AddTag', { Actor: 'player', Tag: 'State.Shielded' }, { setTag });
    run('RemoveTag', { Actor: 'player', Tag: 'State.Shielded' }, { setTag });
    expect(setTag.mock.calls).toEqual([['player', 'State.Shielded', true], ['player', 'State.Shielded', false]]);
    const cooldown = run('GetAbilityCooldown', { Actor: 'player', Ability: 'fireball' }, { abilityCooldown: () => 0 });
    expect([cooldown('Cooldown'), cooldown('Ready')]).toEqual([0, true]);
    expect(run('GetAbilityCooldown', { Actor: 'player', Ability: 'nope' }, { abilityCooldown: () => null })('Ready')).toBe(false);
  });

  it('runs Ability Used and Actor Died events for their actor and ability, or any', () => {
    const node = (name: string, data: Record<string, string>) => ({ id: 'e', type: 'Event', name, inputs: [], outputs: [], data, position: { x: 0, y: 0 } }) as unknown as LogicNode;
    const used = { type: 'activated', actor: 'player', ability: 'fireball', target: 'dummy' } as const;
    const died = { type: 'died', actor: 'dummy' } as const;
    expect(abilityEventMatches(node('Event AbilityUsed', { actorId: '', abilityId: '' }), used)).toBe(true);
    expect(abilityEventMatches(node('Event AbilityUsed', { actorId: 'player', abilityId: 'fireball' }), used)).toBe(true);
    expect(abilityEventMatches(node('Event AbilityUsed', { actorId: 'player', abilityId: 'heal' }), used)).toBe(false);
    expect(abilityEventMatches(node('Event AbilityUsed', { actorId: 'dummy' }), used)).toBe(false);
    expect(abilityEventMatches(node('Event AbilityUsed', {}), died)).toBe(false);
    expect(abilityEventMatches(node('Event ActorDied', { actorId: 'dummy' }), died)).toBe(true);
    expect(abilityEventMatches(node('Event ActorDied', { actorId: '' }), used)).toBe(false);
    const heard: string[] = [];
    const off = abilityBus.on(event => heard.push(event.type));
    abilityBus.emit(died);
    off();
    abilityBus.emit(died);
    expect(heard).toEqual(['died']);
  });
});

describe('abilities in gameplay scripts', () => {
  it('reads actors from the snapshot and changes them through validated commands', () => {
    const dummy = placed('dummy');
    dummy.applyEffect('mend');
    const states = scriptActorStates()!;
    expect(states.dummy).toMatchObject({ attributes: { health: 500, maxHealth: 500 }, max: { health: 500 }, tags: ['Role.Target'], effects: ['mend'] });

    const snapshot = (frame: number): ScriptSnapshot => ({
      frame, time: 0, delta: 0.1, objects: [{ id: 'dummy', name: 'dummy', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], parentId: null, visible: true }],
      player: null, input: {}, variables: {}, events: [], raycasts: {},
      net: { connected: false, isHost: true, selfId: null, peers: [] },
      actors: {
        player: { attributes: { mana: 30 }, max: { mana: 100 }, tags: ['Class.Mage'], cooldowns: { fireball: 0 }, effects: [] },
        dummy: { attributes: { health: 500 }, max: { health: 500 }, tags: ['State.Burning'], cooldowns: {}, effects: ['burning'] },
      },
    });
    expect(isScriptSnapshot(snapshot(0))).toBe(true);
    expect(isScriptSnapshot({ ...snapshot(0), actors: { dummy: { attributes: { health: 'full' } } } })).toBe(false);
    const host = createScriptHost();
    host.load([{
      id: 's', objectId: 'dummy',
      source: `function onUpdate(ctx) {
        const a = ctx.abilities;
        if (a.attribute('player', 'mana') < 50 && a.hasTag('dummy', 'State') && a.cooldown('player', 'fireball') === 0 && a.actors().length === 2) {
          a.use('player', 'fireball', 'dummy');
          a.applyEffect('dummy', 'frostHit', 'player');
          a.removeEffect('dummy', 'burning');
          a.addAttribute('player', 'mana', 25);
          a.setAttribute('dummy', 'health', 1);
          a.addTag('dummy', 'State.Marked');
          a.removeTag('dummy', 'State.Marked');
        }
      }`,
    }], source => source, snapshot(0));
    const commands = host.frame(snapshot(1)).filter(command => command.type !== 'log');
    expect(commands).toEqual([
      { type: 'useAbility', actorId: 'player', abilityId: 'fireball', targetId: 'dummy' },
      { type: 'applyEffect', targetId: 'dummy', effectId: 'frostHit', sourceId: 'player' },
      { type: 'removeEffect', actorId: 'dummy', effectId: 'burning' },
      { type: 'changeAttribute', actorId: 'player', attribute: 'mana', amount: 25, set: false },
      { type: 'changeAttribute', actorId: 'dummy', attribute: 'health', amount: 1, set: true },
      { type: 'setTag', actorId: 'dummy', tag: 'State.Marked', on: true },
      { type: 'setTag', actorId: 'dummy', tag: 'State.Marked', on: false },
    ]);
    for (const command of commands) expect(parseScriptCommand(command)).toEqual(command);
    expect(parseScriptCommand({ type: 'setTag', actorId: 'dummy', tag: 'bad tag', on: true })).toBeNull();
    expect(parseScriptCommand({ type: 'useAbility', actorId: 'player', abilityId: '', targetId: null })).toBeNull();
    expect(parseScriptCommand({ type: 'changeAttribute', actorId: 'player', attribute: 'mana', amount: Number.NaN, set: false })).toBeNull();
  });
});
