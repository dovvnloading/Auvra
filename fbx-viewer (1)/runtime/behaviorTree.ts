import * as THREE from 'three';
import type { AIState } from '../components/Sandbox/AI/AIConfig';
import type { BehaviorNode, BehaviorTreeData } from '../types';

/**
 * BEHAVIOR TREES
 *
 * An enemy blueprint's behavior tree is evaluated from its root every frame. Each node answers
 * success, failure or running: a selector tries its children in order until one does not fail, a
 * sequence runs them in order until one does not succeed, an inverter swaps success and failure, a
 * succeeder turns failure into success, and a cooldown lets its child succeed at most once per
 * interval. Conditions test what the enemy perceives; actions set where it goes and what it does
 * (the intent) through the same movement and attack systems the built-in AI uses.
 *
 * Nodes keep small memories (a wait's elapsed time, a patrol point). A memory is dropped when its
 * node was running and another branch took over, so an interrupted wait starts over next time.
 */

export type BehaviorStatus = 'success' | 'failure' | 'running';

/** What the enemy knows this frame. */
export interface BehaviorWorld {
    position: THREE.Vector3;
    /** Where it spawned; returnHome and patrol center on it. */
    home: THREE.Vector3;
    playerPosition: THREE.Vector3 | null;
    distToPlayer: number;
    canSee: boolean;
    remembers: boolean;
    lastKnown: THREE.Vector3 | null;
    /** 0..100. */
    healthPct: number;
    attackRange: number;
    patrolRadius: number;
    delta: number;
    /** Seconds since the enemy started. */
    time: number;
    random(): number;
    variable(name: string): number | boolean | undefined;
    objectPosition(objectId: string): THREE.Vector3 | null;
    /** The nearest reachable point to `point` (navigation), or the point itself. */
    reachable(point: THREE.Vector3): THREE.Vector3;
}

/** What actions do besides choosing where to go. */
export interface BehaviorEffects {
    attackReady(): boolean;
    startAttack(): void;
    /** True while an attack started earlier is still playing. */
    attacking(): boolean;
    setVariable(name: string, value: number): void;
    playAnimation(clipName: string): boolean;
}

export interface BehaviorIntent {
    state: AIState;
    destination: THREE.Vector3;
    focus: THREE.Vector3 | null;
}

interface NodeMemory {
    elapsed?: number;
    point?: THREE.Vector3;
    until?: number;
    started?: boolean;
    rollAt?: number;
    roll?: boolean;
}

export interface BehaviorMemory {
    nodes: Map<string, NodeMemory>;
    /** Nodes that were running at the end of the previous frame. */
    running: Set<string>;
}

export const createBehaviorMemory = (): BehaviorMemory => ({ nodes: new Map(), running: new Set() });

/** Within this distance a move counts as arrived. */
export const ARRIVE_DISTANCE = 1;
const DEFAULT_WAIT = 2;
const DEFAULT_STRAFE = 2;
const DEFAULT_FLEE = 15;
/** Chance conditions roll once per this many seconds, so a frame rate does not change their odds. */
const CHANCE_INTERVAL = 1;
/** Timed actions end when within this of their time, so summed frame times do not add a frame. */
const TIME_EPSILON = 1e-6;

const flat = (a: THREE.Vector3, b: THREE.Vector3) => Math.hypot(a.x - b.x, a.z - b.z);

interface Tick {
    world: BehaviorWorld;
    effects: BehaviorEffects;
    memory: BehaviorMemory;
    nodes: Map<string, BehaviorNode>;
    intent: BehaviorIntent;
    running: Set<string>;
    depth: number;
}

const memoryOf = (tick: Tick, id: string): NodeMemory => {
    let memory = tick.memory.nodes.get(id);
    if (!memory) {
        memory = {};
        tick.memory.nodes.set(id, memory);
    }
    return memory;
};

const go = (tick: Tick, state: AIState, destination: THREE.Vector3, focus: THREE.Vector3 | null): void => {
    tick.intent = { state, destination: destination.clone(), focus: focus ? focus.clone() : null };
};

const evaluateCondition = (node: BehaviorNode, tick: Tick): boolean => {
    const { world } = tick;
    switch (node.condition) {
        case 'canSeePlayer': return world.canSee;
        case 'remembersPlayer': return world.canSee || world.remembers;
        case 'playerWithin': return !!world.playerPosition && world.distToPlayer <= (node.value ?? world.attackRange);
        case 'healthBelow': return world.healthPct < (node.value ?? 50);
        case 'chance': {
            const memory = memoryOf(tick, node.id);
            if (memory.rollAt === undefined || world.time - memory.rollAt >= CHANCE_INTERVAL) {
                memory.rollAt = world.time;
                memory.roll = world.random() < Math.min(1, Math.max(0, node.value ?? 0.5));
            }
            return memory.roll === true;
        }
        case 'variableTrue': {
            const value = node.text ? world.variable(node.text) : undefined;
            return value === true || (typeof value === 'number' && value !== 0);
        }
        default: return false;
    }
};

