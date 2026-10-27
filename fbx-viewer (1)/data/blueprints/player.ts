
import { AnimationGraphData, Blueprint, GraphVariable } from '../../types';

const PLAYER_VARIABLES: GraphVariable[] = [
    { id: 'v1', name: 'Speed', type: 'Float', value: 0 },
    { id: 'v2', name: 'IsJumping', type: 'Boolean', value: false },
    { id: 'v3', name: 'IsFiring', type: 'Boolean', value: false },
    { id: 'v4', name: 'InputX', type: 'Float', value: 0 }, 
    { id: 'v5', name: 'InputY', type: 'Float', value: 0 },
    { id: 'v6', name: 'IsSprinting', type: 'Boolean', value: false },
    { id: 'v7', name: 'IsAiming', type: 'Boolean', value: false },
    { id: 'v8', name: 'IsDead', type: 'Boolean', value: false },
    // Set by play from the character controller, for the jump, fall and land states
    { id: 'v9', name: 'IsGrounded', type: 'Boolean', value: true },
    { id: 'v10', name: 'IsFalling', type: 'Boolean', value: false },
    { id: 'v11', name: 'VerticalSpeed', type: 'Float', value: 0 },
    // Camera Configuration
    { id: 'v_cam_dist', name: 'CameraDistance', type: 'Float', value: 6.0 }
];

