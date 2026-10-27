import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ownClipsFirst } from '../../utils/animationBinding';

const clip = (name: string) => new THREE.AnimationClip(name, 1, []);

describe('ownClipsFirst', () => {
  it("puts a model's own clips first so a name another model shares resolves to its own", () => {
    const remyIdle = clip('Idle');
    const remyWalk = clip('Walk');
    const mutantIdle = clip('Idle');
    const all = [remyIdle, remyWalk, mutantIdle];

    const ordered = ownClipsFirst([mutantIdle], all);
    expect(ordered).toEqual([mutantIdle, remyIdle, remyWalk]);
    expect(ordered.find((item) => item.name === 'Idle')).toBe(mutantIdle);
  });

  it('keeps the list as it is for a model without clips', () => {
    const all = [clip('Idle'), clip('Walk')];
    expect(ownClipsFirst(undefined, all)).toEqual(all);
    expect(ownClipsFirst([], all)).toEqual(all);
  });
});
