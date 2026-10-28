import { useRef, useMemo } from 'react';
import * as THREE from 'three';
import { AI_CONFIG, AIState, AITuning, DEFAULT_AI_TUNING } from './AIConfig';
import { usesPathfinding } from './AIStateMachine';
import { advanceWaypoint, useNavMeshContext, type LevelNavMesh } from '../../../runtime/navigation';
import { PLAYER_PHYSICS_ID, usePhysicsQueries } from '../../../runtime/physics';

interface LocomotionInput {
  enemyObject: THREE.Object3D;
  destination: THREE.Vector3;
  targetFocus: THREE.Vector3 | null;
  state: AIState;
  delta: number;
  /** Overrides the NavMeshContext navmesh; null forces straight-line steering. */
  navMesh?: LevelNavMesh | null;
  /** Per-enemy speeds and distances from blueprint stats. */
  tuning?: AITuning;
}

// Path following over the level navmesh (runtime/navigation.ts)
const NAVIGATION = {
  REPLAN_INTERVAL: 0.3,    // Seconds between replans while the destination moves
  REPLAN_JITTER: 0.15,     // Random extra so several agents do not replan on the same frame
  REPLAN_GOAL_SHIFT: 0.75, // Destination movement (m) that warrants a new path
  WAYPOINT_REACH: 0.45     // Distance (m, XZ) at which a waypoint counts as reached
};

interface PathState {
  navMesh: LevelNavMesh | null;
  /** The navmesh's version the path was planned on: an obstacle moving since then re-plans it. */
  version: number;
  state: AIState | null;
  path: THREE.Vector3[] | null;
  reachable: boolean;
  waypoint: number;
  goal: THREE.Vector3;
  replanIn: number;
}

interface Steering {
  /** Point to move toward this frame. */
  target: THREE.Vector3;
  /** True while heading for an intermediate waypoint rather than the destination. */
  detour: boolean;
  /** At the end of a path that cannot reach the destination: wait there instead of walking into the obstacle. */
  holding: boolean;
}

