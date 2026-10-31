
import React, { useMemo, useCallback, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { GraphRuntimeAPI } from '../AnimationGraph/GraphRuntime';
import { AI_CONFIG, resolveAITuning } from './AI/AIConfig';
import type { BehaviorTreeData, BlueprintStat } from '../../types';
import { useAIBrain } from './AI/useAIBrain';
import { useBehaviorBrain, type EnemyFireHandler } from './AI/useBehaviorBrain';
import type { ResolvedWeapon } from '../../runtime/weapons';
import { useAILocomotion } from './AI/useAILocomotion';
import { usePhysicsQueries } from '../../runtime/physicsQueries';
import { CHEST_HEIGHT, EYE_HEIGHT, characterHeight, lineOfSight, useNoiseBus } from '../../runtime/perception';
import type { Perception } from './AI/AISenses';
import { SplinePatrol } from '../../runtime/patrolPath';
import { getLiveSpline } from '../../runtime/splineRegistry';

/** Seconds between line of sight checks (a physics ray each). */
const SIGHT_CHECK_INTERVAL = 0.15;

interface AIControllerProps {
    enemyApi: React.RefObject<GraphRuntimeAPI | undefined>;
    enemyObject: THREE.Object3D | null;
    targetObject: THREE.Object3D | null;
    boundarySize: number;
    enabled: boolean;
    onDealDamage?: () => void;
    /** Enemy blueprint stats ('Speed', 'Attack Range', 'Attack Cooldown', 'Sight Range'). */
    stats?: readonly BlueprintStat[];
    /** The blueprint's authored behavior; without one the built-in AI decides. */
    behaviorTree?: BehaviorTreeData;
    /** The weapon a Shoot action fires, and what to do with its shots each frame. */
    weapon?: ResolvedWeapon | null;
    onFire?: EnemyFireHandler;
    /** Who this enemy is to the noise bus: it does not hear its own shots. */
    perceptionId?: string | null;
    /** An object with a Spline component the enemy patrols along (its spawner's Patrol Path). */
    patrolPath?: string;
}

export const AIController: React.FC<AIControllerProps> = ({
    enemyApi,
    enemyObject,
    targetObject,
    boundarySize,
    enabled,
    onDealDamage,
    stats,
    behaviorTree,
    weapon = null,
    onFire,
    perceptionId = null,
    patrolPath = ''
}) => {
    // Callback wrapper
    const handleAttack = useCallback(() => {
        if (onDealDamage) onDealDamage();
    }, [onDealDamage]);

    // --- Systems ---
    const tuning = useMemo(() => resolveAITuning(stats), [stats]);
    const patrol = useMemo(() => (patrolPath ? new SplinePatrol(() => getLiveSpline(patrolPath, 'runtime')) : null), [patrolPath]);
    const builtIn = useAIBrain(enemyApi, handleAttack, tuning, patrol);
    const authored = useBehaviorBrain(behaviorTree, enemyApi, handleAttack, tuning, weapon, onFire, patrol);
    const brain = behaviorTree && behaviorTree.behaviorNodes.length > 0 ? authored : builtIn;
    const locomotion = useAILocomotion();
    const physics = usePhysicsQueries();
    const noises = useNoiseBus();
    const senses = useRef({ nextSight: 0, clock: 0, lineOfSight: true, heardSince: noises?.now() ?? 0 });
    const vEye = useMemo(() => new THREE.Vector3(), []);
    const vChest = useMemo(() => new THREE.Vector3(), []);

    // Reusable Vectors
    const vEnemy = useMemo(() => new THREE.Vector3(), []);
    const vTarget = useMemo(() => new THREE.Vector3(), []);
    const vForward = useMemo(() => new THREE.Vector3(), []);

    useFrame((_state, delta) => {
        if (!enabled || !enemyApi.current || !enemyObject || !targetObject) return;

        // CRITICAL: Check death status using the proper name lookup
        const isDead = enemyApi.current.getVariable('IsDead');
        
        // If dead, immediately ZERO OUT inputs to freeze animation graph logic and return.
        // This stops the Brain from running, preventing new attacks or movement.
        if (isDead === true) {
            enemyApi.current.setVariable('Speed', 0);
            enemyApi.current.setVariable('InputX', 0);
            enemyApi.current.setVariable('InputY', 0);
            enemyApi.current.setVariable('AttackIndex', 0); // Force stop attacking
            enemyApi.current.setVariable('IsSprinting', false);
            return; 
        }

        // 1. Analyze World
        vEnemy.copy(enemyObject.position);
        vTarget.copy(targetObject.position);
        
        // Get Forward vector
        vForward.set(0, 0, 1).applyQuaternion(enemyObject.quaternion);

        const distToTarget = vEnemy.distanceTo(vTarget);
        const distFromCenter = Math.max(Math.abs(vEnemy.x), Math.abs(vEnemy.z));

        // Senses: whether walls hide the target (a ray now and then), and what was heard since last frame.
        const sensed = senses.current;
        sensed.clock += delta;
        if (sensed.clock >= sensed.nextSight) {
            sensed.nextSight = sensed.clock + SIGHT_CHECK_INTERVAL;
            vEye.copy(vEnemy).setY(vEnemy.y + characterHeight(enemyObject) * EYE_HEIGHT);
            vChest.copy(vTarget).setY(vTarget.y + characterHeight(targetObject) * CHEST_HEIGHT);
            sensed.lineOfSight = lineOfSight(physics, vEye, vChest);
        }
        let heard: THREE.Vector3 | null = null;
        if (noises) {
            heard = noises.heardSince(vEnemy, sensed.heardSince, perceptionId)?.position ?? null;
            sensed.heardSince = noises.now();
        }
        const perception: Perception = { lineOfSight: sensed.lineOfSight, heard };
        
        // 2. Think (Update Behavior Tree / State Machine)
        const brainOutput = brain.updateState({
            delta,
            enemyPosition: vEnemy,
            enemyForward: vForward,
            targetPosition: vTarget,
            distToTarget,
            distFromCenter,
            boundarySize,
            perception
        });

        // 3. Act (Update Physics & Transform)
        const physicsState = locomotion.updateLocomotion({
            enemyObject,
            destination: brainOutput.destination,
            targetFocus: brainOutput.targetFocus,
            state: brainOutput.state,
            delta,
            tuning
        });

        // 4. Fail-safe Boundary Clamp
        const hardLimit = boundarySize + AI_CONFIG.DISTANCES.BOUNDARY_BUFFER;
        if (distFromCenter > hardLimit) {
            enemyObject.position.x = THREE.MathUtils.clamp(enemyObject.position.x, -boundarySize, boundarySize);
            enemyObject.position.z = THREE.MathUtils.clamp(enemyObject.position.z, -boundarySize, boundarySize);
        }

        // 5. Update Animation Graph
        // The InputX/InputY drive the blendspace (Strafe/Forward)
        enemyApi.current.setVariable('InputY', physicsState.graphInputY);
        enemyApi.current.setVariable('InputX', physicsState.graphInputX);
        enemyApi.current.setVariable('Speed', physicsState.graphSpeed); // For 1D blends or logic triggers
        enemyApi.current.setVariable('IsSprinting', physicsState.isSprinting);
        enemyApi.current.setVariable('Stamina', physicsState.stamina);
    });

    return null;
};
