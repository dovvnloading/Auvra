import { describe, expect, it } from 'vitest';
import { readGameStateBinding, type GameStateSnapshot } from '../../runtime/gameState';

const state: GameStateSnapshot = {
  levelId: 'level-1',
  player: { health: 80, maxHealth: 100, stamina: 50, isAiming: true },
  vars: { score: 3, open: false, label: 'Gate' },
};

describe('game state bindings', () => {
  it('reads the level, player and variable values', () => {
    expect(readGameStateBinding(state, 'level.id')).toBe('level-1');
    expect(readGameStateBinding(state, 'player.health')).toBe(80);
    expect(readGameStateBinding(state, 'player.isAiming')).toBe(true);
    expect(readGameStateBinding(state, 'vars.score')).toBe(3);
    expect(readGameStateBinding(state, 'vars.open')).toBe(false);
    expect(readGameStateBinding(state, 'vars.label')).toBe('Gate');
  });

  it('never resolves prototype members or unknown paths', () => {
    for (const path of ['vars.toString', 'vars.constructor', 'vars.__proto__', 'player.hasOwnProperty', 'vars.missing', 'other.x']) {
      expect(readGameStateBinding(state, path)).toBeNull();
    }
  });
});
