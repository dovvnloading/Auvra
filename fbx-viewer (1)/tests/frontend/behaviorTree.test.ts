import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  behaviorTreeProblems, createBehaviorMemory, defaultBehaviorTree, tickBehaviorTree, type BehaviorEffects, type BehaviorWorld,
} from '../../runtime/behaviorTree';
import { addBehaviorChild, createBehaviorNode, moveBehaviorNode, removeBehaviorNode } from '../../components/Blueprint/BehaviorTreeEditor';
import type { BehaviorNode, BehaviorTreeData } from '../../types';

const world = (overrides: Partial<BehaviorWorld> = {}): BehaviorWorld => ({
  position: new THREE.Vector3(0, 0, 0),
  home: new THREE.Vector3(0, 0, 0),
  playerPosition: new THREE.Vector3(10, 0, 0),
  distToPlayer: 10,
  canSee: false,
  remembers: false,
  lastKnown: null,
  healthPct: 100,
  attackRange: 2,
  patrolRadius: 8,
  delta: 0.1,
  time: 0,
  random: () => 0.5,
  variable: () => undefined,
  objectPosition: () => null,
  reachable: point => point,
  ...overrides,
});

const effects = (overrides: Partial<BehaviorEffects> = {}): BehaviorEffects => ({
  attackReady: () => true, startAttack: vi.fn(), attacking: () => false, setVariable: vi.fn(), playAnimation: () => true, ...overrides,
});

const tree = (rootId: string, ...nodes: BehaviorNode[]): BehaviorTreeData => ({ rootId, behaviorNodes: nodes });

