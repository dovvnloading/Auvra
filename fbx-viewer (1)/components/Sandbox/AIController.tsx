
import React, { useMemo, useCallback } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { GraphRuntimeAPI } from '../AnimationGraph/GraphRuntime';
import { AI_CONFIG, resolveAITuning } from './AI/AIConfig';
import type { BehaviorTreeData, BlueprintStat } from '../../types';
import { useAIBrain } from './AI/useAIBrain';
import { useBehaviorBrain } from './AI/useBehaviorBrain';
import { useAILocomotion } from './AI/useAILocomotion';

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
}

export const AIController: React.FC<AIControllerProps> = ({
    enemyApi,
    enemyObject,
    targetObject,
    boundarySize,
    enabled,
    onDealDamage,
    stats,
    behaviorTree
}) => {
    // Callback wrapper
    const handleAttack = useCallback(() => {
        if (onDealDamage) onDealDamage();
    }, [onDealDamage]);

    // --- Systems ---
    const tuning = useMemo(() => resolveAITuning(stats), [stats]);
    const builtIn = useAIBrain(enemyApi, handleAttack, tuning);
    const authored = useBehaviorBrain(behaviorTree, enemyApi, handleAttack, tuning);
    const brain = behaviorTree && behaviorTree.behaviorNodes.length > 0 ? authored : builtIn;
    const locomotion = useAILocomotion();

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
        
        // 2. Think (Update Behavior Tree / State Machine)
        const brainOutput = brain.updateState({
            delta,
            enemyPosition: vEnemy,
            enemyForward: vForward,
            targetPosition: vTarget,
            distToTarget,
            distFromCenter,
            boundarySize
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
