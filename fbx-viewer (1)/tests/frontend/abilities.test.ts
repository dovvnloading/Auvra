import { describe, expect, it } from 'vitest';
import {
  AbilitySystem, TagSet, abilityActors, isTag, sanitizeAbilitySet, tagMatches, type AbilityEvent, type AbilitySetDefinition,
} from '../../runtime/abilities';

/*
 * The ability system on its own: tags, attributes and their modifiers, instant, lasting and periodic
 * effects, abilities with costs, cooldowns and tag rules, and the actor registry.
 */

const set = (value: unknown): AbilitySetDefinition => sanitizeAbilitySet(value);

/** A fighter: health within max health, mana that regenerates, a fireball, a heal, a burn, a stun. */
const fighter = () => set({
  attributes: [
    { name: 'maxHealth', base: 100 },
    { name: 'health', base: 100, min: 0, max: 'maxHealth' },
    { name: 'mana', base: 50, min: 0, max: 50, regen: 10, regenDelay: 1 },
    { name: 'speed', base: 5 },
  ],
  effects: [
    { id: 'fireballHit', duration: 'instant', modifiers: [{ attribute: 'health', operation: 'add', value: -30 }] },
    { id: 'burning', duration: 'timed', seconds: 3, period: 1, modifiers: [{ attribute: 'health', operation: 'add', value: -5 }], grantedTags: ['State.Burning'], stacking: 'stack', maxStacks: 3 },
    { id: 'haste', duration: 'timed', seconds: 4, modifiers: [{ attribute: 'speed', operation: 'multiply', value: 0.5 }], grantedTags: ['State.Hasted'] },
    { id: 'stun', duration: 'timed', seconds: 2, grantedTags: ['State.Stunned'], blockedTags: ['State.Immune'], stacking: 'none' },
    { id: 'fortify', duration: 'infinite', modifiers: [{ attribute: 'maxHealth', operation: 'add', value: 50 }] },
    { id: 'cleanse', duration: 'instant', removeEffectsWithTags: ['State'] },
  ],
  abilities: [
    { id: 'fireball', costs: [{ attribute: 'mana', amount: 20 }], cooldown: 2, blockedTags: ['State.Stunned'], targetEffects: ['fireballHit', 'burning'], range: 30 },
    { id: 'channel', activeTime: 1.5, activeTags: ['Ability.Channel'] },
    { id: 'interrupt', cancelTags: ['Ability.Channel'] },
    { id: 'hasteSelf', selfEffects: ['haste'], requiredTags: ['Class.Mage'] },
  ],
  tags: ['Class.Mage'],
});

describe('tags', () => {
  it('match themselves and the tags above them', () => {
    expect(isTag('State.Stunned')).toBe(true);
    expect(isTag('State..Stunned')).toBe(false);
    expect(isTag('has space')).toBe(false);
    expect(tagMatches('State.Stunned', 'State')).toBe(true);
    expect(tagMatches('State.Stunned', 'State.Stunned')).toBe(true);
    expect(tagMatches('Stately', 'State')).toBe(false);
    expect(tagMatches('State', 'State.Stunned')).toBe(false);
  });

  it('are counted, so a tag granted twice stays until both go', () => {
    const tags = new TagSet();
    tags.add('State.Burning');
    tags.add('State.Burning');
    tags.remove('State.Burning');
    expect(tags.has('State')).toBe(true);
    tags.remove('State.Burning');
    expect(tags.has('State')).toBe(false);
    tags.add('A.B');
    tags.add('C');
    expect(tags.hasAll(['A', 'C'])).toBe(true);
    expect(tags.hasAny(['D', 'A.B'])).toBe(true);
    expect(tags.list()).toEqual(['A.B', 'C']);
  });
});