describe('behavior tree evaluation', () => {
  it('the default tree chases what it sees, attacks in range, searches from memory and patrols otherwise', () => {
    const memory = createBehaviorMemory();
    const t = defaultBehaviorTree();
    expect(tickBehaviorTree(t, memory, world({ canSee: true }), effects()).intent.state).toBe('CHASE');

    const fx = effects();
    expect(tickBehaviorTree(t, memory, world({ canSee: true, distToPlayer: 1.5 }), fx).intent.state).toBe('ATTACKING');
    expect(fx.startAttack).toHaveBeenCalledTimes(1);

    const lastKnown = new THREE.Vector3(4, 0, 4);
    expect(tickBehaviorTree(t, createBehaviorMemory(), world({ remembers: true, lastKnown }), effects()).intent).toMatchObject({ state: 'SEARCHING' });
    expect(tickBehaviorTree(t, createBehaviorMemory(), world(), effects()).intent.state).toBe('PATROL');
  });

  it('runs a selector until a child does not fail, and a sequence until one does not succeed', () => {
    const order: string[] = [];
    const fx = effects({ setVariable: name => order.push(name) });
    const t = tree('root',
      { id: 'root', type: 'selector', children: ['seq', 'fallback'] },
      { id: 'seq', type: 'sequence', children: ['a', 'never', 'b'] },
      { id: 'a', type: 'action', action: 'setVariable', text: 'a' },
      { id: 'never', type: 'condition', condition: 'canSeePlayer' },
      { id: 'b', type: 'action', action: 'setVariable', text: 'b' },
      { id: 'fallback', type: 'action', action: 'setVariable', text: 'fallback' },
    );
    expect(tickBehaviorTree(t, createBehaviorMemory(), world(), fx).status).toBe('success');
    expect(order).toEqual(['a', 'fallback']);
  });

  it('inverts, succeeds and cools down', () => {
    const fx = effects();
    const inverted = tree('inv', { id: 'inv', type: 'inverter', children: ['see'] }, { id: 'see', type: 'condition', condition: 'canSeePlayer' });
    expect(tickBehaviorTree(inverted, createBehaviorMemory(), world(), fx).status).toBe('success');
    const succeeded = tree('ok', { id: 'ok', type: 'succeeder', children: ['see'] }, { id: 'see', type: 'condition', condition: 'canSeePlayer' });
    expect(tickBehaviorTree(succeeded, createBehaviorMemory(), world(), fx).status).toBe('success');

    const cooled = tree('cd', { id: 'cd', type: 'cooldown', value: 5, children: ['set'] }, { id: 'set', type: 'action', action: 'setVariable', text: 'x' });
    const memory = createBehaviorMemory();
    expect(tickBehaviorTree(cooled, memory, world({ time: 0 }), fx).status).toBe('success');
    expect(tickBehaviorTree(cooled, memory, world({ time: 2 }), fx).status).toBe('failure');
    expect(tickBehaviorTree(cooled, memory, world({ time: 5 }), fx).status).toBe('success');
  });

  it('waits for its time, and starts over when another branch interrupts it', () => {
    const memory = createBehaviorMemory();
    const t = tree('root',
      { id: 'root', type: 'selector', children: ['alarm', 'idle'] },
      { id: 'alarm', type: 'sequence', children: ['see', 'chase'] },
      { id: 'see', type: 'condition', condition: 'canSeePlayer' },
      { id: 'chase', type: 'action', action: 'chase' },
      { id: 'idle', type: 'action', action: 'wait', value: 1 },
    );
    for (let i = 0; i < 5; i++) expect(tickBehaviorTree(t, memory, world({ delta: 0.1 }), effects()).status).toBe('running');
    // The player shows up: chase interrupts the wait.
    expect(tickBehaviorTree(t, memory, world({ canSee: true }), effects()).intent.state).toBe('CHASE');
    // The wait runs its full second again.
    for (let i = 0; i < 9; i++) expect(tickBehaviorTree(t, memory, world({ delta: 0.1 }), effects()).status).toBe('running');
    expect(tickBehaviorTree(t, memory, world({ delta: 0.1 }), effects()).status).toBe('success');
  });

  it('keeps attacking until the attack finishes, and fails on cooldown or out of range', () => {
    const t = tree('hit', { id: 'hit', type: 'action', action: 'attack' });
    const memory = createBehaviorMemory();
    let attacking = false;
    const fx = effects({ startAttack: () => { attacking = true; }, attacking: () => attacking });
    const near = world({ canSee: true, distToPlayer: 1 });
    expect(tickBehaviorTree(t, memory, near, fx).status).toBe('running');
    expect(tickBehaviorTree(t, memory, near, fx).status).toBe('running');
    attacking = false;
    expect(tickBehaviorTree(t, memory, near, fx).status).toBe('success');
    expect(tickBehaviorTree(t, createBehaviorMemory(), near, effects({ attackReady: () => false })).status).toBe('failure');
    expect(tickBehaviorTree(t, createBehaviorMemory(), world({ canSee: true, distToPlayer: 9 }), effects()).status).toBe('failure');
  });

  it('flees, moves to objects, tests health, variables and chance', () => {
    const flee = tree('run', { id: 'run', type: 'action', action: 'flee', value: 15 });
    const intent = tickBehaviorTree(flee, createBehaviorMemory(), world({ distToPlayer: 5 }), effects()).intent;
    expect(intent.destination.x).toBeLessThan(0);
    expect(tickBehaviorTree(flee, createBehaviorMemory(), world({ distToPlayer: 20 }), effects()).status).toBe('success');

    const door = new THREE.Vector3(0, 0, 6);
    const go = tree('go', { id: 'go', type: 'action', action: 'moveTo', text: 'door' });
    expect(tickBehaviorTree(go, createBehaviorMemory(), world({ objectPosition: id => (id === 'door' ? door : null) }), effects()).intent.destination.z).toBe(6);
    expect(tickBehaviorTree(go, createBehaviorMemory(), world(), effects()).status).toBe('failure');

    const hurt = tree('h', { id: 'h', type: 'condition', condition: 'healthBelow', value: 30 });
    expect(tickBehaviorTree(hurt, createBehaviorMemory(), world({ healthPct: 20 }), effects()).status).toBe('success');
    expect(tickBehaviorTree(hurt, createBehaviorMemory(), world({ healthPct: 60 }), effects()).status).toBe('failure');

    const flag = tree('f', { id: 'f', type: 'condition', condition: 'variableTrue', text: 'Alerted' });
    expect(tickBehaviorTree(flag, createBehaviorMemory(), world({ variable: () => true }), effects()).status).toBe('success');

    const coin = tree('c', { id: 'c', type: 'condition', condition: 'chance', value: 0.3 });
    const memory = createBehaviorMemory();
    expect(tickBehaviorTree(coin, memory, world({ random: () => 0.1, time: 0 }), effects()).status).toBe('success');
    // Within the same second the roll holds.
    expect(tickBehaviorTree(coin, memory, world({ random: () => 0.9, time: 0.5 }), effects()).status).toBe('success');
    expect(tickBehaviorTree(coin, memory, world({ random: () => 0.9, time: 1.5 }), effects()).status).toBe('failure');
  });

  it('survives missing nodes and cycles', () => {
    const loop = tree('a', { id: 'a', type: 'sequence', children: ['b'] }, { id: 'b', type: 'sequence', children: ['a'] });
    expect(tickBehaviorTree(loop, createBehaviorMemory(), world(), effects()).status).toBe('failure');
    expect(tickBehaviorTree(tree('nope'), createBehaviorMemory(), world(), effects()).intent.state).toBe('IDLE');
  });
});

describe('behavior tree editing', () => {
  it('adds, moves and removes nodes with their subtrees', () => {
    let t = tree('root', { id: 'root', type: 'selector', children: [] });
    const a = createBehaviorNode('sequence');
    const b = createBehaviorNode('action');
    t = addBehaviorChild(t, 'root', a);
    t = addBehaviorChild(t, 'root', b);
    const leaf = createBehaviorNode('condition');
    t = addBehaviorChild(t, a.id, leaf);
    expect(t.behaviorNodes.find(node => node.id === 'root')!.children).toEqual([a.id, b.id]);
    t = moveBehaviorNode(t, b.id, -1);
    expect(t.behaviorNodes.find(node => node.id === 'root')!.children).toEqual([b.id, a.id]);
    t = removeBehaviorNode(t, a.id);
    expect(t.behaviorNodes.map(node => node.id).sort()).toEqual(['root', b.id].sort());
    expect(t.behaviorNodes.find(node => node.id === 'root')!.children).toEqual([b.id]);
  });

  it('reports problems that leave parts of a tree unusable', () => {
    expect(behaviorTreeProblems(defaultBehaviorTree())).toEqual([]);
    const broken = tree('root',
      { id: 'root', type: 'selector', children: ['ghost'] },
      { id: 'inv', type: 'inverter', children: [] },
      { id: 'act', type: 'action' },
    );
    expect(behaviorTreeProblems(broken)).toEqual([
      'A node lists a child that does not exist.',
      'An inverter needs exactly one child.',
      'An action has nothing chosen to do.',
    ]);
  });
});
