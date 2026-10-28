
import React, { useRef, useCallback } from 'react';
import * as THREE from 'three';
import { AI_CONFIG, AIState, AITuning, DEFAULT_AI_TUNING } from './AIConfig';
import { GraphRuntimeAPI } from '../../AnimationGraph/GraphRuntime';
import { OPEN_PERCEPTION, seesTarget, type Perception } from './AISenses';
import { evaluateNextState, calculateNavigation, DecisionContext } from './AIStateMachine';
import { useNavMeshContext } from '../../../runtime/navigation';

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
}

export const useAIBrain = (
    graphApi: React.RefObject<GraphRuntimeAPI | undefined>,
    onAttack?: () => void,
    tuning: AITuning = DEFAULT_AI_TUNING // Per-enemy tunables (resolveAITuning on the blueprint's stats)
) => {
  const stateRef = useRef<AIState>('IDLE');
  
  // Persistent Memory
  const lastKnownPos = useRef<THREE.Vector3 | null>(null);
  const patrolDest = useRef<THREE.Vector3 | null>(null);
  const damageDealtRef = useRef(false);

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
    // In range, and in the vision cone with nothing in the way or close enough to notice anyway.
    const perception = input.perception ?? OPEN_PERCEPTION;
    const canSee = seesTarget({ enemyPosition, enemyForward, targetPosition, distToTarget }, tuning.sightRange, perception);

    // Memory Update: where the player was last seen, or a noise was heard, is where to look.
    if (canSee || perception.heard) {
        if (!lastKnownPos.current) lastKnownPos.current = new THREE.Vector3();
        lastKnownPos.current.copy(canSee ? targetPosition : perception.heard!);
        timers.current.memory = SENSES.MEMORY_DURATION;
    } else {
        if (timers.current.memory > 0) timers.current.memory -= delta;
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
        heard: perception.heard !== null,
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
            // On a navmesh, a random point the enemy can walk to; otherwise a random point in the arena.
            const onNavMesh = navMesh?.randomPointAround(enemyPosition, DISTANCES.PATROL_RADIUS) ?? null;
            if (onNavMesh) {
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
             timers.current.patrolWait = 2.0 + Math.random() * 3.0; // Pause between waypoints
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
        targetFocus
    };
  }, [graphApi, onAttack, tuning, navMesh]);

  return { updateState };
};
