import { BlueprintStat } from '../../../types';

export const AI_CONFIG = {
  // Distances (in World Units)
  DISTANCES: {
    STOP: 1.5,      // Distance to stop moving near target
    ATTACK: 2.2,    // Distance valid for triggering attack
    AGGRO: 15.0,    // Max sight range
    HEARING: 4.0,   // Radius where AI detects player regardless of facing
    SPRINT: 8.0,    // Distance trigger for sprinting
    BOUNDARY_BUFFER: 2.0, // Hard clamp buffer
    PATROL_RADIUS: 8.0 // How far to wander
  },

  SENSES: {
    FOV_ANGLE: 120, // Degrees
    MEMORY_DURATION: 5.0, // Seconds AI remembers player location after losing sight
    SEARCH_DURATION: 4.0, // Seconds AI waits at last known pos before giving up
    REACTION_TIME: 0.5 // Seconds to notice the player close by and straight ahead (runtime/awareness.ts)
  },

  // Locomotion & Physics
  PHYSICS: {
    ROTATION_SPEED: 8.0,
    ACCELERATION: 5.0,
    DECELERATION: 8.0,
    WALK_SPEED_MAX: 2.5,
    RUN_SPEED_MAX: 6.5,
    STRAFE_SPEED: 2.0,
    ANIM_WALK_THRESHOLD: 0.1
  },

  // Combat Timers (Seconds)
  COMBAT: {
    ATTACK_COOLDOWN: 3.0,
    ATTACK_DURATION: 1.6,
    STRAFE_DURATION_MIN: 1.0,
    STRAFE_DURATION_MAX: 3.0
  },

  // Stamina System
  STAMINA: {
    MAX: 100,
    DRAIN_RATE: 12,
    REGEN_RATE: 15,
    MIN_TO_SPRINT: 20
  }
};

/** Blueprint stats that tune an enemy's AI. Distances and speeds are Unreal-style centimetres, the cooldown is seconds. */
export const AI_STAT_NAMES = {
  SPEED: 'Speed',                     // Chase (top) speed, cm/s
  ATTACK_RANGE: 'Attack Range',       // cm
  ATTACK_COOLDOWN: 'Attack Cooldown', // Seconds from one attack's start to the next
  SIGHT_RANGE: 'Sight Range',         // cm
  REACTION_TIME: 'Reaction Time'      // Seconds to notice the player close by and straight ahead; farther or to the side takes longer
} as const;

const STAT_UNITS_PER_WORLD_UNIT = 100;

/** Per-enemy AI tunables in world units and seconds. */
export interface AITuning {
  runSpeed: number;       // Chase speed
  walkSpeed: number;      // Patrol / search speed
  strafeSpeed: number;
  attackRange: number;    // Distance at which an attack starts
  stopDistance: number;   // Distance at which a chase stops closing in (inside the attack range)
  attackCooldown: number;
  sightRange: number;     // Max distance the target can be seen at
  reactionTime: number;   // Seconds to notice the target close by and straight ahead
}

const { PHYSICS, DISTANCES, COMBAT } = AI_CONFIG;

const buildTuning = (runSpeed: number, attackRange: number, attackCooldown: number, sightRange: number, reactionTime = AI_CONFIG.SENSES.REACTION_TIME): AITuning => ({
  runSpeed,
  // Walk, strafe and stopping distance keep AI_CONFIG's proportions.
  walkSpeed: runSpeed * (PHYSICS.WALK_SPEED_MAX / PHYSICS.RUN_SPEED_MAX),
  strafeSpeed: runSpeed * (PHYSICS.STRAFE_SPEED / PHYSICS.RUN_SPEED_MAX),
  attackRange,
  stopDistance: attackRange * (DISTANCES.STOP / DISTANCES.ATTACK),
  attackCooldown,
  sightRange,
  reactionTime
});

export const DEFAULT_AI_TUNING: AITuning = buildTuning(PHYSICS.RUN_SPEED_MAX, DISTANCES.ATTACK, COMBAT.ATTACK_COOLDOWN, DISTANCES.AGGRO);

/** AI tunables from an enemy blueprint's stats; a missing or invalid stat keeps the AI_CONFIG default. */
export const resolveAITuning = (stats: readonly BlueprintStat[] | null | undefined): AITuning => {
  const read = (name: string, allowZero: boolean): number | null => {
    const value = stats?.find(stat => stat.name === name)?.value;
    return typeof value === 'number' && Number.isFinite(value) && (allowZero ? value >= 0 : value > 0) ? value : null;
  };
  const inWorldUnits = (name: string, fallback: number): number => {
    const value = read(name, false);
    return value === null ? fallback : value / STAT_UNITS_PER_WORLD_UNIT;
  };
  return buildTuning(
    inWorldUnits(AI_STAT_NAMES.SPEED, DEFAULT_AI_TUNING.runSpeed),
    inWorldUnits(AI_STAT_NAMES.ATTACK_RANGE, DEFAULT_AI_TUNING.attackRange),
    read(AI_STAT_NAMES.ATTACK_COOLDOWN, true) ?? DEFAULT_AI_TUNING.attackCooldown,
    inWorldUnits(AI_STAT_NAMES.SIGHT_RANGE, DEFAULT_AI_TUNING.sightRange),
    read(AI_STAT_NAMES.REACTION_TIME, true) ?? DEFAULT_AI_TUNING.reactionTime
  );
};

export type AIState = 
  | 'IDLE' 
  | 'PATROL' 
  | 'CHASE' 
  | 'SEARCHING' 
  | 'STRAFING' 
  | 'ATTACKING' 
  | 'RECOVERY' 
  | 'RETURNING';