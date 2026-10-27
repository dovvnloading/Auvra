
import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useRapier, type RapierContext } from '@react-three/rapier';
import { PlayerInputState } from './usePlayerControls';
import { BlueprintStat, DEFAULT_MODEL_IMPORT_SETTINGS, LevelObject } from '../../../types';
import { PLAYER_PHYSICS_ID, physicsUserData } from '../../../runtime/physics';
import { flatGroundHeight, terrainSurfaceHeight } from '../../../runtime/terrainPhysics';

interface PhysicsConfig {
    ROTATION_SPEED: number;
    MOVE_SPEED_WALK: number;
    MOVE_SPEED_RUN: number;
    STAMINA_DRAIN: number;
    STAMINA_REGEN: number;
    MAX_STAMINA: number;
    EXHAUSTION_RECOVERY: number;
    COLLISION_RADIUS: number;
}

const DEFAULT_CONFIG: PhysicsConfig = {
    ROTATION_SPEED: 15.0,
    MOVE_SPEED_WALK: 4.0,
    MOVE_SPEED_RUN: 7.5,
    STAMINA_DRAIN: 20,
    STAMINA_REGEN: 10,
    MAX_STAMINA: 100,
    EXHAUSTION_RECOVERY: 25,
    COLLISION_RADIUS: 0.5 // Player radius
};

/** Character controller tuning. Ratios scale with the character's measured height. */
export const CHARACTER = {
    RADIUS_RATIO: 0.12,      // Capsule radius
    STEP_RATIO: 0.15,        // Tallest ledge climbed without jumping
    SNAP_RATIO: 0.1,         // How far down the character sticks to slopes and stairs
    JUMP_RATIO: 0.3,         // Jump apex
    SKIN_RATIO: 0.004,       // Gap the controller keeps between the capsule and the world
    MAX_CLIMB_DEG: 50,       // Steeper slopes block the character
    MIN_SLIDE_DEG: 35,       // Steeper slopes slide the character down
    MASS: 80,                // Pushes dynamic bodies as if this heavy
    TERMINAL_SPEED: 60,
    DEFAULT_GRAVITY: -9.81,  // Used when the world has no downward gravity
    MAX_STEP: 1 / 20,        // Longest frame simulated in one go (tab switches, hitches)
    TELEPORT_DISTANCE: 0.01, // Model moved by someone else (spawn, restart, load) further than this
};

/** Blueprint speed stats are Unreal-style centimetres per second (the default player walks at 450). */
const STAT_UNITS_PER_WORLD_UNIT = 100;

export interface LocomotionSpeeds {
    walk: number;
    run: number;
}

/** World-unit speeds from a blueprint's 'Walk Speed' and 'Run Speed' stats, falling back to the built-in defaults. */
export const resolveLocomotionSpeeds = (stats: readonly BlueprintStat[] | undefined): LocomotionSpeeds => {
    const read = (name: string): number | null => {
        const value = stats?.find(stat => stat.name === name)?.value;
        return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value / STAT_UNITS_PER_WORLD_UNIT : null;
    };
    const walk = read('Walk Speed') ?? DEFAULT_CONFIG.MOVE_SPEED_WALK;
    const run = read('Run Speed') ?? walk * (DEFAULT_CONFIG.MOVE_SPEED_RUN / DEFAULT_CONFIG.MOVE_SPEED_WALK);
    return { walk, run };
};

// --- FALLBACK GROUND ---

/** The level's flat ground height (flatGroundHeight), per obstacle list and per terrain, so a frame does not rescan them. */
const flatGroundHeights = new WeakMap<object, number>();

const cachedFlatGroundHeight = (key: object, terrains: () => readonly LevelObject[]): number => {
    const cached = flatGroundHeights.get(key);
    if (cached !== undefined) return cached;
    const height = flatGroundHeight(terrains());
    flatGroundHeights.set(key, height);
    return height;
};

/**
 * Ground under a point when nothing in the physics world is: the terrain surface, else the level's
 * flat ground (y = 0 unless a terrain reaches below it, see flatGroundHeight), where bodies land too.
 */
const legacyGroundHeight = (x: number, z: number, terrain: LevelObject | null, obstacles: readonly LevelObject[]): number => {
    const surface = terrain ? terrainSurfaceHeight(x, z, terrain) : null;
    if (surface !== null) return surface;
    const level = cachedFlatGroundHeight(obstacles, () => obstacles.filter(obj => obj.type === 'terrain'));
    return terrain ? Math.min(level, cachedFlatGroundHeight(terrain, () => [terrain])) : level;
};

