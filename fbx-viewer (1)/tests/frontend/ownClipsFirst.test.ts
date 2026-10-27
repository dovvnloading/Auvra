import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyStoredClipNames, ownClipsFirst, uniqueClipNames } from '../../utils/animationBinding';

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

describe('stored clip names', () => {
  it('numbers a name the model already uses, and repeats within one batch', () => {
    const taken = new Set(['Idle', 'Walk']);
    expect(uniqueClipNames(['Walk', 'Run', 'Run'], taken)).toEqual(['Walk 2', 'Run', 'Run 2']);
    expect([...taken].sort()).toEqual(['Idle', 'Run', 'Run 2', 'Walk', 'Walk 2']);
  });

  it("puts back the names stored with the document, so a renamed model's clips keep theirs", () => {
    // Loaded from a model renamed "Hero": its clip is named after the new name.
    const clips = [clip('Hero')];
    applyStoredClipNames(clips, ['Remy']);
    expect(clips[0].name).toBe('Remy');
  });

  it('ignores stored names that do not fit the clips', () => {
    const clips = [clip('Walk'), clip('Run')];
    applyStoredClipNames(clips, ['Only One']);
    applyStoredClipNames(clips, ['A', '']);
    applyStoredClipNames(clips, undefined);
    expect(clips.map((item) => item.name)).toEqual(['Walk', 'Run']);
  });
});
