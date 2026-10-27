import { describe, expect, it } from 'vitest';
import { PLAYER_GRAPH } from '../../data/blueprints/player';
import { ENEMY_BLUEPRINT } from '../../data/blueprints/enemy';
import { findClipForRole, matchGraphClips, matchUpperBodyClips, stateRole } from '../../components/AnimationGraph/utils/clipMatching';
import { upperBodyClip } from '../../components/Sandbox/PlayerController';

// Clip names as Mixamo downloads import (each clip takes its file's name).
const REMY = ['Remy', 'Idle', 'Walk', 'Run', 'Jump', 'Falling', 'Landing', 'Punch', 'Death', 'Strafe Left', 'Strafe Right', 'Walk Back', 'Shooting'];
const MUTANT = ['Mutant', 'Mutant Idle', 'Mutant Walk', 'Mutant Run', 'Mutant Attack', 'Mutant Death'];

const clipOf = (graph: typeof PLAYER_GRAPH, name: string) => graph.states.find(state => state.name === name)?.clipName;

describe('matchGraphClips', () => {
  it("gives the player graph a Mixamo character's clips, blend samples included", () => {
    const { graph, assigned } = matchGraphClips(PLAYER_GRAPH, REMY);
    expect(clipOf(graph, 'Idle')).toBe('Idle');
    expect(clipOf(graph, 'Walk')).toBe('Walk');
    expect(clipOf(graph, 'Run')).toBe('Run');
    expect(clipOf(graph, 'Jump')).toBe('Jump');
    expect(clipOf(graph, 'Falling')).toBe('Falling');
    expect(clipOf(graph, 'Land')).toBe('Landing');
    const strafe = graph.states.find(state => state.stateType === 'Blend2D')!;
    const at = (x: number, y: number) => strafe.blendSamples.find(sample => sample.position[0] === x && sample.position[1] === y)?.clipName;
    expect([at(0, 0), at(0, 1), at(0, -1), at(-1, 0), at(1, 0)]).toEqual(['Idle', 'Walk', 'Walk Back', 'Strafe Left', 'Strafe Right']);
    expect(assigned.length).toBe(11);
  });

  it("gives the enemy graph the Mutant's clips, with Walk standing in for a missing strafe", () => {
    const { graph } = matchGraphClips(ENEMY_BLUEPRINT.animationGraph, MUTANT);
    const clips = Object.fromEntries(graph.states.map(state => [state.name, state.clipName]));
    expect(clips).toMatchObject({ Idle: 'Mutant Idle', Chase: 'Mutant Run', Attack: 'Mutant Attack', Death: 'Mutant Death', Strafe: 'Mutant Walk' });
  });

  it("keeps clips the model has, and replaces ones it lacks", () => {
    const start = { ...PLAYER_GRAPH, states: PLAYER_GRAPH.states.map(state => (
      state.name === 'Idle' ? { ...state, clipName: 'Walk' } : state.name === 'Walk' ? { ...state, clipName: 'Other Model Walk' } : state)) };
    const { graph } = matchGraphClips(start, REMY);
    expect(clipOf(graph, 'Idle')).toBe('Walk');
    expect(clipOf(graph, 'Walk')).toBe('Walk');
  });

  it('leaves Land empty without a landing clip, so it finishes at once instead of playing Idle', () => {
    const { graph } = matchGraphClips(PLAYER_GRAPH, REMY.filter(clip => clip !== 'Landing'));
    expect(clipOf(graph, 'Land')).toBeNull();
  });

  it('changes nothing, and returns the same graph, when no clip name fits', () => {
    const { graph, assigned } = matchGraphClips(PLAYER_GRAPH, ['Take 001', 'Dance']);
    expect(assigned).toEqual([]);
    expect(graph).toBe(PLAYER_GRAPH);
  });
});

describe('clip roles', () => {
  it('reads roles from state names', () => {
    expect(['Idle', 'Ready (Combat)', 'Chase', 'Jump', 'Falling', 'Land', 'Attack', 'Death', 'Strafe', 'Fire'].map(stateRole))
      .toEqual(['idle', 'idle', 'run', 'jump', 'fall', 'land', 'attack', 'death', 'strafe', 'shoot']);
    expect(stateRole('Custom Thing')).toBeNull();
  });

  it('prefers plain clips over fight, transition and directional ones', () => {
    expect(findClipForRole('idle', ['Fight Idle', 'Standing Idle To Fight Idle', 'Breathing Idle'])).toBe('Breathing Idle');
    expect(findClipForRole('walk', ['Walking Backwards', 'Start Walking', 'Walking'])).toBe('Walking');
    expect(findClipForRole('fall', ['Falling To Landing', 'Falling Idle'])).toBe('Falling Idle');
    expect(findClipForRole('idle', ['Armature|Idle', 'Armature|Walk'])).toBe('Armature|Idle');
  });
});

describe('matchUpperBodyClips', () => {
  it("fills the fire and aim clips from names, keeping ones the model has", () => {
    expect(matchUpperBodyClips(undefined, [...REMY, 'Rifle Aiming Idle']).settings).toEqual({ fireClip: 'Shooting', aimClip: 'Rifle Aiming Idle' });
    expect(matchUpperBodyClips({ fireClip: 'Punch', maskBone: 'Spine1' }, REMY).settings).toEqual({ fireClip: 'Punch', maskBone: 'Spine1' });
    expect(matchUpperBodyClips({ fireClip: 'Gone' }, REMY).settings).toEqual({ fireClip: 'Shooting' });
  });

  it('has no stand-in: a model without fitting clips leaves the upper body to the graph', () => {
    expect(matchUpperBodyClips(undefined, MUTANT)).toEqual({ settings: undefined, assigned: [] });
  });
});

describe('upperBodyClip', () => {
  it('plays the fire clip while firing, else the aim clip while aiming', () => {
    const settings = { fireClip: 'Shooting', aimClip: 'Aim' };
    expect(upperBodyClip(settings, true, true)).toBe('Shooting');
    expect(upperBodyClip(settings, false, true)).toBe('Aim');
    expect(upperBodyClip(settings, false, false)).toBeNull();
    expect(upperBodyClip({ aimClip: 'Aim' }, true, false)).toBeNull();
    expect(upperBodyClip(undefined, true, true)).toBeNull();
  });
});
