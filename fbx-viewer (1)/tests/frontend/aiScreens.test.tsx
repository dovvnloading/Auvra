import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { applyKeptChanges, changesIn, diffScript, withEndingOf } from '../../components/Scripting/scriptDiff';
import { ScriptChanges } from '../../components/Scripting/ScriptChanges';
import { describeHudChange } from '../../components/HUDEditor/AIChatPanel';
import { graphFromTextures } from '../../components/Materials/graphFromTextures';
import { compileMaterialGraph, normalizeMaterialGraph } from '../../runtime/materials/materialGraph';
import { SettingsModal } from '../../components/Settings/SettingsModal';
import { hostProviderService } from '../../services/HostProviderService';

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

describe('adding a key', () => {
  const FAL = { id: 'fal', name: 'fal.ai', route: 'cloud' };

  const openKeysPage = async () => {
    let tell: (event: { event: string; payload: unknown }) => void = () => undefined;
    vi.spyOn(hostProviderService, 'listProviders').mockResolvedValue([FAL] as never);
    vi.spyOn(hostProviderService, 'getProviderStatus').mockResolvedValue({ id: 'fal', credentialStatus: 'absent' } as never);
    vi.spyOn(hostProviderService, 'subscribeProviderEvents').mockImplementation((listener) => { tell = listener; return () => undefined; });
    render(<SettingsModal onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Keys' }));
    return (event: { event: string; payload: unknown }) => tell(event);
  };

  it('points at the key window until it closes', async () => {
    const tell = await openKeysPage();
    vi.spyOn(hostProviderService, 'configureCredential').mockResolvedValue({ waiting: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Add key' }));
    expect(await screen.findByText('Paste the key in the window that opened')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Add key' }) as HTMLButtonElement).disabled).toBe(true);
    act(() => tell({ event: 'provider.status', payload: { providerId: 'fal', status: 'unconfigured', operation: 'key.cancelled' } }));
    expect(await screen.findByText('No key')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says what went wrong when the key could not be kept', async () => {
    const tell = await openKeysPage();
    vi.spyOn(hostProviderService, 'configureCredential').mockResolvedValue({ waiting: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Add key' }));
    await screen.findByText('Paste the key in the window that opened');
    act(() => tell({ event: 'provider.status', payload: { providerId: 'fal', status: 'unconfigured', operation: 'key.failed', message: 'The key could not be saved on this computer.' } }));
    expect(await screen.findByText('The key could not be saved on this computer.')).toBeTruthy();
    expect(screen.queryByText('Paste the key in the window that opened')).toBeNull();
  });

  it('has nothing to wait for when a host answers at once', async () => {
    await openKeysPage();
    vi.spyOn(hostProviderService, 'configureCredential').mockResolvedValue({});
    fireEvent.click(await screen.findByRole('button', { name: 'Add key' }));
    expect(await screen.findByText('No key')).toBeTruthy();
    expect(screen.queryByText('Paste the key in the window that opened')).toBeNull();
  });
});

describe('a material painted from a description', () => {
  it('wires each texture to the input it is for', () => {
    const graph = graphFromTextures({ color: 'c', normal: 'n', roughness: 'r', metalness: 'm' });
    const into = (input: string) => graph.links.find((link) => link.toInput === input)?.fromNode;
    expect(into('baseColor')).toBe('color');
    expect(into('normal')).toBe('normal');
    expect(into('roughness')).toBe('roughness');
    expect(into('metalness')).toBe('metalness');
  });

  it('reads colour as colour and the others as data', () => {
    const graph = graphFromTextures({ color: 'c', roughness: 'r' });
    const params = (id: string) => graph.nodes.find((node) => node.id === id)?.params;
    expect(params('color')).toMatchObject({ texture: 'c', space: 'color' });
    expect(params('roughness')).toMatchObject({ texture: 'r', space: 'data' });
  });

  it('leaves out what was not painted, and still compiles', () => {
    const graph = graphFromTextures({ color: 'c' });
    expect(graph.links).toHaveLength(1);
    const normalized = normalizeMaterialGraph(graph);
    expect(normalized.nodes).toHaveLength(2);
    expect(compileMaterialGraph(normalized).outputs.baseColor).toBeTruthy();
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
