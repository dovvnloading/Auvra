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
    SEARCH_DURATION: 4.0 // Seconds AI waits at last known pos before giving up
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

export type AIState = 
  | 'IDLE' 
  | 'PATROL' 
  | 'CHASE' 
  | 'SEARCHING' 
  | 'STRAFING' 
  | 'ATTACKING' 
  | 'RECOVERY' 
  | 'RETURNING';