// --- RAPIER CHARACTER ---

type RapierWorld = RapierContext['world'];
type CharacterController = ReturnType<RapierWorld['createCharacterController']>;
type CharacterBody = ReturnType<RapierWorld['createRigidBody']>;
type CharacterCollider = ReturnType<RapierWorld['createCollider']>;
type GroundRay = InstanceType<RapierContext['rapier']['Ray']>;

/** The Rapier world and module a character moves in: useRapier's context, or the same pair built without React. */
export type CharacterPhysicsContext = Pick<RapierContext, 'world' | 'rapier'>;

export interface CharacterRig {
    world: RapierWorld;
    model: THREE.Object3D;
    controller: CharacterController;
    body: CharacterBody;
    collider: CharacterCollider;
    /** Straight down from the capsule centre, to tell whether any collider lies below. */
    groundRay: GroundRay;
    height: number;
    /** Capsule centre above the model's origin, which sits at the character's feet. */
    centreOffset: number;
    centre: THREE.Vector3;
    /** Where the model was last placed, to notice when something else moves it. */
    placedAt: THREE.Vector3;
    verticalSpeed: number;
    grounded: boolean;
}

/**
 * The surrounding Rapier world, or null without one (the Sandbox tab, or a PhysicsWorld whose engine
 * failed to load). useRapier reads its context before throwing, so the hooks called are the same either way.
 */
const useOptionalRapier = (): RapierContext | null => {
    try {
        return useRapier();
    } catch {
        return null;
    }
};

const measureCharacterHeight = (model: THREE.Object3D): number => {
    model.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(model);
    const height = box.max.y - box.min.y;
    return Number.isFinite(height) && height > 0.2 ? height : DEFAULT_MODEL_IMPORT_SETTINGS.targetSize;
};

/** A kinematic capsule sized to the model, standing where the model stands, with its character controller. */
export const createCharacterRig = ({ world, rapier }: CharacterPhysicsContext, model: THREE.Object3D): CharacterRig => {
    const height = measureCharacterHeight(model);
    const radius = height * CHARACTER.RADIUS_RATIO;
    const halfHeight = Math.max(0.01, height / 2 - radius);
    const centreOffset = halfHeight + radius;
    const centre = model.position.clone();
    centre.y += centreOffset;

    const body = world.createRigidBody(
        rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(centre.x, centre.y, centre.z)
    );
    // Raycast hits and trigger events report this body as the player.
    body.userData = physicsUserData(PLAYER_PHYSICS_ID);

    // Kinematic-fixed pairs are off by default; enable them so fixed trigger volumes report the player.
    const collider = world.createCollider(
        rapier.ColliderDesc.capsule(halfHeight, radius)
            .setActiveCollisionTypes(
                rapier.ActiveCollisionTypes.DEFAULT
                | rapier.ActiveCollisionTypes.KINEMATIC_FIXED
                | rapier.ActiveCollisionTypes.KINEMATIC_KINEMATIC
            )
            .setActiveEvents(rapier.ActiveEvents.COLLISION_EVENTS),
        body
    );

    const controller = world.createCharacterController(Math.max(0.01, height * CHARACTER.SKIN_RATIO));
    controller.setUp({ x: 0, y: 1, z: 0 });
    controller.setSlideEnabled(true);
    controller.setMaxSlopeClimbAngle(THREE.MathUtils.degToRad(CHARACTER.MAX_CLIMB_DEG));
    controller.setMinSlopeSlideAngle(THREE.MathUtils.degToRad(CHARACTER.MIN_SLIDE_DEG));
    controller.enableAutostep(height * CHARACTER.STEP_RATIO, radius * 0.5, false);
    controller.enableSnapToGround(height * CHARACTER.SNAP_RATIO);
    controller.setApplyImpulsesToDynamicBodies(true);
    controller.setCharacterMass(CHARACTER.MASS);

    return {
        world, model, controller, body, collider, height, centreOffset, centre,
        groundRay: new rapier.Ray({ x: centre.x, y: centre.y, z: centre.z }, { x: 0, y: -1, z: 0 }),
        placedAt: model.position.clone(),
        verticalSpeed: 0,
        grounded: false,
    };
};

const disposeCharacterRig = (rig: CharacterRig) => {
    try {
        rig.world.removeCharacterController(rig.controller);
        rig.world.removeRigidBody(rig.body);
    } catch {
        // The world was freed with its <Physics>; the body and controller went with it.
    }
};

