import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ANIMATION_COMPONENT_TYPE, findAnimationClip, readAnimationSettings } from '../../runtime/components/animationComponent';
import { getComponentDefinition } from '../../runtime/components/registry';
import type { LevelComponent } from '../../types';

const component = (props: Record<string, unknown>): LevelComponent => ({ id: 'a', type: ANIMATION_COMPONENT_TYPE, enabled: true, props });

describe('animation component', () => {
  it('is offered with the other components', () => {
    expect(getComponentDefinition(ANIMATION_COMPONENT_TYPE)?.label).toBe('Animation');
  });

  it('reads its settings, keeping them in range', () => {
    expect(readAnimationSettings(component({}))).toEqual({ clip: '', loop: true, speed: 1, startAt: 0 });
    expect(readAnimationSettings(component({ clip: ' Wave ', loop: false, speed: 40, startAt: 2 })))
      .toEqual({ clip: 'Wave', loop: false, speed: 10, startAt: 1 });
    expect(readAnimationSettings(component({ speed: 'fast', startAt: Number.NaN })).speed).toBe(1);
  });

  it('finds a clip by its name, with or without the FBX take prefix', () => {
    const clips = ['Armature|Idle', 'Armature|Wave', 'Talk'].map(name => new THREE.AnimationClip(name, 1, []));
    expect(findAnimationClip(clips, 'Armature|Wave')?.name).toBe('Armature|Wave');
    expect(findAnimationClip(clips, 'wave')?.name).toBe('Armature|Wave');
    expect(findAnimationClip(clips, 'Rig|Talk')?.name).toBe('Talk');
    expect(findAnimationClip(clips, '')).toBeNull();
    expect(findAnimationClip(clips, 'Dance')).toBeNull();
  });
});
