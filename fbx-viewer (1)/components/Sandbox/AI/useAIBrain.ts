
import React, { useRef, useCallback } from 'react';
import * as THREE from 'three';
import { AI_CONFIG, AIState } from './AIConfig';
import { GraphRuntimeAPI } from '../../AnimationGraph/GraphRuntime';
import { checkVisibility } from './AISenses';
import { evaluateNextState, calculateNavigation, DecisionContext } from './AIStateMachine';

interface BrainInput {
  enemyPosition: THREE.Vector3;
  enemyForward: THREE.Vector3;
  targetPosition: THREE.Vector3;
  distToTarget: number;
  distFromCenter: number;
  boundarySize: number;
  delta: number;
}

export interface BrainOutput {
  state: AIState;
  destination: THREE.Vector3;
  targetFocus: THREE.Vector3 | null; // What to look at
}

export const useAIBrain = (
    graphApi: React.RefObject<GraphRuntimeAPI | undefined>,
    onAttack?: () => void
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
            if (distToTarget <= DISTANCES.ATTACK + 0.5) {
                if (onAttack) onAttack();
            }
            damageDealtRef.current = true;
        }
    }

    // --- 2. Senses (Perception) ---
    const { canSee } = checkVisibility({ enemyPosition, enemyForward, targetPosition, distToTarget });

    // Memory Update
    if (canSee) {
        if (!lastKnownPos.current) lastKnownPos.current = new THREE.Vector3();
        lastKnownPos.current.copy(targetPosition);
        timers.current.memory = SENSES.MEMORY_DURATION;
    } else {
        if (timers.current.memory > 0) timers.current.memory -= delta;
    }

    // --- 3. Decision Making (State Transition) ---
    const decisionContext: DecisionContext = {
        currentState: stateRef.current,
        distToTarget,
        distFromCenter,
        boundarySize,
        canSee,
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
            // Generate new patrol point
            const r = DISTANCES.PATROL_RADIUS * Math.sqrt(Math.random());
            const theta = Math.random() * 2 * Math.PI;
            patrolDest.current = new THREE.Vector3(
                enemyPosition.x + r * Math.cos(theta),
                0,
                enemyPosition.z + r * Math.sin(theta)
            );
            // Clamp patrol point to arena
            patrolDest.current.x = THREE.MathUtils.clamp(patrolDest.current.x, -boundarySize + 1, boundarySize - 1);
            patrolDest.current.z = THREE.MathUtils.clamp(patrolDest.current.z, -boundarySize + 1, boundarySize - 1);
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
        timers.current.cooldown = COMBAT.ATTACK_COOLDOWN;
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
  }, [graphApi, onAttack]);

  return { updateState };
};
