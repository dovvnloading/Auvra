
import React, { useRef, useCallback } from 'react';
import * as THREE from 'three';
import { AI_CONFIG, AIState, AITuning, DEFAULT_AI_TUNING } from './AIConfig';
import { GraphRuntimeAPI } from '../../AnimationGraph/GraphRuntime';
import { OPEN_PERCEPTION, perceive, type Perception } from './AISenses';
import { Awareness, type AwarenessStage } from '../../../runtime/awareness';
import { evaluateNextState, calculateNavigation, DecisionContext } from './AIStateMachine';
import { useNavMeshContext } from '../../../runtime/navigation';
import type { SplinePatrol } from '../../../runtime/patrolPath';

/** Along a patrol path, the next waypoint is taken this close to the current one, so the enemy walks on without stopping. */
const PATROL_LOOKAHEAD = 1.6;

interface BrainInput {
  enemyPosition: THREE.Vector3;
  enemyForward: THREE.Vector3;
  targetPosition: THREE.Vector3;
  distToTarget: number;
  distFromCenter: number;
  boundarySize: number;
  delta: number;
  /** Line of sight and noises heard (AIController); without it everything is in sight and nothing heard. */
  perception?: Perception;
}

export interface BrainOutput {
  state: AIState;
  destination: THREE.Vector3;
  targetFocus: THREE.Vector3 | null; // What to look at
  /** How aware it is of the target (runtime/awareness.ts), for a ? or ! over its head. */
  awareness: AwarenessStage;
  awarenessLevel: number;
}

