import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { applyKeptChanges, changesIn, diffScript, withEndingOf } from '../../components/Scripting/scriptDiff';
import { ScriptChanges } from '../../components/Scripting/ScriptChanges';
import { describeHudChange } from '../../components/HUDEditor/AIChatPanel';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const BEFORE = ['function onStart(ctx) {', '  ctx.state.speed = 1;', '}', '', 'function onUpdate(ctx, dt) {', '  ctx.self.translate(0, 0, dt);', '}'].join('\n');
const AFTER = ['function onStart(ctx) {', '  ctx.state.speed = 2;', '}', '', 'function onUpdate(ctx, dt) {', '  ctx.self.translate(0, 0, dt);', '  ctx.self.rotate(0, dt, 0);', '}'].join('\n');

describe('what a proposed script changes', () => {
  it('finds each change on its own', () => {
    const changes = changesIn(diffScript(BEFORE, AFTER));
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({ removed: ['  ctx.state.speed = 1;'], added: ['  ctx.state.speed = 2;'], beforeLine: 2, afterLine: 2 });
    expect(changes[1]).toMatchObject({ removed: [], added: ['  ctx.self.rotate(0, dt, 0);'], beforeLine: 7, afterLine: 7 });
  });

  it('gives the proposal with every change kept, and the script with none', () => {
    const blocks = diffScript(BEFORE, AFTER);
    expect(applyKeptChanges(blocks, new Set([0, 1]))).toBe(AFTER);
    expect(applyKeptChanges(blocks, new Set())).toBe(BEFORE);
  });

  it('takes one change without the other', () => {
    const blocks = diffScript(BEFORE, AFTER);
    const kept = applyKeptChanges(blocks, new Set([1]));
    expect(kept).toContain('speed = 1');
    expect(kept).toContain('rotate');
  });

  it('copes with an empty script and with no change at all', () => {
    expect(applyKeptChanges(diffScript('', AFTER), new Set([0]))).toBe(AFTER);
    expect(changesIn(diffScript(BEFORE, BEFORE))).toEqual([]);
  });

  it('shows a whole rewrite of a very long script as one change', () => {
    const long = (word: string) => Array.from({ length: 3000 }, (_, index) => `${word} ${index}`).join('\n');
    const blocks = diffScript(long('old'), long('new'));
    expect(changesIn(blocks)).toHaveLength(1);
    expect(applyKeptChanges(blocks, new Set([0]))).toBe(long('new'));
  });
});

describe('the end of a proposal', () => {
  it('ends as the script does', () => {
    expect(withEndingOf('a\n', 'b')).toBe('b\n');
    expect(withEndingOf('a', 'b\n\n')).toBe('b');
    expect(changesIn(diffScript('a\nb\n', withEndingOf('a\nb\n', 'a\nb')))).toEqual([]);
  });
});

describe('reviewing a proposed script', () => {
  it('applies only the changes left ticked', () => {
    const onApply = vi.fn();
    render(<ScriptChanges before={BEFORE} after={AFTER} onApply={onApply} onDiscard={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Keep change 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply 1 of 2' }));
    expect(onApply.mock.calls[0][0]).toContain('speed = 1');
    expect(onApply.mock.calls[0][0]).toContain('rotate');
  });

  it('has nothing to apply with every change left out', () => {
    render(<ScriptChanges before={BEFORE} after={AFTER} onApply={vi.fn()} onDiscard={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Keep change 1' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Keep change 2' }));
    expect(screen.getByRole('button', { name: 'Apply 0 of 2' })).toBeDisabled();
  });

  it('says so when the answer is the same as the script', () => {
    const onDiscard = vi.fn();
    render(<ScriptChanges before={BEFORE} after={BEFORE} onApply={vi.fn()} onDiscard={onDiscard} />);
    screen.getByText('The answer is the same as the script');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onDiscard).toHaveBeenCalled();
  });
});

describe('a HUD change in words', () => {
  it('says what the host reports as a person would', () => {
    expect(describeHudChange('create HUD element score')).toBe('Add score');
    expect(describeHudChange('update HUD element score')).toBe('Change score');
    expect(describeHudChange('delete HUD element score')).toBe('Remove score');
    expect(describeHudChange('something else')).toBe('something else');
  });
});
