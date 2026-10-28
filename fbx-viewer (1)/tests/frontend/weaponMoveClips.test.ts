import { describe, expect, it } from 'vitest';
import { moveClipRole, weaponLocomotionGraph } from '../../components/AnimationGraph/utils/clipMatching';
import { resolveWeapon, weaponMoveClips, weaponPlacements } from '../../runtime/weapons';
import type { AnimationGraphData, GraphState, WeaponSettings } from '../../types';

const single = (id: string, clipName: string | null): GraphState => ({
  id, name: id, stateType: 'Single', clipName, blendSamples: [], loop: true, position: { x: 0, y: 0 },
} as unknown as GraphState);

const graph: AnimationGraphData = {
  states: [
    single('Idle', 'Idle'),
    {
      ...single('Locomotion', null),
      stateType: 'Blend1D',
      blendSamples: [
        { id: 'a', clipName: 'Idle', position: [0, 0] },
        { id: 'b', clipName: 'Walk', position: [1, 0] },
        { id: 'c', clipName: 'Run', position: [2, 0] },
      ],
    } as GraphState,
    single('Jump', 'Jump'),
    single('Falling', 'Falling'),
    single('Death', 'Death'),
    {
      ...single('Nested', null),
      stateType: 'StateMachine',
      subGraph: { states: [single('Back', 'Walking Backwards')], transitions: [] },
    } as unknown as GraphState,
  ],
  transitions: [],
  variables: [],
} as unknown as AnimationGraphData;

const rifle: WeaponSettings = {
  id: 'r', name: 'Rifle', attachmentId: 'rifle-model',
  carry: { boneName: 'Spine2', position: [0, 0, -20], rotation: [0, 0, 45] },
  idleClip: 'Rifle Idle', walkClip: 'Rifle Walk', runClip: 'Rifle Run', backClip: 'Rifle Walk Backward', jumpClip: 'Rifle Jump',
};

describe('a held weapon\'s locomotion', () => {
  it('reads what each of the graph\'s clips is for from its name', () => {
    expect(['Idle', 'Walk', 'Run', 'Jump', 'Walking Backwards', 'Falling', 'Death', 'Punch'].map(moveClipRole))
      .toEqual(['idle', 'walk', 'run', 'jump', 'back', null, null, null]);
  });

  it("plays the weapon's clips for the graph's idle, walk, run and jump, by where each blend sample sits", () => {
    const available = new Set(['Rifle Idle', 'Rifle Walk', 'Rifle Run', 'Rifle Jump', 'Rifle Walk Backward']);
    const held = weaponLocomotionGraph(graph, weaponMoveClips(rifle), available);
    expect(held.states[0].clipName).toBe('Rifle Idle');
    expect(held.states[1].blendSamples.map(sample => sample.clipName)).toEqual(['Rifle Idle', 'Rifle Walk', 'Rifle Run']);
    expect(held.states[2].clipName).toBe('Rifle Jump');
    // Falling and dying are not locomotion the weapon has its own of.
    expect([held.states[3].clipName, held.states[4].clipName]).toEqual(['Falling', 'Death']);
    expect(held.states[5].subGraph?.states[0].clipName).toBe('Rifle Walk Backward');
  });

  it("backs up and steps sideways in a 2D blend with the weapon's clips, walking where it has no back clip", () => {
    const strafe = {
      ...single('Strafe', null),
      stateType: 'Blend2D',
      blendSamples: [
        { id: 'i', clipName: 'Idle', position: [0, 0] },
        { id: 'f', clipName: 'Walk', position: [0, 1] },
        { id: 'b', clipName: 'Walk', position: [0, -1] },
        { id: 'l', clipName: 'Walk', position: [-1, 0] },
        { id: 'w', clipName: 'Wave', position: [1, 0] },
      ],
    } as GraphState;
    const blend = { ...graph, states: [strafe] };
    const all = new Set(['Rifle Idle', 'Rifle Walk', 'Rifle Walk Backward']);
    expect(weaponLocomotionGraph(blend, weaponMoveClips(rifle), all).states[0].blendSamples.map(sample => sample.clipName))
      .toEqual(['Rifle Idle', 'Rifle Walk', 'Rifle Walk Backward', 'Rifle Walk', 'Wave']);
    expect(weaponLocomotionGraph(blend, weaponMoveClips({ ...rifle, backClip: null }), all).states[0].blendSamples[2].clipName).toBe('Rifle Walk');
  });

  it('leaves the graph as it is without stand-ins the model has', () => {
    expect(weaponLocomotionGraph(graph, weaponMoveClips(rifle), new Set())).toBe(graph);
    expect(weaponLocomotionGraph(graph, {}, new Set(['Rifle Idle']))).toBe(graph);
  });

  it('keeps only named clips, and none for a weapon without them', () => {
    expect(weaponMoveClips({ ...rifle, walkClip: '  ', jumpClip: null })).toEqual({ idle: 'Rifle Idle', run: 'Rifle Run', back: 'Rifle Walk Backward' });
    expect(weaponMoveClips(null)).toEqual({});
    expect(resolveWeapon({ id: 'x', name: 'X' }).idleClip).toBeNull();
  });

  it('keeps a weapon with its own idle in the hands while held, even at rest', () => {
    const atRest = { held: 0, ready: false, owned: [true] };
    expect(weaponPlacements([rifle], atRest).get('rifle-model')).toBe('hand');
    expect(weaponPlacements([{ ...rifle, idleClip: null }], atRest).get('rifle-model')).toMatchObject({ boneName: 'Spine2' });
  });
});
