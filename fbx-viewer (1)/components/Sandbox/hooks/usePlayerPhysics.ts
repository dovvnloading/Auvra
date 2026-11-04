
import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useRapier, type RapierContext } from '@react-three/rapier';
import { PlayerInputState } from './usePlayerControls';
import { BlueprintStat, DEFAULT_MODEL_IMPORT_SETTINGS, LevelObject } from '../../../types';
import { PLAYER_PHYSICS_ID, physicsUserData } from '../../../runtime/physicsQueries';
import { flatGroundHeight, terrainSurfaceHeight } from '../../../runtime/terrainPhysics';
import { characterMotionOf } from '../../../runtime/locomotion/characterMotion';
import { stepSpring, wrapAngle, type Spring1 } from '../../../runtime/locomotion/springs';

interface PhysicsConfig {
    MOVE_SPEED_WALK: number;
    MOVE_SPEED_RUN: number;
    STAMINA_DRAIN: number;
    STAMINA_REGEN: number;
    MAX_STAMINA: number;
    EXHAUSTION_RECOVERY: number;
    COLLISION_RADIUS: number;
}

const DEFAULT_CONFIG: PhysicsConfig = {
    MOVE_SPEED_WALK: 4.0,
    MOVE_SPEED_RUN: 7.5,
    STAMINA_DRAIN: 20,
    STAMINA_REGEN: 10,
    MAX_STAMINA: 100,
    EXHAUSTION_RECOVERY: 25,
    COLLISION_RADIUS: 0.5 // Player radius
};

/** Standing and aiming, the body keeps its facing until the aim swings this far from it (radians). */
export const TURN_IN_PLACE_START = THREE.MathUtils.degToRad(70);
/** A turn in place ends once the body faces the aim this closely (radians). */
export const TURN_IN_PLACE_END = THREE.MathUtils.degToRad(4);
/** The fastest a turn in place turns the body, in radians per second. */
export const TURN_IN_PLACE_SPEED = THREE.MathUtils.degToRad(300);

/**
 * Where an aiming character faces. Moving, it faces the aim. Standing, its feet stay put while the
 * upper body follows the aim (CharacterIK), until the aim is TURN_IN_PLACE_START away; then it
 * turns in place until it faces the aim again. `target` is the yaw to turn toward (null holds the
 * facing) and `turning` whether a turn in place is under way.
 */
export const aimFacing = (bodyYaw: number, aimYaw: number, moving: boolean, turning: boolean): { target: number | null; turning: boolean } => {
    if (moving) return { target: aimYaw, turning: false };
    const away = Math.abs(wrapAngle(aimYaw - bodyYaw));
    if (turning ? away <= TURN_IN_PLACE_END : away < TURN_IN_PLACE_START) return { target: null, turning: false };
    return { target: aimYaw, turning: true };
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
    FALL_DELAY: 0.15,        // Seconds off the ground, without a jump, before it counts as a fall (not a bump or a step down)
    HUMAN_HEIGHT: 1.8,       // A character this tall (or less) falls at the world's gravity; a taller one as if the world were scaled to it
    STEP_SMOOTHING: 0.05,    // Seconds (a spring half-life) the body takes to catch up with a stair step the capsule climbed or dropped at once
};

/**
 * How much stronger than the world's gravity a character falls: 1 up to a person's height, and in
 * proportion to its height beyond, for characters imported larger than life (models used to come in
 * 5 units tall), so a jump to the same share of the body takes the time it would for a person.
 */
export const characterGravityScale = (height: number): number => Math.max(1, height / CHARACTER.HUMAN_HEIGHT);

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
    /** Seconds since the character last stood on something. */
    airborneTime: number;
    /** Left the ground by jumping, and has not landed since. */
    jumped: boolean;
    /** The collider's own solver groups while the character rides in a vehicle (it pushes nothing then); null on foot. */
    ridingGroups: number | null;
    /** The world's gravity is multiplied by this for the character (characterGravityScale). */
    gravityScale: number;
    /**
     * How far the drawn body sits above (or below) the capsule: a stair step climbed or dropped in one
     * frame moves the capsule at once, and the body follows over a moment (CHARACTER.STEP_SMOOTHING).
     */
    stepOffset: Spring1;
    /** The wall the last step ran into (its outward normal on the ground), when it was blocked by one. */
    wall: { x: number; z: number; hit: boolean };
}