// Reusable math objects
const _desired = new THREE.Vector3();
const _rootMove = new THREE.Vector3();

const hasPhysicsComponent = (obj: LevelObject) =>
    !!obj.components?.some(component => component.enabled !== false && (component.type === 'collider' || component.type === 'rigidBody'));

/** Props without collider components still block the player with a circle footprint, as before physics. */
const isLegacySolidProp = (obj: LevelObject) => obj.type === 'prop' && !!obj.modelId && !hasPhysicsComponent(obj);

/**
 * Circle push-out: moves `position` (XZ) out of every included object's footprint, whose radius is
 * max(scale.x, scale.z) / 2, so the player's circle never overlaps it.
 */
const pushOutOfFootprints = (
    position: { x: number; z: number },
    obstacles: readonly LevelObject[],
    include: (obj: LevelObject) => boolean,
    radius: number
) => {
    for (const obj of obstacles) {
        if (!include(obj)) continue;
        const minDist = radius + Math.max(obj.scale[0], obj.scale[2]) * 0.5;
        const dx = position.x - obj.position[0];
        const dz = position.z - obj.position[2];
        const distSq = dx * dx + dz * dz;
        if (distSq >= minDist * minDist) continue;
        const dist = Math.sqrt(distSq);
        if (dist <= 0.001) continue;
        position.x += (dx / dist) * (minDist - dist);
        position.z += (dz / dist) * (minDist - dist);
    }
};

/**
 * One frame of Rapier KinematicCharacterController movement for `character`: gravity, jumping, slopes
 * and steps against the level's colliders. Where no collider lies below (levels authored before
 * colliders), `terrain` or else the level's flat ground (flatGroundHeight, y = 0 unless a terrain
 * reaches below it, as for bodies) still holds the player up as it did without physics. It only
 * catches the player near that surface, so a player standing on colliders below it is never pulled up.
 * `obstacles` are the level's objects; props among them without physics components keep their footprint.
 */
export const stepCharacterPhysics = (
    context: CharacterPhysicsContext,
    character: CharacterRig,
    input: Pick<PlayerInputState, 'jumpPressed'>,
    worldMoveVec: { readonly x: number; readonly z: number },
    speed: number,
    delta: number,
    obstacles: readonly LevelObject[],
    terrain: LevelObject | null
) => {
    const { rapier, world: physicsWorld } = context;
    const { centre, model: modelObject } = character;
    const dt = Math.min(delta, CHARACTER.MAX_STEP);

    // Spawned, restarted or loaded elsewhere: move the capsule to the model instead of the reverse.
    if (modelObject.position.distanceTo(character.placedAt) > CHARACTER.TELEPORT_DISTANCE) {
        centre.copy(modelObject.position);
        centre.y += character.centreOffset;
        character.collider.setTranslation(centre);
        character.body.setTranslation(centre, true);
        character.verticalSpeed = 0;
        character.grounded = false;
    }

    const gravity = physicsWorld.gravity.y < 0 ? physicsWorld.gravity.y : CHARACTER.DEFAULT_GRAVITY;
    if (character.grounded && input.jumpPressed) {
        character.verticalSpeed = Math.sqrt(2 * -gravity * character.height * CHARACTER.JUMP_RATIO);
    }
    character.verticalSpeed = Math.max(-CHARACTER.TERMINAL_SPEED, character.verticalSpeed + gravity * dt);

    _desired.set(worldMoveVec.x * speed * dt, character.verticalSpeed * dt, worldMoveVec.z * speed * dt);
    character.controller.computeColliderMovement(character.collider, _desired, rapier.QueryFilterFlags.EXCLUDE_SENSORS);
    const moved = character.controller.computedMovement();
    let grounded = character.controller.computedGrounded();
    centre.set(centre.x + moved.x, centre.y + moved.y, centre.z + moved.z);
    // Props with no collider component (levels authored before colliders) keep their footprint.
    pushOutOfFootprints(centre, obstacles, isLegacySolidProp, DEFAULT_CONFIG.COLLISION_RADIUS);

    // Head hit a ceiling: stop rising.
    if (character.verticalSpeed > 0 && moved.y < _desired.y * 0.5) character.verticalSpeed = 0;

    const { groundRay } = character;
    groundRay.origin = { x: centre.x, y: centre.y, z: centre.z };
    const hasGroundCollider = physicsWorld.castRay(
        groundRay, 1e5, true,
        rapier.QueryFilterFlags.EXCLUDE_SENSORS, undefined, character.collider, character.body
    ) !== null;
    if (!hasGroundCollider) {
        const floor = legacyGroundHeight(centre.x, centre.z, terrain, obstacles);
        const depth = floor - (centre.y - character.centreOffset);
        const reach = character.height * CHARACTER.STEP_RATIO + Math.abs(moved.y);
        if (depth >= 0 && depth <= reach) {
            centre.y = floor + character.centreOffset;
            grounded = true;
        }
    }

    if (grounded && character.verticalSpeed < 0) character.verticalSpeed = 0;
    character.grounded = grounded;

    // The collider moves now so the next frame's sweep starts here even if the world has not stepped yet;
    // the body follows on the next step.
    character.collider.setTranslation(centre);
    character.body.setNextKinematicTranslation(centre);

    modelObject.position.set(centre.x, centre.y - character.centreOffset, centre.z);
    character.placedAt.copy(modelObject.position);
};