export const useAILocomotion = () => {
  const contextNavMesh = useNavMeshContext();
  const physicsQueries = usePhysicsQueries();
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
  const vNext = useMemo(() => new THREE.Vector3(), []);
  const vRay = useMemo(() => new THREE.Vector3(), []);
  const vDown = useMemo(() => new THREE.Vector3(0, -1, 0), []);

  const navigation = useRef<PathState>({
    navMesh: null,
    version: -1,
    state: null,
    path: null,
    reachable: true,
    waypoint: 1,
    goal: new THREE.Vector3(),
    replanIn: 0
  });

  // Picks the point to walk toward: the next path waypoint around obstacles, or the destination itself.
  const steer = (navMesh: LevelNavMesh | null, state: AIState, position: THREE.Vector3, destination: THREE.Vector3, delta: number): Steering => {
    const nav = navigation.current;
    if (!navMesh || !usesPathfinding(state)) {
        nav.path = null;
        nav.state = null;
        return { target: destination, detour: false, holding: false };
    }

    nav.replanIn -= delta;
    const shiftX = destination.x - nav.goal.x;
    const shiftZ = destination.z - nav.goal.z;
    const goalMoved = shiftX * shiftX + shiftZ * shiftZ > NAVIGATION.REPLAN_GOAL_SHIFT * NAVIGATION.REPLAN_GOAL_SHIFT;
    if (nav.navMesh !== navMesh || nav.version !== navMesh.version || nav.state !== state || (nav.replanIn <= 0 && (goalMoved || !nav.path))) {
        const plan = navMesh.planPath(position, destination, { partial: true });
        nav.navMesh = navMesh;
        nav.version = navMesh.version;
        nav.state = state;
        nav.goal.copy(destination);
        nav.replanIn = NAVIGATION.REPLAN_INTERVAL + Math.random() * NAVIGATION.REPLAN_JITTER;
        nav.path = plan && plan.points.length >= 2 ? plan.points : null;
        nav.reachable = plan ? plan.reachable : true;
        nav.waypoint = 1;
    }

    const path = nav.path;
    if (!path) return { target: destination, detour: false, holding: false }; // Off the navmesh: straight line
    // A corner counts as passed once the leg after it is clear from here; until then the agent keeps
    // heading for it, rather than cutting it into the wall it turns round.
    let next = advanceWaypoint(path, nav.waypoint, position, NAVIGATION.WAYPOINT_REACH);
    while (next > nav.waypoint && !navMesh.walkableLine(position, path[next])) next--;
    nav.waypoint = next;
    const last = path.length - 1;
    if (nav.waypoint < last) return { target: path[nav.waypoint], detour: true, holding: false };

    // Chasing or searching a walled-off spot: stop at the closest reachable point. A target off the
    // navmesh, in the air or up on a platform is not walled off, so the chase keeps closing in on it.
    // Patrol/return keep heading on so the state machine can still reach its goal.
    if (!nav.reachable && (state === 'CHASE' || state === 'SEARCHING') && navMesh.isWalledOff(destination)) {
        const end = path[last];
        const dx = end.x - position.x;
        const dz = end.z - position.z;
        const holding = dx * dx + dz * dz <= NAVIGATION.WAYPOINT_REACH * NAVIGATION.WAYPOINT_REACH;
        return { target: end, detour: false, holding };
    }
    // Final leg of a reachable path: track the live destination.
    return { target: destination, detour: false, holding: false };
  };

  const updateLocomotion = (input: LocomotionInput) => {
    const { enemyObject, destination, targetFocus, state, delta } = input;
    const { PHYSICS, STAMINA, DISTANCES } = AI_CONFIG;
    const tuning = input.tuning ?? DEFAULT_AI_TUNING;

    const distToDest = enemyObject.position.distanceTo(destination);
    const navMesh = input.navMesh !== undefined ? input.navMesh : contextNavMesh;
    const steering = steer(navMesh, state, enemyObject.position, destination, delta);
    const steerTarget = steering.target;

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
             if (state === 'SEARCHING' && distToDest > 0.5 && !steering.holding) {
                targetSpeed = tuning.walkSpeed;
                moveVector.subVectors(steerTarget, enemyObject.position).normalize();
             } else {
                targetSpeed = 0;
             }
             break;

        case 'PATROL':
            if (distToDest > 0.5 && !steering.holding) {
                targetSpeed = tuning.walkSpeed * 0.7; // Casual walk
                moveVector.subVectors(steerTarget, enemyObject.position).normalize();
            } else {
                targetSpeed = 0;
            }
            break;

        case 'RETURNING':
            targetSpeed = tuning.runSpeed;
            physics.current.isSprinting = true;
            moveVector.subVectors(steerTarget, enemyObject.position).normalize();
            break;

        case 'CHASE':
            if (distToDest > tuning.stopDistance && !steering.holding) {
                moveVector.subVectors(steerTarget, enemyObject.position).normalize();
                
                if (distToDest > DISTANCES.SPRINT && canSprint) {
                    targetSpeed = tuning.runSpeed;
                    physics.current.isSprinting = true;
                } else {
                    targetSpeed = tuning.walkSpeed;
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
             if (distToDest > tuning.attackRange) moveVector.add(vDir.multiplyScalar(0.5));
             else if (distToDest < tuning.attackRange * 0.8) moveVector.add(vDir.multiplyScalar(-0.5));

             moveVector.normalize();
             targetSpeed = tuning.strafeSpeed;
             physics.current.isSprinting = false;
             break;
    }

    // On a navmesh the surface gives the height, so agents move across it, not up or down toward a target.
    if (navMesh) {
        moveVector.y = 0;
        if (moveVector.lengthSq() > 1e-8) moveVector.normalize();
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
    // If we have a TargetFocus, look at it. Otherwise (or while detouring round an obstacle) look where we are going.
    const focus = steering.detour ? steerTarget : targetFocus;
    const lookTarget = focus ? focus : (physics.current.currentSpeed > 0.1 ? steerTarget : null);

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
    // On a navmesh the move slides along walls, stops at ledges and follows the surface's height (still
    // standing, it keeps the agent on the surface); off it, the agent moves freely.
    vNext.copy(enemyObject.position);
    if (physics.current.currentSpeed > 0.01) vNext.addScaledVector(moveVector, physics.current.currentSpeed * delta);
    const kept = navMesh ? navMesh.moveAlongSurface(enemyObject.position, vNext) : null;
    if (kept && navMesh) {
        // The navmesh is only flat between its polygons' corners; the physics ground under the agent
        // (terrain, floors, ramps, stairs) gives its exact height, a step up or down at most.
        const reach = navMesh.settings.maxStepHeight + 0.3;
        vRay.set(kept.x, enemyObject.position.y + reach, kept.z);
        const ground = physicsQueries.raycast(vRay, vDown, reach * 2 + 0.5, { excludeObjectId: PLAYER_PHYSICS_ID });
        if (ground) kept.y = ground.point.y;
    }
    enemyObject.position.copy(kept ?? vNext);

    // 6. Calculate Local Graph Variables (InputX / InputY)
    // Project world moveVector onto local Forward/Right axis
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(enemyObject.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(enemyObject.quaternion);

    let inputY = moveVector.dot(forward); // Forward/Back
    let inputX = moveVector.dot(right);   // Right/Left

    // Normalize inputs based on speed ratio for blend space
    const speedRatio = physics.current.currentSpeed / tuning.runSpeed;
    
    // Boost values for graph so animations trigger even at low speeds
    if (physics.current.currentSpeed > 0.1) {
        inputY *= (physics.current.currentSpeed / tuning.walkSpeed);
        inputX *= (physics.current.currentSpeed / tuning.walkSpeed);
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