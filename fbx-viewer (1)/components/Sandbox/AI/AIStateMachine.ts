
import * as THREE from 'three';
import { AI_CONFIG, AIState } from './AIConfig';

// Context required to make a decision
export interface DecisionContext {
    currentState: AIState;
    distToTarget: number;
    distFromCenter: number;
    boundarySize: number;
    canSee: boolean;
    timers: {
        cooldown: number;
        attack: number;
        search: number;
        patrolWait: number;
        strafe: number;
        memory: number; // Time since last seen
    };
    patrolDest: THREE.Vector3 | null;
    enemyPosition: THREE.Vector3;
}

// Result of the decision
export interface DecisionResult {
    nextState: AIState;
    shouldAttack: boolean; // Trigger to play animation
    shouldStrafe: boolean; // Trigger to start strafe timer
}

/**
 * Pure function to determine the next state based on current context.
 */
export const evaluateNextState = (ctx: DecisionContext): DecisionResult => {
    const { currentState, distToTarget, distFromCenter, boundarySize, canSee, timers, patrolDest, enemyPosition } = ctx;
    const { DISTANCES, SENSES, COMBAT } = AI_CONFIG;

    let nextState = currentState;
    let shouldAttack = false;
    let shouldStrafe = false;

    const isOutOfBounds = distFromCenter > boundarySize;

    // --- PRIORITY 1: BOUNDARY ENFORCEMENT ---
    if (isOutOfBounds) {
        return { nextState: 'RETURNING', shouldAttack: false, shouldStrafe: false };
    } 
    
    if (currentState === 'RETURNING') {
        // Return to normal only when safely inside
        if (distFromCenter < boundarySize * 0.7) {
            // Force a brief pause before resuming patrol
            return { nextState: 'IDLE', shouldAttack: false, shouldStrafe: false }; 
        }
        return { nextState: 'RETURNING', shouldAttack: false, shouldStrafe: false };
    }

    // --- PRIORITY 2: STANDARD BEHAVIOR ---
    switch (currentState) {
        case 'IDLE':
            if (canSee) {
                nextState = 'CHASE';
            } else if (timers.patrolWait <= 0) {
                nextState = 'PATROL';
            }
            break;

        case 'PATROL':
            if (canSee) {
                nextState = 'CHASE';
            } else if (patrolDest && enemyPosition.distanceTo(patrolDest) < 1.0) {
                nextState = 'IDLE';
            }
            break;

        case 'CHASE':
            if (!canSee) {
                // Lost sight. If memory is fresh, keep chasing (implicit).
                // If memory expired, start searching.
                if (timers.memory <= 0) {
                    nextState = 'SEARCHING';
                }
            } else {
                // Target Visible
                if (distToTarget < DISTANCES.ATTACK) {
                    if (timers.cooldown <= 0) {
                        nextState = 'ATTACKING';
                        shouldAttack = true;
                    } else {
                        // Cooldown active, try strafing
                        nextState = 'STRAFING';
                        shouldStrafe = true;
                    }
                }
            }
            break;

        case 'STRAFING':
            if (!canSee) {
                nextState = 'SEARCHING';
            } else if (timers.cooldown <= 0 && distToTarget < DISTANCES.ATTACK) {
                nextState = 'CHASE'; // Ready to attack
            } else if (timers.strafe <= 0 || distToTarget > DISTANCES.ATTACK * 1.5) {
                nextState = 'CHASE'; // Strafe finished or target ran away
            }
            break;

        case 'ATTACKING':
            if (timers.attack <= 0) {
                nextState = 'RECOVERY';
            }
            break;

        case 'RECOVERY':
            // Allow early exit from recovery for fluid movement
            if (timers.cooldown <= 0.5) { 
                nextState = 'CHASE';
            }
            break;

        case 'SEARCHING':
            if (canSee) {
                nextState = 'CHASE';
            } else if (timers.search <= 0) {
                nextState = 'IDLE'; // Gave up
            }
            break;
    }

    return { nextState, shouldAttack, shouldStrafe };
};

/**
 * Calculates the navigation destination based on the resolved state.
 */
export const calculateNavigation = (
    state: AIState, 
    enemyPosition: THREE.Vector3, 
    targetPosition: THREE.Vector3, 
    lastKnownPos: THREE.Vector3 | null, 
    patrolDest: THREE.Vector3 | null,
    canSee: boolean
) => {
    let destination = enemyPosition.clone();
    let targetFocus: THREE.Vector3 | null = null;

    switch (state) {
        case 'CHASE':
        case 'ATTACKING':
        case 'STRAFING':
        case 'RECOVERY':
            // Move towards real target or LKP if temporarily blinded
            destination.copy(canSee ? targetPosition : (lastKnownPos || enemyPosition));
            targetFocus = destination.clone();
            break;

        case 'SEARCHING':
            // Go to where we last saw them
            destination.copy(lastKnownPos || enemyPosition);
            targetFocus = null; // Look forward/path direction
            break;
            
        case 'PATROL':
            if (patrolDest) destination.copy(patrolDest);
            targetFocus = null;
            break;

        case 'RETURNING':
            destination.set(0, 0, 0); // Center of map
            targetFocus = null;
            break;

        case 'IDLE':
            destination.copy(enemyPosition); // Stay put
            targetFocus = null;
            break;
    }

    return { destination, targetFocus };
};