describe('ability sets', () => {
  it('drop malformed entries, keep names unique and fields in range', () => {
    const clean = set({
      attributes: [{ name: 'health', base: 'x', regen: Number.NaN }, { name: 'health', base: 5 }, { name: '9bad' }, null],
      effects: [{ id: 'e', duration: 'forever', stacking: 'pile', maxStacks: 500, grantedTags: ['ok.Tag', 'bad tag'] }, { name: 'no id' }],
      abilities: [{ id: 'a', cooldown: -3, costs: [{ attribute: 'mana', amount: -2 }, { attribute: '' }] }],
      tags: ['Start', 7],
    });
    expect(clean.attributes).toEqual([{ name: 'health', base: 100, min: 0, max: 1e9, regen: 0, regenDelay: 0 }]);
    expect(clean.effects[0]).toMatchObject({ duration: 'instant', stacking: 'refresh', maxStacks: 99, grantedTags: ['ok.Tag'] });
    expect(clean.effects).toHaveLength(1);
    expect(clean.abilities[0]).toMatchObject({ cooldown: 0, costs: [{ attribute: 'mana', amount: 0 }] });
    expect(clean.tags).toEqual(['Start']);
    expect(set(null)).toEqual({ attributes: [], effects: [], abilities: [], tags: [], startEffects: [] });
  });
});

describe('attributes and effects', () => {
  it('clamps attributes, including to another attribute', () => {
    const actor = new AbilitySystem('a', fighter());
    actor.addBase('health', 500);
    expect(actor.get('health')).toBe(100);
    actor.addBase('health', -250);
    expect(actor.get('health')).toBe(0);
    expect(actor.get('missing')).toBeNull();
  });

  it('changes base values with instant effects and current values with lasting ones', () => {
    const actor = new AbilitySystem('a', fighter());
    expect(actor.applyEffect('fireballHit')).toBe(true);
    expect(actor.getBase('health')).toBe(70);
    expect(actor.applyEffect('haste')).toBe(true);
    expect(actor.get('speed')).toBe(7.5);
    expect(actor.getBase('speed')).toBe(5);
    expect(actor.tags.has('State.Hasted')).toBe(true);
    actor.step(4);
    expect(actor.get('speed')).toBe(5);
    expect(actor.tags.has('State.Hasted')).toBe(false);
  });

  it('raises a maximum while an effect lasts, and pulls the value back in when it ends', () => {
    const actor = new AbilitySystem('a', fighter());
    actor.applyEffect('fortify');
    expect(actor.get('maxHealth')).toBe(150);
    actor.addBase('health', 40);
    expect(actor.get('health')).toBe(140);
    actor.removeEffect('fortify');
    expect(actor.get('health')).toBe(100);
  });

  it('ticks periodic effects while they last and stacks them', () => {
    const actor = new AbilitySystem('a', fighter());
    actor.applyEffect('burning');
    actor.applyEffect('burning');
    expect(actor.activeEffects()).toEqual([{ id: 'burning', stacks: 2, left: 3 }]);
    for (let i = 0; i < 6; i++) actor.step(0.5);
    // Three ticks of 5 for each of two stacks.
    expect(actor.get('health')).toBe(70);
    expect(actor.hasEffect('burning')).toBe(false);
    expect(actor.tags.has('State.Burning')).toBe(false);
  });

  it('refuses effects it is immune to or that do not stack, and cleanses by tag', () => {
    const actor = new AbilitySystem('a', fighter());
    actor.addTag('State.Immune');
    expect(actor.applyEffect('stun')).toBe(false);
    actor.removeTag('State.Immune');
    expect(actor.applyEffect('stun')).toBe(true);
    expect(actor.applyEffect('stun')).toBe(false);
    actor.applyEffect('haste');
    actor.applyEffect('cleanse');
    expect(actor.hasEffect('stun')).toBe(false);
    expect(actor.hasEffect('haste')).toBe(false);
    expect(actor.tags.has('State')).toBe(false);
    // Class tags were not granted by an effect, so they stay.
    expect(actor.tags.has('Class.Mage')).toBe(true);
  });

  it('regenerates after a pause once it last went down', () => {
    const actor = new AbilitySystem('a', fighter());
    actor.addBase('mana', -30);
    actor.step(0.5);
    expect(actor.get('mana')).toBe(20);
    actor.step(0.5);
    actor.step(1);
    expect(actor.get('mana')).toBe(30);
    actor.step(10);
    expect(actor.get('mana')).toBe(50);
  });

  it('keeps a bound attribute elsewhere, reading and writing through the binding', () => {
    let held = 80;
    const actor = new AbilitySystem('a', fighter());
    actor.bind('health', { get: () => held, set: value => { held = value; } });
    expect(actor.get('health')).toBe(80);
    actor.applyEffect('fireballHit');
    expect(held).toBe(50);
    held = 10;
    actor.step(0.1);
    expect(actor.get('health')).toBe(10);
    actor.bind('health', null);
    actor.addBase('health', 5);
    expect(actor.get('health')).toBe(15);
  });
});

