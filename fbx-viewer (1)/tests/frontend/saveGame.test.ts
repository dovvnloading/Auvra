import { describe, expect, it } from 'vitest';
import { createSaveGameStore, saveGameKey } from '../../runtime/saveGame';
import type { SaveGameData } from '../../runtime/types';

class FakeStorage implements Storage {
  private readonly items = new Map<string, string>();
  failWrites = false;
  failReads = false;

  get length() {
    return this.items.size;
  }

  clear() {
    this.items.clear();
  }

  getItem(key: string) {
    if (this.failReads) throw new Error('SecurityError');
    return this.items.has(key) ? this.items.get(key)! : null;
  }

  key(index: number) {
    return Array.from(this.items.keys())[index] ?? null;
  }

  removeItem(key: string) {
    if (this.failWrites) throw new Error('SecurityError');
    this.items.delete(key);
  }

  setItem(key: string, value: string) {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.items.set(key, value);
  }
}

const makeSave = (overrides: Partial<SaveGameData> = {}): SaveGameData => ({
  schema: 1,
  gameId: 'demo',
  slot: 'auto',
  savedAt: '2026-10-26T10:00:00.000Z',
  levelId: 'level-1',
  player: { position: [1, 2, 3], rotation: [0, 1.5, 0], health: 80, stamina: 40 },
  destroyedObjectIds: ['crate-1'],
  variables: { keys: 2, door: true, name: 'hero' },
  ...overrides,
});

describe('save game store', () => {
  it('round-trips a save under a namespaced key and defaults to the auto slot', () => {
    const storage = new FakeStorage();
    const store = createSaveGameStore('demo', storage);
    const save = makeSave();

    expect(store.save(save)).toBe(true);
    expect(storage.getItem('auvra.save.demo.auto')).not.toBeNull();
    expect(store.load()).toEqual(save);
    expect(store.load('auto')).toEqual(save);
    expect(store.load('slot-2')).toBeNull();
  });

  it('lists only valid saves for its own game, newest first', () => {
    const storage = new FakeStorage();
    const store = createSaveGameStore('demo', storage);
    store.save(makeSave({ slot: 'a', savedAt: '2026-10-26T09:00:00.000Z', levelId: 'level-1' }));
    store.save(makeSave({ slot: 'b', savedAt: '2026-10-26T11:00:00.000Z', levelId: 'level-2' }));
    createSaveGameStore('demo.other', storage).save(makeSave({ gameId: 'demo.other', slot: 'x' }));
    storage.setItem(saveGameKey('demo', 'broken'), '{not json');
    storage.setItem('unrelated', 'value');

    expect(store.list()).toEqual([
      { slot: 'b', savedAt: '2026-10-26T11:00:00.000Z', levelId: 'level-2' },
      { slot: 'a', savedAt: '2026-10-26T09:00:00.000Z', levelId: 'level-1' },
    ]);
  });

  it('rejects corrupt, foreign or mismatched saves on load and save', () => {
    const storage = new FakeStorage();
    const store = createSaveGameStore('demo', storage);

    storage.setItem(saveGameKey('demo', 'auto'), JSON.stringify({ ...makeSave(), schema: 2 }));
    expect(store.load()).toBeNull();
    storage.setItem(saveGameKey('demo', 'auto'), JSON.stringify(makeSave({ gameId: 'other' })));
    expect(store.load()).toBeNull();
    storage.setItem(saveGameKey('demo', 'auto'), JSON.stringify(makeSave({ slot: 'elsewhere' })));
    expect(store.load()).toBeNull();
    storage.setItem(saveGameKey('demo', 'auto'), JSON.stringify({ ...makeSave(), player: { position: [0, 0], rotation: [0, 0, 0], health: 1, stamina: 1 } }));
    expect(store.load()).toBeNull();

    expect(store.save(makeSave({ gameId: 'other' }))).toBe(false);
    expect(store.save(makeSave({ variables: { bad: Number.NaN } }))).toBe(false);
  });

  it('removes a slot', () => {
    const storage = new FakeStorage();
    const store = createSaveGameStore('demo', storage);
    store.save(makeSave());

    expect(store.remove()).toBe(true);
    expect(store.load()).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it('returns false or null when storage throws', () => {
    const storage = new FakeStorage();
    const store = createSaveGameStore('demo', storage);
    store.save(makeSave());

    storage.failWrites = true;
    expect(store.save(makeSave({ slot: 'b' }))).toBe(false);
    expect(store.remove()).toBe(false);

    storage.failReads = true;
    expect(store.load()).toBeNull();
    expect(store.list()).toEqual([]);

    const unavailable = createSaveGameStore('demo', null);
    expect(unavailable.save(makeSave())).toBe(false);
    expect(unavailable.load()).toBeNull();
    expect(unavailable.list()).toEqual([]);
    expect(unavailable.remove()).toBe(false);
  });
});
