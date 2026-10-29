import { describe, expect, it } from 'vitest';
import { readGameStateBinding, type GameStateSnapshot } from '../../runtime/gameState';

const state: GameStateSnapshot = {
  levelId: 'level-1',
  player: { health: 80, maxHealth: 100, stamina: 50, isAiming: true, weapon: 'Pistol', ammo: 7, magazine: 12, reserve: -1, reloading: false },
  vars: { score: 3, open: false, label: 'Gate' },
  abilities: { values: { mana: 40 }, max: { mana: 100 }, cooldowns: { fireball: 1.5 } },
};

describe('game state bindings', () => {
  it('reads the level, player and variable values', () => {
    expect(readGameStateBinding(state, 'level.id')).toBe('level-1');
    expect(readGameStateBinding(state, 'player.health')).toBe(80);
    expect(readGameStateBinding(state, 'player.isAiming')).toBe(true);
    expect(readGameStateBinding(state, 'player.weapon')).toBe('Pistol');
    expect(readGameStateBinding(state, 'player.ammo')).toBe(7);
    expect(readGameStateBinding(state, 'vars.score')).toBe(3);
    expect(readGameStateBinding(state, 'vars.open')).toBe(false);
    expect(readGameStateBinding(state, 'vars.label')).toBe('Gate');
  });

  it("reads the player's ability attributes, their maxima and cooldowns", () => {
    expect(readGameStateBinding(state, 'abilities.mana')).toBe(40);
    expect(readGameStateBinding(state, 'abilityMax.mana')).toBe(100);
    expect(readGameStateBinding(state, 'cooldowns.fireball')).toBe(1.5);
    expect(readGameStateBinding(state, 'abilities.toString')).toBeNull();
    expect(readGameStateBinding(state, 'cooldowns.missing')).toBeNull();
  });

  it('never resolves prototype members or unknown paths', () => {
    for (const path of ['vars.toString', 'vars.constructor', 'vars.__proto__', 'player.hasOwnProperty', 'vars.missing', 'other.x']) {
      expect(readGameStateBinding(state, path)).toBeNull();
    }
  });
});