/** Moves toward `target` with the given state; success once within ARRIVE_DISTANCE. */
const moveTo = (tick: Tick, state: AIState, target: THREE.Vector3): BehaviorStatus => {
    if (flat(tick.world.position, target) <= ARRIVE_DISTANCE) return 'success';
    go(tick, state, target, null);
    return 'running';
};

const evaluateAction = (node: BehaviorNode, tick: Tick): BehaviorStatus => {
    const { world, effects } = tick;
    const player = world.playerPosition;
    switch (node.action) {
        case 'chase': {
            const target = world.canSee ? player : world.remembers ? world.lastKnown : null;
            if (!target) return 'failure';
            if (world.canSee && world.distToPlayer <= world.attackRange) return 'success';
            go(tick, 'CHASE', target, target);
            return 'running';
        }
        case 'attack': {
            const memory = memoryOf(tick, node.id);
            if (memory.started && effects.attacking()) {
                if (player) go(tick, 'ATTACKING', player, player);
                return 'running';
            }
            if (memory.started) {
                memory.started = false;
                return 'success';
            }
            if (!player || !world.canSee || world.distToPlayer > world.attackRange + 0.5 || !effects.attackReady()) return 'failure';
            effects.startAttack();
            memory.started = true;
            go(tick, 'ATTACKING', player, player);
            return 'running';
        }
        case 'strafe': {
            if (!player || !world.canSee) return 'failure';
            const memory = memoryOf(tick, node.id);
            memory.elapsed = (memory.elapsed ?? 0) + world.delta;
            if (memory.elapsed >= (node.value ?? DEFAULT_STRAFE) - TIME_EPSILON) return 'success';
            go(tick, 'STRAFING', player, player);
            return 'running';
        }
        case 'search': {
            if (!world.lastKnown) return 'failure';
            return moveTo(tick, 'SEARCHING', world.lastKnown);
        }
        case 'patrol': {
            const memory = memoryOf(tick, node.id);
            if (!memory.point) {
                const radius = Math.max(1, node.value ?? world.patrolRadius);
                const r = radius * Math.sqrt(world.random());
                const theta = world.random() * Math.PI * 2;
                memory.point = world.reachable(new THREE.Vector3(world.home.x + r * Math.cos(theta), 0, world.home.z + r * Math.sin(theta)));
            }
            const status = moveTo(tick, 'PATROL', memory.point);
            if (status === 'success') memory.point = undefined;
            return status;
        }
        case 'wait': {
            const memory = memoryOf(tick, node.id);
            memory.elapsed = (memory.elapsed ?? 0) + world.delta;
            if (memory.elapsed >= (node.value ?? DEFAULT_WAIT) - TIME_EPSILON) {
                memory.elapsed = 0;
                return 'success';
            }
            go(tick, 'IDLE', world.position, null);
            return 'running';
        }
        case 'moveTo': {
            const target = node.text ? world.objectPosition(node.text) : null;
            return target ? moveTo(tick, 'PATROL', target) : 'failure';
        }
        case 'flee': {
            if (!player) return 'failure';
            if (world.distToPlayer >= (node.value ?? DEFAULT_FLEE)) return 'success';
            const away = world.position.clone().sub(player).setY(0);
            if (away.lengthSq() < 1e-6) away.set(1, 0, 0);
            go(tick, 'CHASE', world.reachable(world.position.clone().addScaledVector(away.normalize(), 5)), null);
            return 'running';
        }
        case 'returnHome': return moveTo(tick, 'RETURNING', world.home);
        case 'setVariable':
            if (!node.text) return 'failure';
            effects.setVariable(node.text, node.value ?? 0);
            return 'success';
        case 'playAnimation':
            return node.text && effects.playAnimation(node.text) ? 'success' : 'failure';
        default:
            return 'failure';
    }
};

/** Deep trees, and trees that point back at an ancestor, stop here instead of overflowing. */
const MAX_DEPTH = 64;