/** Off the ground after a jump, or for longer than FALL_DELAY: running over a bump or down a step is not a fall. */
export const isFalling = (character: Pick<CharacterRig, 'grounded' | 'jumped' | 'airborneTime'>): boolean =>
    !character.grounded && (character.jumped || character.airborneTime > CHARACTER.FALL_DELAY);

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

/** A character model's standing height, world units; the default import size when it cannot be measured. */
export const measureCharacterHeight = (model: THREE.Object3D): number => {
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
        airborneTime: 0,
        jumped: false,
        ridingGroups: null,
        gravityScale: characterGravityScale(height),
        stepOffset: { x: 0, v: 0 },
        wall: { x: 0, z: 0, hit: false },
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
const _velocity = new THREE.Vector3();
const _move = { x: 0, z: 0 };

const hasPhysicsComponent = (obj: LevelObject) =>
    !!obj.components?.some(component => component.enabled !== false && (component.type === 'collider' || component.type === 'rigidBody'));

/** Objects the player walks into to collect never block them. */
const isPickup = (obj: LevelObject) =>
    !!obj.components?.some(component => component.enabled !== false && component.type === 'pickup');

/** Props without collider components still block the player with a circle footprint, as before physics; pickups do not. */
const isLegacySolidProp = (obj: LevelObject) => obj.type === 'prop' && !!obj.modelId && !hasPhysicsComponent(obj) && !isPickup(obj);

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

/** A face this close to vertical (the y of its normal) is a wall rather than ground, a slope or a step's edge. */
const WALL_NORMAL_Y = 0.1;

/**
 * The wall the step just taken ran into most squarely, into `character.wall`: a near-vertical face the
 * move pressed against without rising (rising, it was climbing a step or a slope, not blocked).
 */
const findWall = (character: CharacterRig, rose: number) => {
    const wall = character.wall;
    wall.hit = false;
    if (rose > 1e-4) return;
    let most = 0;
    for (let i = 0, count = character.controller.numComputedCollisions(); i < count; i++) {
        const normal = character.controller.computedCollision(i)?.normal1;
        if (!normal || Math.abs(normal.y) > WALL_NORMAL_Y) continue;
        const length = Math.hypot(normal.x, normal.z);
        if (length < 1e-6) continue;
        const x = normal.x / length, z = normal.z / length;
        // How squarely the move went into it.
        const into = -(_desired.x * x + _desired.z * z);
        if (into <= most) continue;
        most = into;
        wall.x = x;
        wall.z = z;
        wall.hit = true;
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
        character.airborneTime = 0;
        character.jumped = false;
        character.stepOffset.x = 0;
        character.stepOffset.v = 0;
    }

    const gravity = (physicsWorld.gravity.y < 0 ? physicsWorld.gravity.y : CHARACTER.DEFAULT_GRAVITY) * character.gravityScale;
    if (character.grounded && input.jumpPressed) {
        character.verticalSpeed = Math.sqrt(2 * -gravity * character.height * CHARACTER.JUMP_RATIO);
        character.jumped = true;
    }
    character.verticalSpeed = Math.max(-CHARACTER.TERMINAL_SPEED * character.gravityScale, character.verticalSpeed + gravity * dt);
    const wasGrounded = character.grounded;
    const startY = centre.y;

    _desired.set(worldMoveVec.x * speed * dt, character.verticalSpeed * dt, worldMoveVec.z * speed * dt);
    character.controller.computeColliderMovement(character.collider, _desired, rapier.QueryFilterFlags.EXCLUDE_SENSORS);
    const moved = character.controller.computedMovement();
    let grounded = character.controller.computedGrounded();
    findWall(character, moved.y);
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
    if (grounded) {
        character.airborneTime = 0;
        character.jumped = false;
    } else {
        character.airborneTime += dt;
    }

    // The collider moves now so the next frame's sweep starts here even if the world has not stepped yet;
    // the body follows on the next step.
    character.collider.setTranslation(centre);
    character.body.setNextKinematicTranslation(centre);

    // A stair step taken in one frame on the ground (a rise or drop steeper than any walkable slope gives
    // over this move): the body stays where it was drawn and catches up, rather than popping.
    const rise = centre.y - startY;
    const slopeRise = Math.hypot(moved.x, moved.z) * Math.tan(THREE.MathUtils.degToRad(CHARACTER.MAX_CLIMB_DEG)) + character.height * 0.01;
    const offset = character.stepOffset;
    if (wasGrounded && grounded && Math.abs(rise) > slopeRise) offset.x -= rise;
    stepSpring(offset, 0, CHARACTER.STEP_SMOOTHING, dt);
    const reach = character.height * CHARACTER.STEP_RATIO * 1.5;
    if (Math.abs(offset.x) > reach) offset.x = Math.sign(offset.x) * reach;

    modelObject.position.set(centre.x, centre.y - character.centreOffset + offset.x, centre.z);
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
    const turningInPlace = useRef(false);
    const rig = useRef<CharacterRig | null>(null);
    // How the character moves: springs on its velocity and facing, and its trajectory, which its animation reads.
    const motion = useMemo(() => characterMotionOf(modelObject), [modelObject]);

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

    /** Kinematic movement for the Sandbox by (moveX, moveZ): circle push-out against props, feet snapped to the terrain or the flat ground. */
    const moveWithoutPhysics = (moveX: number, moveZ: number) => {
        const { COLLISION_RADIUS } = DEFAULT_CONFIG;

        // Clone current pos to calculate next
        const nextPos = modelObject.position.clone();

        if (moveX * moveX + moveZ * moveZ > 1e-12) {
            nextPos.x += moveX;
            nextPos.z += moveZ;

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
    const updatePhysics = (
        input: PlayerInputState,
        delta: number,
        rootTravel?: { readonly x: number; readonly z: number } | null,
        /** While a turn clip plays, the radians it turned the character this step: the turn in place follows it. */
        clipTurn?: number | null,
    ) => {
        const {
            STAMINA_DRAIN, STAMINA_REGEN, MAX_STAMINA, EXHAUSTION_RECOVERY
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

        // The step the movement is simulated over (with physics, long frames are cut short as the capsule's are).
        const step = physics ? Math.min(delta, CHARACTER.MAX_STEP) : delta;
        // Placed by something else (spawned, restarted, loaded, out of a vehicle): the motion starts again there, at rest.
        if (Math.hypot(modelObject.position.x - motion.body.x, modelObject.position.z - motion.body.z) > CHARACTER.TELEPORT_DISTANCE) {
            motion.place(modelObject.position.x, modelObject.position.z, modelObject.rotation.y);
        } else if (Math.abs(wrapAngle(modelObject.rotation.y - motion.facing.x)) > 1e-4) {
            motion.facing.x = wrapAngle(modelObject.rotation.y);
            motion.facing.v = 0;
        }

        // --- 3. Handle Rotation ---
        // The facing turns by spring toward where the character is going (or aiming); with nowhere asked
        // for, it finishes the turn it was making.
        let targetRotation: number | null = null;

        // A turn in place starting this step: +1 to the left, -1 to the right.
        let turnStarted = 0;
        if (input.isAiming) {
            const aimYaw = Math.atan2(camForward.x, camForward.z);
            const facing = aimFacing(modelObject.rotation.y, aimYaw, isMoving, turningInPlace.current);
            if (facing.turning && !turningInPlace.current) turnStarted = wrapAngle(aimYaw - modelObject.rotation.y) > 0 ? 1 : -1;
            turningInPlace.current = facing.turning;
            if (facing.target !== null) targetRotation = facing.target;
        } else {
            turningInPlace.current = false;
            if (isMoving) targetRotation = Math.atan2(worldMoveVec.x, worldMoveVec.z);
        }

        // Aiming turns twice as briskly.
        const turnHalfLife = motion.settings.turnHalfLife * (input.isAiming ? 0.5 : 1);
        if (turningInPlace.current && typeof clipTurn === 'number') {
            // Exactly as the turn clip turns the character while one plays.
            motion.turnBy(clipTurn, delta);
        } else if (turningInPlace.current) {
            // A turn in place steps round at a walking pace rather than snapping to the aim.
            const before = motion.facing.x;
            motion.turnToward(targetRotation ?? before, delta, turnHalfLife);
            const turned = wrapAngle(motion.facing.x - before);
            const most = TURN_IN_PLACE_SPEED * delta;
            if (Math.abs(turned) > most) {
                motion.facing.x = before;
                motion.turnBy(Math.sign(turned) * most, delta);
            }
        } else if (targetRotation !== null || motion.goal.facing !== null) {
            motion.turnToward(targetRotation ?? motion.goal.facing ?? motion.facing.x, delta, turnHalfLife);
        }
        modelObject.rotation.y = motion.facing.x;

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

        // The springs carry the velocity toward the input's (speeding up and braking over a moment); root
        // motion instead travels exactly its distance over the step. Either way the move is tried against
        // the world over the step as a velocity.
        if (rootTravel && step > 0) motion.drive(rootTravel.x, rootTravel.z, step);
        else motion.advance(worldMoveVec.x * currentSpeed, worldMoveVec.z * currentSpeed, step, _move);
        const moveX = rootTravel && step > 0 ? rootTravel.x : _move.x;
        const moveZ = rootTravel && step > 0 ? rootTravel.z : _move.z;
        if (physics) {
            _velocity.set(step > 0 ? moveX / step : 0, 0, step > 0 ? moveZ / step : 0);
            stepCharacterPhysics(physics, getRig(physics), input, _velocity, 1, delta, obstacles, activeTerrain.current);
        } else {
            moveWithoutPhysics(moveX, moveZ);
        }
        motion.settle(modelObject.position.x, modelObject.position.z);
        motion.grounded = physics ? rig.current?.grounded ?? true : true;
        motion.strafing = input.isAiming;
        // Against a wall it slides along it rather than building up speed into it.
        const wall = physics ? rig.current?.wall : null;
        if (wall?.hit) motion.blockAgainst(wall.x, wall.z);
        motion.record(step);

        // --- 6. Calculate Animation Inputs ---
        const charForward = new THREE.Vector3(0, 0, 1).applyQuaternion(modelObject.quaternion);
        const charRight = new THREE.Vector3(1, 0, 0).applyQuaternion(modelObject.quaternion);

        let localX = worldMoveVec.dot(charRight);
        let localY = worldMoveVec.dot(charForward);

        if (Math.abs(localX) < 0.05) localX = 0;
        if (Math.abs(localY) < 0.05) localY = 0;

        return {
            isMoving,
            /** A turn in place started this step: +1 to the left, -1 to the right, 0 when none did. */
            turnStarted,
            /** A turn in place is under way. */
            turningInPlace: turningInPlace.current,
            effectiveSprint,
            localInputX: localX,
            localInputY: localY,
            /** Off the ground in the physics world (jumping or falling); always false without one. */
            isAirborne: physics ? !(rig.current?.grounded ?? true) : false,
            /** Off the ground after a jump or for more than a moment (see isFalling); always false without physics. */
            isFalling: physics && rig.current ? isFalling(rig.current) : false,
            /** Upward speed in world units per second, negative while dropping; 0 without physics. */
            verticalSpeed: physics ? (rig.current?.verticalSpeed ?? 0) : 0,
        };
    };

    /**
     * While the player drives a vehicle: the character stands at `seat` (world space, where its feet
     * go) facing `yaw`, and its capsule pushes nothing, though triggers and line-of-sight rays still
     * find it there. Null puts it back on foot where the model stands now; the next update moves the
     * capsule there.
     */
    const ride = (seat: THREE.Vector3 | null, yaw = modelObject.rotation.y) => {
        if (seat) {
            modelObject.position.copy(seat);
            modelObject.rotation.y = yaw;
        }
        if (!physics) return;
        const character = getRig(physics);
        if (seat) {
            if (character.ridingGroups === null) {
                character.ridingGroups = character.collider.solverGroups();
                character.collider.setSolverGroups(0);
            }
            character.centre.copy(seat);
            character.centre.y += character.centreOffset;
            character.collider.setTranslation(character.centre);
            character.body.setNextKinematicTranslation(character.centre);
            character.placedAt.copy(modelObject.position);
            character.verticalSpeed = 0;
            character.grounded = true;
            character.airborneTime = 0;
            character.jumped = false;
        } else if (character.ridingGroups !== null) {
            character.collider.setSolverGroups(character.ridingGroups);
            character.ridingGroups = null;
        }
    };

    return { updatePhysics, ride, hasPhysicsWorld: physics !== null };
};