export const useAIBrain = (
    graphApi: React.RefObject<GraphRuntimeAPI | undefined>,
    onAttack?: () => void,
    tuning: AITuning = DEFAULT_AI_TUNING, // Per-enemy tunables (resolveAITuning on the blueprint's stats)
    patrol: SplinePatrol | null = null // Its spawner's patrol path (runtime/patrolPath.ts): patrols along it instead of wandering
) => {
  const stateRef = useRef<AIState>('IDLE');
  
  // Persistent Memory
  const lastKnownPos = useRef<THREE.Vector3 | null>(null);
  const patrolDest = useRef<THREE.Vector3 | null>(null);
  // The current waypoint is an end of the patrol path, where it pauses before turning back.
  const patrolEnd = useRef(false);
  const damageDealtRef = useRef(false);
  const awareness = useRef(new Awareness());
  const lastHealth = useRef<number | null>(null);

  // Timers
  const timers = useRef({
    cooldown: 0,
    attack: 0,
    memory: 0,
    search: 0,
    patrolWait: 0,
    strafe: 0
  });

  const navMesh = useNavMeshContext();

  const updateState = useCallback((input: BrainInput): BrainOutput => {
    const { delta, enemyPosition, enemyForward, targetPosition, distToTarget, distFromCenter, boundarySize } = input;
    const { COMBAT, DISTANCES, SENSES } = AI_CONFIG;

    // --- 1. Timer Management ---
    if (timers.current.cooldown > 0) timers.current.cooldown -= delta;
    if (timers.current.attack > 0) timers.current.attack -= delta;
    if (timers.current.patrolWait > 0) timers.current.patrolWait -= delta;
    if (timers.current.strafe > 0) timers.current.strafe -= delta;

    // --- Damage Frame Logic (Hit at ~75% of animation) ---
    if (stateRef.current === 'ATTACKING') {
        const progress = 1.0 - (timers.current.attack / COMBAT.ATTACK_DURATION);
        
        // If we crossed the damage threshold and haven't dealt damage yet
        if (progress >= 0.75 && !damageDealtRef.current) {
            // Check Overlap/Range at the moment of impact
            // Use Attack Distance + small buffer (0.5m) for gameplay feel
            if (distToTarget <= tuning.attackRange + 0.5) {
                if (onAttack) onAttack();
            }
            damageDealtRef.current = true;
        }
    }

    // --- 2. Senses (Perception) ---
    // Hurt, it knows where the player is at once; otherwise seeing them builds awareness (AISenses.perceive).
    const health = Number(graphApi.current?.getVariable('Health'));
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

    // Memory Update: where the player was last seen, or glimpsed, or a noise was heard, is where to look.
    if (canSee || investigate) {
        if (!lastKnownPos.current) lastKnownPos.current = new THREE.Vector3();
        lastKnownPos.current.copy(canSee ? targetPosition : investigate!);
        timers.current.memory = SENSES.MEMORY_DURATION;
    } else {
        if (timers.current.memory > 0) timers.current.memory -= delta;
    }

    // A waypoint on the patrol path, on the walkable surface where there is one.
    const route = patrol?.available ? patrol : null;
    const nextWaypoint = (): THREE.Vector3 | null => {
        const waypoint = route?.next(enemyPosition) ?? null;
        if (!waypoint) return null;
        patrolEnd.current = waypoint.end;
        const point = navMesh?.closestPoint(waypoint.point) ?? waypoint.point.setY(enemyPosition.y);
        return point;
    };
    if (route && stateRef.current === 'PATROL' && patrolDest.current && !patrolEnd.current
        && Math.hypot(enemyPosition.x - patrolDest.current.x, enemyPosition.z - patrolDest.current.z) < PATROL_LOOKAHEAD) {
        patrolDest.current = nextWaypoint() ?? patrolDest.current;
    }

    // --- 3. Decision Making (State Transition) ---
    const decisionContext: DecisionContext = {
        currentState: stateRef.current,
        // evaluateNextState measures attack range against AI_CONFIG's; rescale the distance so
        // that threshold stands for this enemy's attack range.
        distToTarget: distToTarget * (DISTANCES.ATTACK / tuning.attackRange),
        distFromCenter,
        boundarySize,
        canSee,
        heard: investigate !== null,
        timers: timers.current,
        patrolDest: patrolDest.current,
        enemyPosition
    };

    const { nextState, shouldAttack, shouldStrafe } = evaluateNextState(decisionContext);
    
    // --- 4. Apply State Changes / Side Effects ---
    
    // State Change Logic
    if (nextState !== stateRef.current) {
        // Reset damage flag if we are forcibly leaving attacking state (e.g. stunned/died)
        if (stateRef.current === 'ATTACKING') {
             damageDealtRef.current = false;
        }

        // State Entry Logic
        if (nextState === 'PATROL') {
            // Along its patrol path; else on a navmesh, a random point the enemy can walk to; otherwise a random point in the arena.
            const alongPath = nextWaypoint();
            const onNavMesh = alongPath ? null : navMesh?.randomPointAround(enemyPosition, DISTANCES.PATROL_RADIUS) ?? null;
            if (alongPath) {
                patrolDest.current = alongPath;
            } else if (onNavMesh) {
                patrolDest.current = onNavMesh;
            } else {
                const r = DISTANCES.PATROL_RADIUS * Math.sqrt(Math.random());
                const theta = Math.random() * 2 * Math.PI;
                patrolDest.current = new THREE.Vector3(
                    THREE.MathUtils.clamp(enemyPosition.x + r * Math.cos(theta), -boundarySize + 1, boundarySize - 1),
                    0,
                    THREE.MathUtils.clamp(enemyPosition.z + r * Math.sin(theta), -boundarySize + 1, boundarySize - 1)
                );
            }
        }
        else if (nextState === 'IDLE' && stateRef.current === 'RETURNING') {
             timers.current.patrolWait = 2.0; // Pause after returning bounds
        }
        else if (nextState === 'IDLE' && stateRef.current === 'PATROL') {
             // Pause between waypoints; on a patrol path only at its ends.
             timers.current.patrolWait = !route ? 2.0 + Math.random() * 3.0 : patrolEnd.current ? 1.5 + Math.random() * 1.5 : 0;
             patrolEnd.current = false;
        }
        else if (nextState === 'SEARCHING') {
             timers.current.search = SENSES.SEARCH_DURATION;
        }
        else if (nextState === 'RECOVERY') {
             graphApi.current?.setVariable('AttackIndex', 0);
        }

        stateRef.current = nextState;
    }

    // Trigger Logic (Impulse actions that happen even if state doesn't change, e.g. re-attacking)
    if (shouldAttack) {
        timers.current.attack = COMBAT.ATTACK_DURATION;
        timers.current.cooldown = tuning.attackCooldown;
        const atkIdx = Math.floor(Math.random() * 3) + 1;
        graphApi.current?.setVariable('AttackIndex', atkIdx);
        
        // Prepare for new damage cycle, but DO NOT deal damage yet
        damageDealtRef.current = false;
    }

    if (shouldStrafe) {
        timers.current.strafe = COMBAT.STRAFE_DURATION_MIN + Math.random() * (COMBAT.STRAFE_DURATION_MAX - COMBAT.STRAFE_DURATION_MIN);
    }

    // --- 5. Navigation Calculation ---
    const { destination, targetFocus } = calculateNavigation(
        stateRef.current,
        enemyPosition,
        targetPosition,
        lastKnownPos.current,
        patrolDest.current,
        canSee
    );

    return {
        state: stateRef.current,
        destination,
        targetFocus,
        awareness: perceived.stage,
        awarenessLevel: perceived.level
    };
  }, [graphApi, onAttack, tuning, navMesh, patrol]);

  return { updateState };
};
