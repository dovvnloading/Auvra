import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppDialogHost } from '../../components/UI/AppDialogHost';
import { appAlert, appConfirm, appPrompt } from '../../utils/appDialogs';

describe('app dialogs', () => {
  it('resolves a prompt with the typed text when submitted', async () => {
    render(<AppDialogHost />);
    let answer: Promise<string | null> = Promise.resolve(null);
    act(() => { answer = appPrompt('New prefab', { defaultValue: 'Rock' }); });
    const field = screen.getByRole('textbox', { name: 'New prefab' });
    expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: 'Boulder' } });
    fireEvent.submit(screen.getByRole('dialog'));
    await expect(answer).resolves.toBe('Boulder');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('answers a confirm with false on Escape and keeps the key from the editor', async () => {
    const editorKeys: string[] = [];
    const onKey = (event: KeyboardEvent) => editorKeys.push(event.key);
    window.addEventListener('keydown', onKey);
    render(<AppDialogHost />);
    let answer: Promise<boolean> = Promise.resolve(true);
    act(() => { answer = appConfirm('Delete "Rock"?', { acceptLabel: 'Delete', danger: true }); });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Delete' }), { key: 'Escape' });
    await expect(answer).resolves.toBe(false);
    expect(editorKeys).toEqual([]);
    window.removeEventListener('keydown', onKey);
  });

  it('shows queued dialogs one at a time, oldest first', async () => {
    render(<AppDialogHost />);
    let first: Promise<null> = Promise.resolve(null);
    let second: Promise<boolean> = Promise.resolve(false);
    act(() => {
      first = appAlert('Saved');
      second = appConfirm('Continue?');
    });
    expect(screen.getByRole('alertdialog', { name: 'Saved' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Continue?' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await expect(first).resolves.toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }));
    await expect(second).resolves.toBe(true);
  });
});
