import { describe, expect, it } from 'vitest';
import { createPlayerOptionsStore, defaultPlayerOptions } from '../../runtime/playerOptions';
import { DEFAULT_GAME_SETTINGS } from '../../runtime/types';

const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
    clear: () => data.clear(),
    key: () => null,
    length: 0,
  } as Storage;
};

describe('player options', () => {
  it('persists per game and survives reload', () => {
    const storage = memoryStorage();
    const defaults = defaultPlayerOptions(DEFAULT_GAME_SETTINGS);
    const store = createPlayerOptionsStore('game-a', defaults, storage);
    store.update({ invertY: true, volumes: { ...defaults.volumes, music: 0.25 }, bindings: { Jump: [{ device: 'keyboard', code: 'KeyJ' }] } });
    const reloaded = createPlayerOptionsStore('game-a', defaults, storage).get();
    expect(reloaded.invertY).toBe(true);
    expect(reloaded.volumes.music).toBe(0.25);
    expect(reloaded.bindings.Jump).toEqual([{ device: 'keyboard', code: 'KeyJ' }]);
    expect(createPlayerOptionsStore('game-b', defaults, storage).get().invertY).toBe(false);
  });

  it('drops invalid stored values', () => {
    const storage = memoryStorage();
    storage.setItem('auvra.options.g', JSON.stringify({ mouseSensitivity: -4, bindings: { Jump: [{ device: 'laser' }] } }));
    const options = createPlayerOptionsStore('g', defaultPlayerOptions(DEFAULT_GAME_SETTINGS), storage).get();
    expect(options.mouseSensitivity).toBe(DEFAULT_GAME_SETTINGS.input.mouseSensitivity);
    expect(options.bindings.Jump).toEqual([]);
  });

  it('keeps working when storage throws', () => {
    const broken = { ...memoryStorage(), setItem: () => { throw new Error('quota'); }, getItem: () => { throw new Error('blocked'); } } as Storage;
    const store = createPlayerOptionsStore('g', defaultPlayerOptions(DEFAULT_GAME_SETTINGS), broken);
    store.update({ invertY: true });
    expect(store.get().invertY).toBe(true);
  });
});
