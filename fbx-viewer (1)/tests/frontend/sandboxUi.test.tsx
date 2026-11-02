import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SandboxUI } from '../../components/Sandbox/SandboxUI';
import type { Blueprint } from '../../types';

const blueprint = { name: 'Player' } as Blueprint;
const hud = (props: Partial<React.ComponentProps<typeof SandboxUI>> = {}) => (
  <SandboxUI isPlaying onStart={() => undefined} playerBlueprint={blueprint} enemyBlueprint={blueprint} playerModel={undefined} enemyModel={undefined} {...props} />
);

describe('the built-in HUD', () => {
  it('offers a way out when the host gives one', () => {
    const onStop = vi.fn();
    render(hud({ onStop }));
    fireEvent.click(screen.getByRole('button', { name: /stop simulation/i }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('only shows the player when the host has its own way out', () => {
    render(hud());
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/simulation/i)).toBeNull();
    expect(screen.getByText('HP')).toBeTruthy();
  });

  it('shows no game-over screen of its own unless asked', () => {
    render(hud({ isGameOver: false, playerStats: { health: 0, maxHealth: 100, stamina: 0 } }));
    expect(screen.queryByText('GAME OVER')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
