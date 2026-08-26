import { useRef, useMemo } from 'react';
import * as THREE from 'three';
import { AI_CONFIG, AIState } from './AIConfig';

interface LocomotionInput {
  enemyObject: THREE.Object3D;
  destination: THREE.Vector3;
  targetFocus: THREE.Vector3 | null;
  state: AIState;
  delta: number;
}

export const useAILocomotion = () => {
  const physics = useRef({
    currentSpeed: 0,
    stamina: AI_CONFIG.STAMINA.MAX,
    isSprinting: false,
    strafeDirection: 1 // 1 or -1
  });

  // Reusable vectors to reduce GC
  const vDir = useMemo(() => new THREE.Vector3(), []);
  const vLook = useMemo(() => new THREE.Vector3(), []);
  const vRight = useMemo(() => new THREE.Vector3(), []);

  const updateLocomotion = (input: LocomotionInput) => {
    const { enemyObject, destination, targetFocus, state, delta } = input;
    const { PHYSICS, STAMINA, DISTANCES } = AI_CONFIG;

    const distToDest = enemyObject.position.distanceTo(destination);

    // 1. Stamina Logic
    let canSprint = false;
    if (physics.current.isSprinting) {
        physics.current.stamina -= delta * STAMINA.DRAIN_RATE;
        if (physics.current.stamina <= 0) {
            physics.current.stamina = 0;
            physics.current.isSprinting = false;
        } else {
            canSprint = true;
        }
    } else {
        physics.current.stamina += delta * STAMINA.REGEN_RATE;
        if (physics.current.stamina > STAMINA.MAX) physics.current.stamina = STAMINA.MAX;
        if (physics.current.stamina > STAMINA.MIN_TO_SPRINT) canSprint = true;
    }

    // 2. Determine Movement Vector & Speed
    let targetSpeed = 0;
    const moveVector = new THREE.Vector3();

    // -- BEHAVIOR VELOCITY --
    switch (state) {
        case 'IDLE':
        case 'ATTACKING':
        case 'SEARCHING': // Reached LKP, now idle looking
             // Stay put (mostly)
             if (state === 'SEARCHING' && distToDest > 0.5) {
                targetSpeed = PHYSICS.WALK_SPEED_MAX;
                moveVector.subVectors(destination, enemyObject.position).normalize();
             } else {
                targetSpeed = 0;
             }
             break;

        case 'PATROL':
            if (distToDest > 0.5) {
                targetSpeed = PHYSICS.WALK_SPEED_MAX * 0.7; // Casual walk
                moveVector.subVectors(destination, enemyObject.position).normalize();
            } else {
                targetSpeed = 0;
            }
            break;

        case 'RETURNING':
            targetSpeed = PHYSICS.RUN_SPEED_MAX;
            physics.current.isSprinting = true;
            moveVector.subVectors(destination, enemyObject.position).normalize();
            break;

        case 'CHASE':
            if (distToDest > DISTANCES.STOP) {
                moveVector.subVectors(destination, enemyObject.position).normalize();
                
                if (distToDest > DISTANCES.SPRINT && canSprint) {
                    targetSpeed = PHYSICS.RUN_SPEED_MAX;
                    physics.current.isSprinting = true;
                } else {
                    targetSpeed = PHYSICS.WALK_SPEED_MAX;
                    physics.current.isSprinting = false;
                }
            } else {
                targetSpeed = 0;
            }
            break;

        case 'STRAFING':
             // Calculate perpendicular vector to target
             vDir.subVectors(destination, enemyObject.position).normalize();
             vRight.crossVectors(new THREE.Vector3(0, 1, 0), vDir).normalize();
             
             // Randomly flip strafe dir occasionally handled by brain, but we apply here
             // We can use a simple oscillator or just the physics ref
             if (Math.random() < 0.01) physics.current.strafeDirection *= -1;

             moveVector.copy(vRight).multiplyScalar(physics.current.strafeDirection);
             
             // Also add a tiny bit of forward/backward to keep ideal distance
             if (distToDest > DISTANCES.ATTACK) moveVector.add(vDir.multiplyScalar(0.5));
             else if (distToDest < DISTANCES.ATTACK * 0.8) moveVector.add(vDir.multiplyScalar(-0.5));

             moveVector.normalize();
             targetSpeed = PHYSICS.STRAFE_SPEED;
             physics.current.isSprinting = false;
             break;
    }

    // 3. Physics Integration (Smooth Speed)
    if (targetSpeed > physics.current.currentSpeed) {
        physics.current.currentSpeed += PHYSICS.ACCELERATION * delta;
        if (physics.current.currentSpeed > targetSpeed) physics.current.currentSpeed = targetSpeed;
    } else {
        physics.current.currentSpeed -= PHYSICS.DECELERATION * delta;
        if (physics.current.currentSpeed < targetSpeed) physics.current.currentSpeed = targetSpeed;
    }

    // 4. Apply Rotation
    // If we have a TargetFocus, look at it. Otherwise look where we are going.
    const lookTarget = targetFocus ? targetFocus : (physics.current.currentSpeed > 0.1 ? destination : null);

    if (lookTarget) {
        vLook.subVectors(lookTarget, enemyObject.position);
        // Flatten y
        vLook.y = 0; 
        if (vLook.lengthSq() > 0.001) {
            const targetRotation = Math.atan2(vLook.x, vLook.z);
            let rotDiff = targetRotation - enemyObject.rotation.y;
            while (rotDiff > Math.PI) rotDiff -= Math.PI * 2;
            while (rotDiff < -Math.PI) rotDiff += Math.PI * 2;
            
            // Slower turn speed when attacking to give player chance to dodge
            const turnSpeed = state === 'ATTACKING' ? PHYSICS.ROTATION_SPEED * 0.2 : PHYSICS.ROTATION_SPEED;
            enemyObject.rotation.y += rotDiff * turnSpeed * delta;
        }
    } else if (state === 'PATROL' && physics.current.currentSpeed > 0.1) {
         // Face movement direction
         const targetRotation = Math.atan2(moveVector.x, moveVector.z);
         let rotDiff = targetRotation - enemyObject.rotation.y;
         while (rotDiff > Math.PI) rotDiff -= Math.PI * 2;
         while (rotDiff < -Math.PI) rotDiff += Math.PI * 2;
         enemyObject.rotation.y += rotDiff * PHYSICS.ROTATION_SPEED * delta;
    }

    // 5. Apply Position
    if (physics.current.currentSpeed > 0.01) {
        enemyObject.position.addScaledVector(moveVector, physics.current.currentSpeed * delta);
    }

    // 6. Calculate Local Graph Variables (InputX / InputY)
    // Project world moveVector onto local Forward/Right axis
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(enemyObject.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(enemyObject.quaternion);

    let inputY = moveVector.dot(forward); // Forward/Back
    let inputX = moveVector.dot(right);   // Right/Left

    // Normalize inputs based on speed ratio for blend space
    const speedRatio = physics.current.currentSpeed / PHYSICS.RUN_SPEED_MAX;
    
    // Boost values for graph so animations trigger even at low speeds
    if (physics.current.currentSpeed > 0.1) {
        inputY *= (physics.current.currentSpeed / PHYSICS.WALK_SPEED_MAX);
        inputX *= (physics.current.currentSpeed / PHYSICS.WALK_SPEED_MAX);
    } else {
        inputY = 0;
        inputX = 0;
    }

    return {
        graphInputX: inputX,
        graphInputY: inputY,
        graphSpeed: speedRatio, // Normalized 0-1 for blend space
        isSprinting: physics.current.isSprinting,
        stamina: physics.current.stamina
    };
  };

  return { updateLocomotion };
};