export const usePlayerPhysics = (
    modelObject: THREE.Object3D,
    camera: THREE.Camera,
    onStaminaChange?: (val: number) => void,
    obstacles: LevelObject[] = [], // Level collision data (no physics world)
    stats?: readonly BlueprintStat[] // Blueprint 'Walk Speed' / 'Run Speed'
) => {
    const physics = useOptionalRapier();
    const speeds = useMemo(() => resolveLocomotionSpeeds(stats), [stats]);

    const stamina = useRef(DEFAULT_CONFIG.MAX_STAMINA);
    const reportedStamina = useRef<number | null>(null);
    const isExhausted = useRef(false);
    const rig = useRef<CharacterRig | null>(null);

    // Cache the terrain object reference to avoid searching every frame
    const activeTerrain = useRef<LevelObject | null>(null);

    // Update terrain ref occasionally or when obstacles change
    if (!activeTerrain.current || !obstacles.includes(activeTerrain.current)) {
        activeTerrain.current = obstacles.find(o => o.type === 'terrain') || null;
    }

    // Layout cleanup runs before <Physics> frees its world in a passive effect, so the capsule
    // leaves a live world. The world is a stable proxy for the lifetime of its <Physics>.
    const world = physics?.world ?? null;
    useLayoutEffect(() => () => {
        if (rig.current) disposeCharacterRig(rig.current);
        rig.current = null;
    }, [world]);

    /** The rig for the current world and model, created on first use (after the model has been placed). */
    const getRig = (context: RapierContext): CharacterRig => {
        const current = rig.current;
        if (current && current.world === context.world && current.model === modelObject) return current;
        if (current) disposeCharacterRig(current);
        rig.current = createCharacterRig(context, modelObject);
        return rig.current;
    };

    /** Kinematic movement for the Sandbox: circle push-out against props, feet snapped to the terrain or the flat ground. */
    const moveWithoutPhysics = (worldMoveVec: THREE.Vector3, speed: number, delta: number) => {
        const { COLLISION_RADIUS } = DEFAULT_CONFIG;

        // Clone current pos to calculate next
        const nextPos = modelObject.position.clone();

        if (worldMoveVec.lengthSq() > 0.001) {
            // Predict next position (XZ)
            nextPos.addScaledVector(worldMoveVec, speed * delta);

            // Simple Circle-Circle Collision against Props
            pushOutOfFootprints(nextPos, obstacles, obj => obj.type !== 'foliage' && obj.type !== 'terrain', COLLISION_RADIUS);
        }

        // Terrain Ground Snapping
        // Always run this, even if not moving, to ensure we stay on ground if terrain changes
        // or if we spawned in air.
        nextPos.y = legacyGroundHeight(nextPos.x, nextPos.z, activeTerrain.current, obstacles);

        // Apply final position
        modelObject.position.copy(nextPos);
    };

    /**
     * `rootTravel` is this frame's world-space root-motion travel from the animation graph; when
     * given, it moves the character instead of the input direction and speed (rotation, stamina
     * and animation inputs still follow the input).
     */
    const updatePhysics = (input: PlayerInputState, delta: number, rootTravel?: { readonly x: number; readonly z: number } | null) => {
        const {
            ROTATION_SPEED, STAMINA_DRAIN, STAMINA_REGEN, MAX_STAMINA, EXHAUSTION_RECOVERY
        } = DEFAULT_CONFIG;

        // --- 1. Camera Basis ---
        const camForward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        camForward.y = 0;
        camForward.normalize();

        const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        camRight.y = 0;
        camRight.normalize();

        // --- 2. Calculate World Movement Vector ---
        // Capped at length 1: keys move at full speed, a half-tilted stick at half speed.
        const worldMoveVec = new THREE.Vector3();
        if (input.moveX !== 0 || input.moveY !== 0) {
            worldMoveVec.addScaledVector(camForward, input.moveY);
            worldMoveVec.addScaledVector(camRight, input.moveX);
            if (worldMoveVec.lengthSq() > 1) worldMoveVec.normalize();
        }
        const isMoving = worldMoveVec.lengthSq() > 0.001;

        // --- 3. Handle Rotation ---
        let targetRotation = modelObject.rotation.y;

        if (input.isAiming) {
            targetRotation = Math.atan2(camForward.x, camForward.z);
        } else if (isMoving) {
            targetRotation = Math.atan2(worldMoveVec.x, worldMoveVec.z);
        }

        let rotDiff = targetRotation - modelObject.rotation.y;
        while (rotDiff > Math.PI) rotDiff -= Math.PI * 2;
        while (rotDiff < -Math.PI) rotDiff += Math.PI * 2;

        const effectiveRotSpeed = input.isAiming ? ROTATION_SPEED * 2.0 : ROTATION_SPEED;
        modelObject.rotation.y += rotDiff * effectiveRotSpeed * delta;

        // --- 4. Stamina & Hysteresis Logic ---
        let effectiveSprint = false;

        if (isExhausted.current) {
            if (stamina.current > EXHAUSTION_RECOVERY) {
                isExhausted.current = false;
            }
        }

        if (input.isSprinting && isMoving && !input.isAiming && !isExhausted.current) {
            effectiveSprint = true;
            stamina.current = Math.max(0, stamina.current - STAMINA_DRAIN * delta);
            if (stamina.current <= 0) {
                stamina.current = 0;
                isExhausted.current = true;
                effectiveSprint = false;
            }
        } else {
            stamina.current = Math.min(MAX_STAMINA, stamina.current + STAMINA_REGEN * delta);
        }

        // Report whole-point changes only, so HUD state is not updated on every frame.
        const roundedStamina = Math.round(stamina.current);
        if (onStaminaChange && roundedStamina !== reportedStamina.current) {
            reportedStamina.current = roundedStamina;
            onStaminaChange(roundedStamina);
        }

        // --- 5. Apply Movement & Collision ---
        let currentSpeed = effectiveSprint ? speeds.run : speeds.walk;
        if (input.isAiming) currentSpeed *= 0.5;

        // Root motion travels exactly its distance over the step, as a unit direction at length / step.
        const rootStep = physics ? Math.min(delta, CHARACTER.MAX_STEP) : delta;
        const rootLength = rootTravel && rootStep > 0 ? Math.hypot(rootTravel.x, rootTravel.z) : 0;
        const moveVec = rootTravel && rootStep > 0
            ? (rootLength > 0 ? _rootMove.set(rootTravel.x / rootLength, 0, rootTravel.z / rootLength) : _rootMove.set(0, 0, 0))
            : worldMoveVec;
        const moveSpeed = rootTravel && rootStep > 0 ? rootLength / rootStep : currentSpeed;
        if (physics) {
            stepCharacterPhysics(physics, getRig(physics), input, moveVec, moveSpeed, delta, obstacles, activeTerrain.current);
        } else {
            moveWithoutPhysics(moveVec, moveSpeed, delta);
        }

        // --- 6. Calculate Animation Inputs ---
        const charForward = new THREE.Vector3(0, 0, 1).applyQuaternion(modelObject.quaternion);
        const charRight = new THREE.Vector3(1, 0, 0).applyQuaternion(modelObject.quaternion);

        let localX = worldMoveVec.dot(charRight);
        let localY = worldMoveVec.dot(charForward);

        if (Math.abs(localX) < 0.05) localX = 0;
        if (Math.abs(localY) < 0.05) localY = 0;

        return {
            isMoving,
            effectiveSprint,
            localInputX: localX,
            localInputY: localY,
            /** Off the ground in the physics world (jumping or falling); always false without one. */
            isAirborne: physics ? !(rig.current?.grounded ?? true) : false
        };
    };

    return { updatePhysics, hasPhysicsWorld: physics !== null };
};
