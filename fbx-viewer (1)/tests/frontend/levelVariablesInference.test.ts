import { describe, expect, it } from 'vitest';
import { createLevelVariablesStore } from '../../runtime/levelVariables';

// Values reaching Set Level Variable through String pins arrive as text; an undeclared name takes
// the type of its first value, so numeric and true/false text must not create String variables.
describe('level variable type inference from text', () => {
  it('infers Float from a plain number string on an undeclared name', () => {
    const store = createLevelVariablesStore(() => {});
    expect(store.set('Coins', '5')).toBe(true);
    expect(store.get('Coins')).toBe(5);
    expect(store.set('Coins', 'lots')).toBe(false);
    expect(store.set('Coins', '6.5')).toBe(true);
    expect(store.get('Coins')).toBe(6.5);
    expect(store.set('Offset', '-2.25')).toBe(true);
    expect(store.get('Offset')).toBe(-2.25);
  });

  it('infers Boolean from exactly true/false', () => {
    const store = createLevelVariablesStore(() => {});
    expect(store.set('DoorOpen', 'true')).toBe(true);
    expect(store.get('DoorOpen')).toBe(true);
    expect(store.set('Lit', 'false')).toBe(true);
    expect(store.get('Lit')).toBe(false);
    expect(store.set('Lit', 1)).toBe(true);
    expect(store.get('Lit')).toBe(true);
    expect(store.set('Lit', 'maybe')).toBe(false);
  });

  it('keeps non-plain text as String', () => {
    const store = createLevelVariablesStore(() => {});
    for (const text of ['True', 'FALSE', ' 5', '05', '1e3', 'Infinity', 'NaN', '', '0x10', 'Find the key']) {
      const name = `Text_${text}`;
      expect(store.set(name, text)).toBe(true);
      expect(store.get(name)).toBe(text);
    }
    expect(store.set('Text_05', 7)).toBe(true);
    expect(store.get('Text_05')).toBe('7');
  });

  it('leaves declared variables on their declared type', () => {
    const store = createLevelVariablesStore(() => {});
    store.reset([
      { name: 'Label', type: 'String', value: 'start' },
      { name: 'Score', type: 'Float', value: 0 },
      { name: 'Armed', type: 'Boolean', value: false },
    ]);
    expect(store.set('Label', '5')).toBe(true);
    expect(store.get('Label')).toBe('5');
    expect(store.set('Label', 'true')).toBe(true);
    expect(store.get('Label')).toBe('true');
    expect(store.set('Score', '05')).toBe(true);
    expect(store.get('Score')).toBe(5);
    expect(store.set('Armed', 'true')).toBe(true);
    expect(store.get('Armed')).toBe(true);
  });

  it('still types native values by their own type', () => {
    const store = createLevelVariablesStore(() => {});
    expect(store.set('N', 3)).toBe(true);
    expect(store.set('B', true)).toBe(true);
    expect(store.set('S', 'hello')).toBe(true);
    expect(store.all()).toEqual({ N: 3, B: true, S: 'hello' });
    expect(store.set('Bad', Number.NaN)).toBe(false);
    expect(store.set('Obj', { a: 1 })).toBe(false);
    expect(store.get('Bad')).toBeUndefined();
  });
});