export const PLAYER_GRAPH: AnimationGraphData = {
  variables: JSON.parse(JSON.stringify(PLAYER_VARIABLES)),
  inputs: [
    { id: 'i1', key: 'KeyW', type: 'Press', targetVariableId: 'v1', targetValue: 1 },
    { id: 'i1b', key: 'KeyW', type: 'Press', targetVariableId: 'v5', targetValue: 1 },
    { id: 'i2', key: 'KeyW', type: 'Release', targetVariableId: 'v1', targetValue: 0 },
    { id: 'i2b', key: 'KeyW', type: 'Release', targetVariableId: 'v5', targetValue: 0 },
    
    { id: 'i_s_press', key: 'KeyS', type: 'Press', targetVariableId: 'v1', targetValue: 1 }, 
    { id: 'i_s_press_dir', key: 'KeyS', type: 'Press', targetVariableId: 'v5', targetValue: -1 },
    { id: 'i_s_rel', key: 'KeyS', type: 'Release', targetVariableId: 'v1', targetValue: 0 },
    { id: 'i_s_rel_dir', key: 'KeyS', type: 'Release', targetVariableId: 'v5', targetValue: 0 },

    { id: 'i_shift_press', key: 'ShiftLeft', type: 'Press', targetVariableId: 'v6', targetValue: true },
    { id: 'i_shift_rel', key: 'ShiftLeft', type: 'Release', targetVariableId: 'v6', targetValue: false },
    
    { id: 'i_a_press', key: 'KeyA', type: 'Press', targetVariableId: 'v4', targetValue: -1 },
    { id: 'i_a_rel', key: 'KeyA', type: 'Release', targetVariableId: 'v4', targetValue: 0 },
    
    { id: 'i_d_press', key: 'KeyD', type: 'Press', targetVariableId: 'v4', targetValue: 1 },
    { id: 'i_d_rel', key: 'KeyD', type: 'Release', targetVariableId: 'v4', targetValue: 0 },

    { id: 'i4', key: 'Space', type: 'Press', targetVariableId: 'v2', targetValue: true },
    { id: 'i5', key: 'Space', type: 'Release', targetVariableId: 'v2', targetValue: false },
    
    // Explicit binding for Aiming (Right Click) is usually handled by Controller, but we map KeyF here as fallback or toggle
    { id: 'i_aim_p', key: 'KeyF', type: 'Press', targetVariableId: 'v7', targetValue: true },
    { id: 'i_aim_r', key: 'KeyF', type: 'Release', targetVariableId: 'v7', targetValue: false },

    { id: 'i6', key: 'KeyG', type: 'Press', targetVariableId: 'v3', targetValue: true },
    { id: 'i7', key: 'KeyG', type: 'Release', targetVariableId: 'v3', targetValue: false }
  ],
  states: [
    { id: 's1', name: 'Idle', clipName: null, position: { x: 400, y: 300 }, loop: true, isRoot: true, stateType: 'Single', blendSamples: [], blendParamX: '', blendParamY: '' },
    { id: 's2', name: 'Walk', clipName: null, position: { x: 700, y: 300 }, loop: true, stateType: 'Single', blendSamples: [], blendParamX: '', blendParamY: '' },
    { id: 's3', name: 'Run', clipName: null, position: { x: 1000, y: 300 }, loop: true, stateType: 'Single', blendSamples: [], blendParamX: '', blendParamY: '' },
    { id: 's4', name: 'Jump', clipName: null, position: { x: 700, y: 100 }, loop: false, stateType: 'Single', blendSamples: [], blendParamX: '', blendParamY: '' },
    { id: 's5', name: 'Falling', clipName: null, position: { x: 1000, y: 100 }, loop: true, stateType: 'Single', blendSamples: [], blendParamX: '', blendParamY: '' },
    { id: 's6', name: 'Land', clipName: null, position: { x: 1300, y: 100 }, loop: false, stateType: 'Single', blendSamples: [], blendParamX: '', blendParamY: '' },
    // Combat / Strafe State
    { 
        id: 's7', 
        name: 'Strafe (Combat)', 
        clipName: null, 
        position: { x: 400, y: 550 }, 
        loop: true, 
        stateType: 'Blend2D', 
        blendParamX: 'v4', // InputX
        blendParamY: 'v5', // InputY
        blendSamples: [
            { id: 'bs_idle', clipName: 'Idle_Combat', position: [0, 0] },
            { id: 'bs_fwd', clipName: 'Walk_Fwd', position: [0, 1] },
            { id: 'bs_back', clipName: 'Walk_Back', position: [0, -1] },
            { id: 'bs_left', clipName: 'Strafe_Left', position: [-1, 0] },
            { id: 'bs_right', clipName: 'Strafe_Right', position: [1, 0] }
        ]
    }
  ],
  transitions: [
    // --- PEACEFUL LOCOMOTION (IsAiming == false) ---
    { id: 't1', fromStateId: 's1', toStateId: 's2', duration: 0.2, conditions: [{ variableId: 'v1', operator: '>', value: 0 }, { variableId: 'v7', operator: '==', value: false }] },
    { id: 't4', fromStateId: 's2', toStateId: 's1', duration: 0.2, conditions: [{ variableId: 'v1', operator: '==', value: 0 }, { variableId: 'v7', operator: '==', value: false }] },
    
    // Walk <-> Run (Smoother Blends)
    { id: 't2', fromStateId: 's2', toStateId: 's3', duration: 0.4, conditions: [{ variableId: 'v6', operator: '==', value: true }, { variableId: 'v5', operator: '>', value: 0 }] },
    { id: 't3', fromStateId: 's3', toStateId: 's2', duration: 0.4, conditions: [{ variableId: 'v6', operator: '==', value: false }] },
    
    { id: 't_run_idle', fromStateId: 's3', toStateId: 's1', duration: 0.3, conditions: [{ variableId: 'v1', operator: '==', value: 0 }] },

    // --- COMBAT ENTRY (Any -> Strafe), except mid-jump ---
    { id: 't_enter_combat_1', fromStateId: 's1', toStateId: 's7', anyState: true, duration: 0.2, conditions: [{ variableId: 'v7', operator: '==', value: true }, { variableId: 'v2', operator: '==', value: false }] },

    // --- COMBAT EXIT (Strafe -> Any) ---
    { id: 't_exit_combat_idle', fromStateId: 's7', toStateId: 's1', duration: 0.2, conditions: [{ variableId: 'v7', operator: '==', value: false }, { variableId: 'v1', operator: '==', value: 0 }] },
    { id: 't_exit_combat_walk', fromStateId: 's7', toStateId: 's2', duration: 0.2, conditions: [{ variableId: 'v7', operator: '==', value: false }, { variableId: 'v1', operator: '>', value: 0 }] },

    // --- JUMP, FALL, LAND (override everything else) ---
    // Rising: only a jump moves the character upward.
    { id: 't_jump', fromStateId: 's1', toStateId: 's4', anyState: true, priority: 50, duration: 0.1, conditions: [{ variableId: 'v2', operator: '==', value: true }, { variableId: 'v11', operator: '>', value: 0 }] },
    // Past the top of a jump, or off a ledge for more than a moment.
    { id: 't_fall', fromStateId: 's4', toStateId: 's5', anyState: true, priority: 40, duration: 0.25, conditions: [{ variableId: 'v10', operator: '==', value: true }, { variableId: 'v11', operator: '<=', value: 0 }] },
    { id: 't_fall_land', fromStateId: 's5', toStateId: 's6', duration: 0.1, conditions: [{ variableId: 'v9', operator: '==', value: true }] },
    { id: 't_jump_land', fromStateId: 's4', toStateId: 's6', duration: 0.1, conditions: [{ variableId: 'v9', operator: '==', value: true }] },
    // Moving cuts the landing short; standing still lets it finish.
    { id: 't_land_walk', fromStateId: 's6', toStateId: 's2', duration: 0.2, conditions: [{ variableId: 'v1', operator: '>', value: 0 }] },
    { id: 't_land_idle', fromStateId: 's6', toStateId: 's1', duration: 0.2, exitTime: 0.8, conditions: [] },
  ],
  activeStateId: 's1'
};

export const PLAYER_BLUEPRINT: Blueprint = {
  id: 'bp_player_default',
  name: 'Player Character',
  type: 'Player Character',
  description: 'Main playable character with standard locomotion and combat stats.',
  linkedModelId: null,
  stats: [
    { id: 'st1', name: 'Health', value: 100 },
    { id: 'st2', name: 'Stamina', value: 50 },
    { id: 'st3', name: 'Walk Speed', value: 450 },
    { id: 'st4', name: 'Run Speed', value: 900 }
  ],
  traits: ['Controllable'],
  variables: JSON.parse(JSON.stringify(PLAYER_VARIABLES)),
  animationGraph: JSON.parse(JSON.stringify(PLAYER_GRAPH)),
  meshScale: 1.0,
  weaponSounds: [],
  weaponVolume: 1.0
};