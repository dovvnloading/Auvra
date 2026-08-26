
import { AnimationGraphData, Blueprint, GraphVariable } from '../../types';

const ENEMY_VARIABLES: GraphVariable[] = [
    { id: 'v_speed', name: 'Speed', type: 'Float', value: 0 },
    { id: 'v_input_x', name: 'InputX', type: 'Float', value: 0 },
    { id: 'v_input_y', name: 'InputY', type: 'Float', value: 0 },
    { id: 'v_sprint', name: 'IsSprinting', type: 'Boolean', value: false },
    { id: 'v_stamina', name: 'Stamina', type: 'Float', value: 100 },
    { id: 'v_attack', name: 'AttackIndex', type: 'Float', value: 0 }, // 0=None, 1=Atk1, 2=Atk2, 3=Atk3
    { id: 'v_dead', name: 'IsDead', type: 'Boolean', value: false },
    { id: 'v_crawl', name: 'IsCrawling', type: 'Boolean', value: false },
    { id: 'v_taunt', name: 'IsTaunting', type: 'Boolean', value: false }
];

export const ENEMY_GRAPH: AnimationGraphData = {
  variables: JSON.parse(JSON.stringify(ENEMY_VARIABLES)),
  inputs: [
      // Optional manual overrides for debugging
      { id: 'i_e_w', key: 'KeyW', type: 'Press', targetVariableId: 'v_input_y', targetValue: 1 },
      { id: 'i_e_s', key: 'KeyS', type: 'Press', targetVariableId: 'v_input_y', targetValue: -1 },
      { id: 'i_e_rel', key: 'KeyW', type: 'Release', targetVariableId: 'v_input_y', targetValue: 0 }
  ],
  states: [
    { id: 'es1', name: 'Idle', clipName: 'Idle', position: { x: 400, y: 300 }, loop: true, isRoot: true, stateType: 'Single', blendSamples: [], blendParamX: '', blendParamY: '' },
    { id: 'es2', name: 'Chase', clipName: 'Run', position: { x: 700, y: 300 }, loop: true, stateType: 'Single', blendSamples: [], blendParamX: '', blendParamY: '' },
    { id: 'es3', name: 'Attack', clipName: 'Attack', position: { x: 550, y: 100 }, loop: false, stateType: 'Single', blendSamples: [], blendParamX: '', blendParamY: '' },
    { id: 'es4', name: 'Death', clipName: 'Death', position: { x: 800, y: 500 }, loop: false, stateType: 'Single', blendSamples: [], blendParamX: '', blendParamY: '' },
    { id: 'es5', name: 'Strafe', clipName: 'Strafe', position: { x: 400, y: 500 }, loop: true, stateType: 'Single', blendSamples: [], blendParamX: '', blendParamY: '' }
  ],
  transitions: [
    // Idle <-> Chase (Based on Speed variable driven by AIController)
    { id: 'et1', fromStateId: 'es1', toStateId: 'es2', duration: 0.2, conditions: [{ variableId: 'v_speed', operator: '>', value: 0.1 }] },
    { id: 'et2', fromStateId: 'es2', toStateId: 'es1', duration: 0.2, conditions: [{ variableId: 'v_speed', operator: '<=', value: 0.1 }] },
    
    // Attack Logic (Triggered by AttackIndex > 0)
    { id: 'et3', fromStateId: 'es1', toStateId: 'es3', duration: 0.1, conditions: [{ variableId: 'v_attack', operator: '>', value: 0 }] },
    { id: 'et4', fromStateId: 'es2', toStateId: 'es3', duration: 0.1, conditions: [{ variableId: 'v_attack', operator: '>', value: 0 }] },
    { id: 'et9', fromStateId: 'es5', toStateId: 'es3', duration: 0.1, conditions: [{ variableId: 'v_attack', operator: '>', value: 0 }] },
    
    // Return from Attack (When AttackIndex reset to 0)
    { id: 'et5', fromStateId: 'es3', toStateId: 'es1', duration: 0.2, conditions: [{ variableId: 'v_attack', operator: '==', value: 0 }] },

    // Strafe Logic
    { id: 'et_strafe_start', fromStateId: 'es1', toStateId: 'es5', duration: 0.2, conditions: [{ variableId: 'v_input_x', operator: '!=', value: 0 }] },
    { id: 'et_strafe_end', fromStateId: 'es5', toStateId: 'es1', duration: 0.2, conditions: [{ variableId: 'v_input_x', operator: '==', value: 0 }] },

    // Death (Global)
    { id: 'et6', fromStateId: 'es1', toStateId: 'es4', duration: 0.1, conditions: [{ variableId: 'v_dead', operator: '==', value: true }] },
    { id: 'et7', fromStateId: 'es2', toStateId: 'es4', duration: 0.1, conditions: [{ variableId: 'v_dead', operator: '==', value: true }] },
    { id: 'et8', fromStateId: 'es3', toStateId: 'es4', duration: 0.1, conditions: [{ variableId: 'v_dead', operator: '==', value: true }] },
    { id: 'et10', fromStateId: 'es5', toStateId: 'es4', duration: 0.1, conditions: [{ variableId: 'v_dead', operator: '==', value: true }] }
  ],
  activeStateId: 'es1'
};

export const ENEMY_BLUEPRINT: Blueprint = {
  id: 'bp_enemy_default',
  name: 'Enemy Grunt',
  type: 'Enemy Controller',
  description: 'Basic enemy AI that chases and attacks the player.',
  linkedModelId: null,
  stats: [
    { id: 'est1', name: 'Health', value: 50 },
    { id: 'est2', name: 'Damage', value: 10 },
    { id: 'est3', name: 'Speed', value: 350 }
  ],
  traits: ['AI_Controlled', 'Hostile'],
  variables: JSON.parse(JSON.stringify(ENEMY_VARIABLES)),
  animationGraph: JSON.parse(JSON.stringify(ENEMY_GRAPH)),
  meshScale: 1.0
};
