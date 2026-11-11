import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { applyKeptChanges, changesIn, diffScript, withEndingOf } from '../../components/Scripting/scriptDiff';
import { ScriptChanges } from '../../components/Scripting/ScriptChanges';
import { describeHudChange } from '../../components/HUDEditor/AIChatPanel';
import { graphFromTextures } from '../../components/Materials/graphFromTextures';
import { compileMaterialGraph, normalizeMaterialGraph } from '../../runtime/materials/materialGraph';
import { closeWrapSeam, decalInstruction, skyInstruction } from '../../components/Tools/paintedPictures';
import { nameFromWords } from '../../components/Tools/DescribeWithAI';
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

describe('retired paid cloud provider settings', () => {
  const FAL = { id: 'fal', name: 'fal.ai', route: 'cloud', available: false };

  const openKeysPage = async (credentialStatus: 'absent' | 'configured' = 'absent') => {
    vi.spyOn(hostProviderService, 'listProviders').mockResolvedValue([FAL] as never);
    vi.spyOn(hostProviderService, 'getProviderStatus').mockResolvedValue({
      id: 'fal', route: 'cloud', available: false, credentialStatus,
      settingsRevision: 1,
      settings: {
        enabled: false, routes: [], fallbackPolicy: 'none',
        requireCostConfirmation: true,
        budgets: { perJobMicroUsd: 0, dailyMicroUsd: 0, monthlyMicroUsd: 0 },
      },
    } as never);
    render(<SettingsModal onClose={() => undefined} />);
    expect(screen.queryByRole('button', { name: 'Spending' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Keys' }));
    await screen.findByText(/Cloud AI and spending budgets have been removed/);
  };

  it('does not let a user add keys, enable cloud, or configure an unenforceable spending cap', async () => {
    await openKeysPage();
    expect(screen.queryByRole('button', { name: 'Add key' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Spending' })).toBeNull();
    const enabled = screen.getByRole('checkbox', { name: 'On' }) as HTMLInputElement;
    expect(enabled.disabled).toBe(true);
    expect(enabled.checked).toBe(false);
  });

  it('still allows safely deleting a cloud key from older installations', async () => {
    const deleteKey = vi.spyOn(hostProviderService, 'deleteCredential').mockResolvedValue({});
    await openKeysPage('configured');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(deleteKey).toHaveBeenCalledWith('fal'));
    expect(screen.queryByRole('button', { name: 'Add key' })).toBeNull();
  });
});

describe('a panorama painted from a description', () => {
  it('asks for a panorama, and a decal for a transparent background', () => {
    expect(skyInstruction(' a red dawn ')).toContain('equirectangular panorama of a red dawn,');
    expect(decalInstruction(' a wolf ')).toContain('a wolf, isolated on a transparent background');
  });

  it('makes its edges meet, and leaves its middle alone', () => {
    const width = 100;
    const height = 20;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) data.set([x < 50 ? 100 : 140, 90, 90, 255], (y * width + x) * 4);
    }
    closeWrapSeam(data, width, height);
    const at = (x: number, y: number, channel = 0) => data[(y * width + x) * 4 + channel];
    expect(at(0, 10)).toBe(at(99, 10));
    expect(at(0, 10)).toBe(120);
    expect(at(50, 10)).toBe(140);
    expect(at(30, 10)).toBe(100);
    expect(at(0, 10, 1)).toBe(90);
    expect(at(0, 10, 3)).toBe(255);
  });
});

describe('a name from a description', () => {
  it('leaves out what a file name could not hold, and fits', () => {
    expect(nameFromWords('a "red": dawn/dusk\n')).toBe('a red dawn dusk');
    expect(nameFromWords('x'.repeat(200), ' normal')).toHaveLength(128);
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
