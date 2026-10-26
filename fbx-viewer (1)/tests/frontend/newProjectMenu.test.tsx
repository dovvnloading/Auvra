import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NewProjectMenu, PROJECT_TEMPLATE_OPTIONS } from '../../components/UI/NewProjectMenu';

const trigger = () => screen.getByRole('button', { name: /new/i });

describe('NewProjectMenu', () => {
  it('lists every project template with a description', () => {
    render(<NewProjectMenu onCreate={vi.fn()} />);

    expect(trigger()).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.click(trigger());
    const menu = screen.getByRole('menu', { name: /new/i });
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(trigger()).toHaveAttribute('aria-controls', menu.id);

    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(3);
    expect(screen.getByRole('menuitem', { name: 'Blank project' })).toHaveFocus();
    expect(screen.getByRole('menuitem', { name: 'Starter' })).toHaveAccessibleDescription(/walkable level/i);
    expect(screen.getByRole('menuitem', { name: 'Arena Sample' })).toHaveAccessibleDescription(/coins, physics, HUD and menus/i);
    expect(PROJECT_TEMPLATE_OPTIONS.map((option) => option.template)).toEqual(['blank', 'starter', 'arena']);
  });

  it('creates a project from the chosen template and closes', () => {
    const onCreate = vi.fn();
    render(<NewProjectMenu onCreate={onCreate} />);

    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('menuitem', { name: 'Arena Sample' }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith('arena');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it('supports keyboard navigation and activation', () => {
    const onCreate = vi.fn();
    render(<NewProjectMenu onCreate={onCreate} />);

    trigger().focus();
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Blank project' })).toHaveFocus();

    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Starter' })).toHaveFocus();
    expect(screen.getByRole('menuitem', { name: 'Starter' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('menuitem', { name: 'Blank project' })).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(menu, { key: 'End' });
    expect(screen.getByRole('menuitem', { name: 'Arena Sample' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Blank project' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(screen.getByRole('menuitem', { name: 'Arena Sample' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Home' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });

    // Items are native buttons, so Enter and Space activate the focused one with a click.
    fireEvent.click(document.activeElement as HTMLElement);
    expect(onCreate).toHaveBeenCalledWith('starter');
    expect(trigger()).toHaveFocus();
  });

  it('opens on the last item with ArrowUp and closes on Escape, returning focus', () => {
    render(<NewProjectMenu onCreate={vi.fn()} />);

    fireEvent.keyDown(trigger(), { key: 'ArrowUp' });
    expect(screen.getByRole('menuitem', { name: 'Arena Sample' })).toHaveFocus();

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    const windowListener = vi.fn();
    window.addEventListener('keydown', windowListener);
    try {
      const item = screen.getByRole('menuitem', { name: 'Arena Sample' });
      act(() => { item.dispatchEvent(escape); });
    } finally {
      window.removeEventListener('keydown', windowListener);
    }

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
    // Editor hotkeys listening on window must not also handle the menu's Escape.
    expect(windowListener).not.toHaveBeenCalled();
  });

  it('closes when pressing outside without choosing a template', () => {
    const onCreate = vi.fn();
    render(<div><span>outside</span><NewProjectMenu onCreate={onCreate} /></div>);

    fireEvent.click(trigger());
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText('outside'));

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('stays closed while busy and closes an open menu when an operation starts', () => {
    const onCreate = vi.fn();
    const { rerender } = render(<NewProjectMenu onCreate={onCreate} disabled />);

    expect(trigger()).toBeDisabled();
    fireEvent.click(trigger());
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    rerender(<NewProjectMenu onCreate={onCreate} />);
    fireEvent.click(trigger());
    expect(screen.getByRole('menu')).toBeInTheDocument();

    rerender(<NewProjectMenu onCreate={onCreate} disabled />);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('notes unsaved changes in the open project', () => {
    const { rerender } = render(<NewProjectMenu onCreate={vi.fn()} />);
    fireEvent.click(trigger());
    expect(screen.queryByText(/unsaved changes/i)).not.toBeInTheDocument();

    rerender(<NewProjectMenu onCreate={vi.fn()} unsavedChanges />);
    expect(screen.getByText(/unsaved changes/i)).toBeInTheDocument();
  });
});