const evaluate = (id: string, tick: Tick): BehaviorStatus => {
    const node = tick.nodes.get(id);
    if (!node || tick.depth >= MAX_DEPTH) return 'failure';
    tick.depth++;
    let status: BehaviorStatus;
    const children = node.children ?? [];
    switch (node.type) {
        case 'selector':
            status = 'failure';
            for (const child of children) {
                const result = evaluate(child, tick);
                if (result !== 'failure') { status = result; break; }
            }
            break;
        case 'sequence':
            status = 'success';
            for (const child of children) {
                const result = evaluate(child, tick);
                if (result !== 'success') { status = result; break; }
            }
            break;
        case 'inverter': {
            const result = children[0] ? evaluate(children[0], tick) : 'failure';
            status = result === 'running' ? 'running' : result === 'success' ? 'failure' : 'success';
            break;
        }
        case 'succeeder': {
            const result = children[0] ? evaluate(children[0], tick) : 'success';
            status = result === 'running' ? 'running' : 'success';
            break;
        }
        case 'cooldown': {
            const memory = memoryOf(tick, node.id);
            if (memory.until !== undefined && tick.world.time < memory.until) { status = 'failure'; break; }
            const result = children[0] ? evaluate(children[0], tick) : 'failure';
            if (result === 'success') memory.until = tick.world.time + Math.max(0, node.value ?? 5);
            status = result;
            break;
        }
        case 'condition':
            status = evaluateCondition(node, tick) ? 'success' : 'failure';
            break;
        case 'action':
            status = evaluateAction(node, tick);
            break;
        default:
            status = 'failure';
    }
    tick.depth--;
    if (status === 'running') tick.running.add(id);
    return status;
};

/** Node types whose memory outlives an interruption. */
const PERSISTENT: ReadonlySet<BehaviorNode['type']> = new Set(['cooldown']);

/**
 * One frame of the tree: its root's status and the enemy's intent (idle in place when no action
 * moves it). `memory` carries node state between frames.
 */
export const tickBehaviorTree = (
    tree: BehaviorTreeData,
    memory: BehaviorMemory,
    world: BehaviorWorld,
    effects: BehaviorEffects,
): { status: BehaviorStatus; intent: BehaviorIntent } => {
    const nodes = new Map(tree.behaviorNodes.map(node => [node.id, node]));
    const tick: Tick = {
        world, effects, memory, nodes,
        intent: { state: 'IDLE', destination: world.position.clone(), focus: null },
        running: new Set(), depth: 0,
    };
    const status = evaluate(tree.rootId, tick);
    // A node that was running and is not any more lost its turn to another branch: it starts over.
    for (const id of memory.running) {
        if (tick.running.has(id)) continue;
        const node = nodes.get(id);
        if (!node || !PERSISTENT.has(node.type)) memory.nodes.delete(id);
    }
    memory.running = tick.running;
    return { status, intent: tick.intent };
};

const node = (id: string, type: BehaviorNode['type'], extra: Partial<BehaviorNode> = {}): BehaviorNode => ({ id, type, ...extra });

/** A tree that behaves like the built-in AI: fight what it sees, search where it last saw the player, otherwise patrol. */
export const defaultBehaviorTree = (): BehaviorTreeData => ({
    rootId: 'root',
    behaviorNodes: [
        node('root', 'selector', { children: ['fight', 'hunt', 'wander'] }),
        node('fight', 'sequence', { children: ['sees', 'engage'] }),
        node('sees', 'condition', { condition: 'canSeePlayer' }),
        node('engage', 'selector', { children: ['strike', 'close-in'] }),
        node('strike', 'action', { action: 'attack' }),
        node('close-in', 'action', { action: 'chase' }),
        node('hunt', 'sequence', { children: ['remembers', 'search'] }),
        node('remembers', 'condition', { condition: 'remembersPlayer' }),
        node('search', 'action', { action: 'search' }),
        node('wander', 'sequence', { children: ['patrol', 'pause'] }),
        node('patrol', 'action', { action: 'patrol' }),
        node('pause', 'action', { action: 'wait', value: 3 }),
    ],
});

/** Problems that make part of a tree unreachable or meaningless, for the editor to show. */
export const behaviorTreeProblems = (tree: BehaviorTreeData): string[] => {
    const problems: string[] = [];
    const ids = new Set(tree.behaviorNodes.map(item => item.id));
    if (!ids.has(tree.rootId)) problems.push('The tree has no root node.');
    for (const item of tree.behaviorNodes) {
        const children = item.children ?? [];
        if ((item.type === 'selector' || item.type === 'sequence') && children.length === 0) problems.push(`A ${item.type} has no children.`);
        if ((item.type === 'inverter' || item.type === 'succeeder' || item.type === 'cooldown') && children.length !== 1) problems.push(`An ${item.type} needs exactly one child.`);
        if (children.some(child => !ids.has(child))) problems.push('A node lists a child that does not exist.');
        if (item.type === 'condition' && !item.condition) problems.push('A condition has no test chosen.');
        if (item.type === 'action' && !item.action) problems.push('An action has nothing chosen to do.');
    }
    return [...new Set(problems)];
};
