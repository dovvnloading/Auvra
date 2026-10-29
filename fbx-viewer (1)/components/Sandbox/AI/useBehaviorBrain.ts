import React, { useCallback, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import type { BehaviorTreeData } from '../../../types';
import { createBehaviorMemory, tickBehaviorTree, type BehaviorEffects, type BehaviorWorld } from '../../../runtime/behaviorTree';
import { useNavMeshContext } from '../../../runtime/navigation';
import type { GraphRuntimeAPI } from '../../AnimationGraph/GraphRuntime';
import { AI_CONFIG, DEFAULT_AI_TUNING, type AITuning } from './AIConfig';
import { OPEN_PERCEPTION, perceive, type Perception } from './AISenses';
import { Awareness } from '../../../runtime/awareness';
import type { BrainOutput } from './useAIBrain';
import { createWeaponState, stepWeapons, type ResolvedWeapon } from '../../../runtime/weapons';

/** Seconds an enemy takes to bring its weapon up before the first shot of a burst. */
const ENEMY_AIM_DELAY = 0.3;

/** What the enemy's weapon does in a frame: shots fired, and whether its trigger is held. */
export type EnemyFireHandler = (shots: number, triggerHeld: boolean) => void;

interface BehaviorBrainInput {
    enemyPosition: THREE.Vector3;
    enemyForward: THREE.Vector3;
    targetPosition: THREE.Vector3;
    distToTarget: number;
    delta: number;
    /** Line of sight and noises heard (AIController); without it everything is in sight and nothing heard. */
    perception?: Perception;
}

/** How long a found level object position is trusted before it is looked up again (seconds). */
const OBJECT_LOOKUP_SECONDS = 0.5;

/**
 * The brain for an enemy with a behavior tree: the same perception, attack timing and damage frame
 * as the built-in brain (useAIBrain), with the decisions taken by the tree.
 */
export const useBehaviorBrain = (
    tree: BehaviorTreeData | undefined,
    graphApi: React.RefObject<GraphRuntimeAPI | undefined>,
    onAttack?: () => void,
    tuning: AITuning = DEFAULT_AI_TUNING,
    weapon: ResolvedWeapon | null = null,
    onFire?: EnemyFireHandler,
) => {
    const scene = useThree(state => state.scene);
    const navMesh = useNavMeshContext();
    const memory = useMemo(() => createBehaviorMemory(), [tree]);
    const home = useRef<THREE.Vector3 | null>(null);
    const lastKnown = useRef<THREE.Vector3 | null>(null);
    const awareness = useRef(new Awareness());
    const lastHealth = useRef<number | null>(null);
    const clock = useRef({ time: 0, memory: 0, cooldown: 0, attack: 0, damageDealt: false });
    const objects = useRef(new Map<string, { object: THREE.Object3D | null; foundAt: number }>());
    // The weapon a Shoot action fires: its own rate, magazine and reload, as for the player.
    const weaponState = useMemo(() => (weapon ? createWeaponState([weapon]) : null), [weapon]);
    const triggerWasHeld = useRef(false);

    const updateState = useCallback((input: BehaviorBrainInput): BrainOutput => {
        const { delta, enemyPosition, enemyForward, targetPosition, distToTarget } = input;
        const { COMBAT, DISTANCES, SENSES } = AI_CONFIG;
        const timers = clock.current;
        timers.time += delta;
        if (timers.cooldown > 0) timers.cooldown -= delta;
        if (timers.attack > 0) timers.attack -= delta;
        if (!home.current) home.current = enemyPosition.clone();

        // The damage frame, as in the built-in brain: about three quarters into the attack.
        if (timers.attack > 0 && !timers.damageDealt && 1 - timers.attack / COMBAT.ATTACK_DURATION >= 0.75) {
            if (distToTarget <= tuning.attackRange + 0.5) onAttack?.();
            timers.damageDealt = true;
        }
        if (timers.attack <= 0 && graphApi.current?.getVariable('AttackIndex')) graphApi.current.setVariable('AttackIndex', 0);

        // Hurt, it knows where the player is at once; otherwise seeing them builds awareness (AISenses.perceive).
        // Where the player was last seen, or glimpsed, or a noise was heard, is what the tree remembers.
        const health = Number(graphApi.current?.getVariable('Health'));
        const maxHealth = Number(graphApi.current?.getVariable('MaxHealth'));
        if (Number.isFinite(health)) {
            if (lastHealth.current !== null && health < lastHealth.current) awareness.current.alert();
            lastHealth.current = health;
        }
        const perception = input.perception ?? OPEN_PERCEPTION;
        const perceived = perceive(awareness.current, { enemyPosition, enemyForward, targetPosition, distToTarget }, tuning, perception, delta);
        const { canSee, investigate } = perceived;
        // For the enemy's graph: animation, blueprints and HUD can show what it has noticed.
        graphApi.current?.setVariable('Awareness', perceived.level);
        graphApi.current?.setVariable('Alerted', perceived.stage === 'alerted');
        if (canSee || investigate) {
            lastKnown.current = (lastKnown.current ?? new THREE.Vector3()).copy(canSee ? targetPosition : investigate!);
            timers.memory = SENSES.MEMORY_DURATION;
        } else if (timers.memory > 0) {
            timers.memory -= delta;
        }

        const world: BehaviorWorld = {
            position: enemyPosition,
            home: home.current,
            playerPosition: targetPosition,
            distToPlayer: distToTarget,
            canSee,
            remembers: timers.memory > 0,
            lastKnown: lastKnown.current,
            healthPct: Number.isFinite(health) && maxHealth > 0 ? (health / maxHealth) * 100 : 100,
            attackRange: tuning.attackRange,
            patrolRadius: DISTANCES.PATROL_RADIUS,
            delta,
            time: timers.time,
            random: Math.random,
            variable: name => graphApi.current?.getVariable(name),
            objectPosition: (objectId) => {
                const cached = objects.current.get(objectId);
                let object = cached && timers.time - cached.foundAt < OBJECT_LOOKUP_SECONDS ? cached.object : undefined;
                if (object === undefined) {
                    object = null;
                    scene.traverse(node => {
                        if (!object && node.userData?.levelObjectId === objectId) object = node;
                    });
                    objects.current.set(objectId, { object, foundAt: timers.time });
                }
                return object ? (object as THREE.Object3D).getWorldPosition(new THREE.Vector3()) : null;
            },
            reachable: (point) => {
                const plan = navMesh ? navMesh.planPath(enemyPosition, point, { partial: true }) : null;
                const end = plan?.points[plan.points.length - 1];
                return end ? end.clone() : point;
            },
        };
        // A Shoot action holds the trigger for this frame only.
        let triggerHeld = false;
        const effects: BehaviorEffects = {
            attackReady: () => timers.cooldown <= 0 && timers.attack <= 0,
            startAttack: () => {
                timers.attack = COMBAT.ATTACK_DURATION;
                timers.cooldown = tuning.attackCooldown;
                timers.damageDealt = false;
                graphApi.current?.setVariable('AttackIndex', Math.floor(Math.random() * 3) + 1);
            },
            attacking: () => timers.attack > 0,
            setVariable: (name, value) => graphApi.current?.setVariable(name, value),
            playAnimation: clipName => graphApi.current?.playMontage?.(clipName) ?? false,
            canShoot: () => weapon !== null,
            holdTrigger: () => { triggerHeld = true; },
        };

        const { intent } = tree ? tickBehaviorTree(tree, memory, world, effects) : { intent: { state: 'IDLE' as const, destination: enemyPosition.clone(), focus: null } };
        if (weapon && weaponState) {
            const step = stepWeapons(weaponState, [weapon], {
                firing: triggerHeld,
                firePressed: triggerHeld && !triggerWasHeld.current,
                reloadPressed: false,
                nextWeaponPressed: false,
                firstShotDelay: ENEMY_AIM_DELAY,
            }, delta);
            triggerWasHeld.current = triggerHeld;
            onFire?.(step.shots, triggerHeld);
        }
        return { state: intent.state, destination: intent.destination, targetFocus: intent.focus, awareness: perceived.stage, awarenessLevel: perceived.level };
    }, [graphApi, memory, navMesh, onAttack, onFire, scene, tree, tuning, weapon, weaponState]);

    return { updateState };
};