describe('abilities', () => {
  it('pays costs, starts cooldowns and applies effects to the target', () => {
    const mage = new AbilitySystem('mage', fighter());
    const enemy = new AbilitySystem('enemy', fighter());
    const events: AbilityEvent[] = [];
    mage.on(event => events.push(event));
    expect(mage.activate('fireball')).toBe('noTarget');
    expect(mage.activate('fireball', enemy)).toBeNull();
    expect(mage.get('mana')).toBe(30);
    expect(enemy.get('health')).toBe(70);
    expect(enemy.hasEffect('burning')).toBe(true);
    expect(mage.cooldown('fireball')).toBe(2);
    expect(mage.activate('fireball', enemy)).toBe('cooldown');
    mage.step(2);
    expect(mage.activate('fireball', enemy)).toBeNull();
    mage.step(2);
    // 10 mana left after regenerating a little: not enough.
    mage.addBase('mana', -100);
    expect(mage.activate('fireball', enemy)).toBe('cost');
    expect(events.filter(event => event.type === 'abilityActivated')).toHaveLength(2);
    expect(events.filter(event => event.type === 'abilityRefused').map(event => (event as { reason: string }).reason)).toEqual(['noTarget', 'cooldown', 'cost']);
  });

  it('is blocked by tags, needs its required tags, and grants tags while active', () => {
    const mage = new AbilitySystem('mage', fighter());
    const enemy = new AbilitySystem('enemy', fighter());
    mage.applyEffect('stun');
    expect(mage.refusal('fireball', enemy)).toBe('blocked');
    mage.removeEffect('stun');
    expect(mage.refusal('fireball', enemy)).toBeNull();
    const warrior = new AbilitySystem('w', { ...fighter(), tags: [] });
    expect(warrior.activate('hasteSelf')).toBe('missingTags');
    expect(mage.activate('hasteSelf')).toBeNull();
    expect(mage.get('speed')).toBe(7.5);

    expect(mage.activate('channel')).toBeNull();
    expect(mage.isActive('channel')).toBe(true);
    expect(mage.tags.has('Ability.Channel')).toBe(true);
    mage.step(1.5);
    expect(mage.isActive('channel')).toBe(false);
    expect(mage.tags.has('Ability')).toBe(false);
  });

  it('cancels active abilities by their tags', () => {
    const mage = new AbilitySystem('mage', fighter());
    const ended: string[] = [];
    mage.on(event => { if (event.type === 'abilityEnded') ended.push(event.ability); });
    mage.activate('channel');
    mage.activate('interrupt');
    expect(mage.isActive('channel')).toBe(false);
    expect(ended).toEqual(['channel', 'interrupt']);
    expect(mage.activate('unknown')).toBe('unknown');
  });

  it('applies start effects and start tags', () => {
    const actor = new AbilitySystem('a', { ...fighter(), startEffects: ['fortify'] });
    expect(actor.get('maxHealth')).toBe(150);
    expect(actor.tags.has('Class')).toBe(true);
  });
});

describe('ability actors', () => {
  it('finds actors by scope and id, and forgets them when they go', () => {
    const actor = new AbilitySystem('crate', fighter());
    let changes = 0;
    const unsubscribe = abilityActors.subscribe(() => changes++);
    const release = abilityActors.register('runtime', actor);
    expect(abilityActors.get('runtime', 'crate')).toBe(actor);
    expect(abilityActors.get('editor', 'crate')).toBeNull();
    expect(abilityActors.all('runtime')).toContain(actor);
    release();
    expect(abilityActors.get('runtime', 'crate')).toBeNull();
    expect(changes).toBe(2);
    unsubscribe();
  });
});
