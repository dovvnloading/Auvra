import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MenuButton } from '../../components/UI/MenuButton';

describe('MenuButton', () => {
  it('opens a menu whose enabled items run their action and close it', () => {
    const exportProject = vi.fn();
    const importProject = vi.fn();
    render(<MenuButton label="More" items={[
      { label: 'Import project', onSelect: importProject },
      { label: 'Export project', disabled: true, onSelect: exportProject },
    ]} />);

    fireEvent.click(screen.getByRole('button', { name: /More/ }));
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: /Export project/ }));
    expect(exportProject).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeTruthy();

    fireEvent.click(screen.getByRole('menuitem', { name: /Import project/ }));
    expect(importProject).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on Escape and stays shut while disabled', () => {
    const { rerender } = render(<MenuButton label="More" items={[{ label: 'Import project', onSelect: vi.fn() }]} />);
    fireEvent.click(screen.getByRole('button', { name: /More/ }));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    rerender(<MenuButton label="More" disabled items={[{ label: 'Import project', onSelect: vi.fn() }]} />);
    fireEvent.click(screen.getByRole('button', { name: /More/ }));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
