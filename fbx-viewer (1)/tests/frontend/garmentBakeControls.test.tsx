import { createHash, webcrypto } from 'node:crypto';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GarmentBakeControls } from '../../components/Environment/GarmentBakeControls';
import { GARMENT_COMPONENT, GarmentInstance } from '../../runtime/components/garmentComponent';
import { GameContentProvider } from '../../runtime/GameContentContext';
import { bakeFitting, fittingBakeRecipe, type FittingBakeInput, type FittingBakeReply } from '../../runtime/garments/bake';
import { createSleevelessTop, type GarmentPattern } from '../../runtime/garments/pattern';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import type { LevelComponent, LevelObject } from '../../types';

const mock = vi.hoisted(() => ({
    current: true,
    upload: vi.fn<(file: File, options: { signal: AbortSignal }) => Promise<string>>(),
    frame: new Set<(state: unknown, dt: number) => void>(),
}));
vi.mock('../../utils/projectService', () => ({ projectService: {
    getStatus: () => ({ projectId: 'project-1', readOnly: false }),
    uploadAsset: mock.upload,
} }));
vi.mock('../../utils/editorSession', () => ({ editorSession: {
    captureReady: () => ({ projectId: 'project-1', generation: 1 }),
    isCurrent: () => mock.current,
} }));
vi.mock('@react-three/fiber', async importOriginal => {
    const actual = await importOriginal<typeof import('@react-three/fiber')>();
    const { useLayoutEffect } = await import('react');
    return { ...actual, useFrame: (cb: (state: unknown, dt: number) => void) => {
        useLayoutEffect(() => {
            mock.frame.add(cb);
            return () => { mock.frame.delete(cb); };
        }, [cb]);
    } };
});

const object: LevelObject = { id: 'form', levelId: 'level', modelId: '', type: 'prop', name: 'Fitting form',
    position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
const component = (props: Record<string, unknown>): LevelComponent => ({ id: 'garment', type: 'garment', enabled: true, props });
function pattern() {
    const value = createSleevelessTop();
    value.edgeLength = .12;
    return value;
}
class TestWorker {
    static instances: TestWorker[] = [];
    static throwOnPost = false;
    postMessage = vi.fn<(message: { input: FittingBakeInput; seconds: number }) => void>();
    terminate = vi.fn();
    onmessage: ((event: { data: FittingBakeReply }) => Promise<void>) | null = null;
    constructor() {
        TestWorker.instances.push(this);
        if (TestWorker.throwOnPost) this.postMessage.mockImplementationOnce(() => { throw new Error('worker channel closed'); });
    }
    reply(data: FittingBakeReply): Promise<void> { return this.onmessage!({ data }); }
}
function mountEditor(source: GarmentPattern, save = vi.fn()) {
    const ui = (p: GarmentPattern, props: Record<string, unknown> = {}) =>
        <GarmentBakeControls pattern={p} object={object} component={component({ pattern: p, ...props })} onChangeProps={save} />;
    const view = render(ui(source));
    fireEvent.click(screen.getByText('Fitting bake', { selector: 'summary' }));
    const start = async () => {
        const button = screen.getByRole('button', { name: 'Bake fitting clip' });
        await waitFor(() => expect(button).toBeEnabled());
        fireEvent.change(screen.getByLabelText('Duration'), { target: { value: '1' } });
        fireEvent.click(button);
        return TestWorker.instances[TestWorker.instances.length - 1];
    };
    return { ...view, save, start, replace: (p: GarmentPattern, props?: Record<string, unknown>) => view.rerender(ui(p, props)) };
}
function tickFrame(dt: number): void {
    act(() => { for (const cb of mock.frame) cb({}, dt); });
}
describe('fitting bake controls and runtime cache selection', () => {
    beforeEach(() => {
        mock.current = true;
        mock.upload.mockReset();
        TestWorker.instances.length = 0;
        TestWorker.throwOnPost = false;
        vi.stubGlobal('crypto', webcrypto);
        vi.stubGlobal('Worker', TestWorker);
    });
    afterEach(() => vi.unstubAllGlobals());

    it('uploads the actual fitting bytes and publishes the content-addressed reference and recipe', async () => {
        const source = pattern(), editor = mountEditor(source), worker = await editor.start();
        const { input, seconds } = worker.postMessage.mock.calls[0][0];
        const bytes = bakeFitting(input, seconds, () => {});
        const expectedId = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
        mock.upload.mockImplementation(async file => {
            expect(file.name).toBe('garment-fit.agc');
            return createHash('sha256').update(new Uint8Array(await file.arrayBuffer())).digest('hex');
        });
        await act(() => worker.reply({ bytes, duration: seconds }));
        expect(mock.upload).toHaveBeenCalledOnce();
        expect(editor.save).toHaveBeenCalledExactlyOnceWith({
            fittingBake: { assetId: expectedId, recipe: await fittingBakeRecipe(input), duration: 1 }, playback: 'cache',
        });
    });

    it.each(['followBone', 'collisionMesh'])('makes a bake available again when the artist clears a %s binding', async (binding) => {
        const p = pattern(), editor = mountEditor(p);
        const button = screen.getByRole('button', { name: 'Bake fitting clip' });
        await waitFor(() => expect(button).toBeEnabled());
        editor.replace(p, { [binding]: 'Chest' });
        expect(button).toBeDisabled();
        editor.replace(p);
        await waitFor(() => expect(button).toBeEnabled());
    });

    it('can immediately retry when posting work to a new worker fails', async () => {
        const editor = mountEditor(pattern());
        TestWorker.throwOnPost = true;
        const failed = await editor.start();
        expect(failed.terminate).toHaveBeenCalled();
        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Bake fitting clip' })).toBeEnabled();
        TestWorker.throwOnPost = false;
        const retried = await editor.start();
        expect(retried).not.toBe(failed);
        expect(retried.postMessage).toHaveBeenCalled();
        expect(editor.save).not.toHaveBeenCalled();
    });

    it('drops canceled, replaced, stale-project and unmounted worker completions', async () => {
        const p = pattern(), editor = mountEditor(p);
        const retired = await editor.start();
        fireEvent.click(screen.getByRole('button', { name: /Cancel bake/ }));
        await act(() => retired.reply({ bytes: new ArrayBuffer(1), duration: 1 }));
        const replaced = await editor.start();
        const changed = structuredClone(p);
        changed.panels[0].boundary[0].x -= .01;
        editor.replace(changed);
        await act(() => replaced.reply({ bytes: new ArrayBuffer(1), duration: 1 }));
        const stale = await editor.start();
        mock.current = false;
        await act(() => stale.reply({ bytes: new ArrayBuffer(1), duration: 1 }));
        expect(screen.getByRole('alert')).toHaveTextContent(/project changed/i);
        mock.current = true;
        const unmounted = await editor.start();
        editor.unmount();
        await act(() => unmounted.reply({ bytes: new ArrayBuffer(1), duration: 1 }));
        for (const w of [retired, replaced, stale, unmounted]) expect(w.terminate).toHaveBeenCalled();
        expect(mock.upload).not.toHaveBeenCalled();
        expect(editor.save).not.toHaveBeenCalled();
    });

    it.each(['cancel', 'new project'] as const)('checks session identity after delayed host upload (%s)', async why => {
        const editor = mountEditor(pattern()), worker = await editor.start();
        let release!: (id: string) => void;
        mock.upload.mockImplementation(() => new Promise(resolve => { release = resolve; }));
        let completion!: Promise<void>;
        act(() => { completion = worker.reply({ bytes: new ArrayBuffer(4), duration: 1 }); });
        expect(mock.upload).toHaveBeenCalledOnce();
        if (why === 'cancel') fireEvent.click(screen.getByRole('button', { name: /Cancel bake/ }));
        else mock.current = false;
        await act(async () => { release('a'.repeat(64)); await completion; });
        expect(editor.save).not.toHaveBeenCalled();
    });

    it.each(['invalid header', 'corrupted position'] as const)('keeps live cloth running for a cache with %s', async (fault) => {
        const p = pattern(), input = { pattern: p, fabric: 'cotton' as const, animateTorso: true, selfCollision: false };
        const recipe = await fittingBakeRecipe(input);
        const bytes = fault === 'invalid header' ? new ArrayBuffer(6) : bakeFitting(input, 1, () => {});
        const payload = new Uint8Array(bytes);
        const assetId = createHash('sha256').update(payload).digest('hex');
        if (fault === 'corrupted position') payload[payload.length - 1] ^= 1;
        const content = { models: [], textures: [], audioAssets: [], sockets: [], attachments: [], blueprints: [],
            readAssetBytes: vi.fn(async () => bytes) };
        const renderPose = vi.spyOn(GarmentInstance.prototype, 'presentCachedPose');
        const live = vi.spyOn(GarmentInstance.prototype, 'advance');
        const diagnostic = vi.spyOn(frontendDiagnostics, 'warning');
        const Render = GARMENT_COMPONENT.Render!;
        render(<GameContentProvider value={content}>
            <Render object={object} mode="runtime" component={component({ pattern: p, wind: 0, playback: 'cache',
                fittingBake: { assetId, recipe, duration: 1 } })} />
        </GameContentProvider>);
        await waitFor(() => expect(diagnostic).toHaveBeenCalledWith('garment_cache_unavailable'));
        tickFrame(1 / 30);
        expect(content.readAssetBytes).toHaveBeenCalledOnce();
        expect(live).toHaveBeenCalledOnce();
        expect(renderPose).not.toHaveBeenCalled();
    });

    it('renders a matching cached pose, retains its clock for color edits, and immediately resumes live stepping on a stale recipe', async () => {
        const p = pattern(), input = { pattern: p, fabric: 'cotton' as const, animateTorso: true, selfCollision: false };
        const bytes = bakeFitting(input, 1, () => {}), recipe = await fittingBakeRecipe(input);
        const ref = { assetId: createHash('sha256').update(new Uint8Array(bytes)).digest('hex'), recipe, duration: 1 };
        const readAssetBytes = vi.fn(async () => bytes);
        const content = { models: [], textures: [], audioAssets: [], sockets: [], attachments: [], blueprints: [], readAssetBytes };
        const renderPose = vi.spyOn(GarmentInstance.prototype, 'presentCachedPose');
        const step = vi.spyOn(GarmentInstance.prototype, 'advance');
        const warning = vi.spyOn(frontendDiagnostics, 'warning');
        const Render = GARMENT_COMPONENT.Render!;
        const ui = (props: Record<string, unknown>) => <GameContentProvider value={content}>
            <Render object={object} mode="runtime" component={component({ pattern: p, wind: 0, playback: 'cache', fittingBake: ref, ...props })} />
        </GameContentProvider>;
        const runtime = render(ui({}));
        await waitFor(() => { tickFrame(1 / 30); expect(renderPose).toHaveBeenCalled(); });
        const instance = renderPose.mock.instances.at(-1);
        const last = renderPose.mock.calls.length;
        runtime.rerender(ui({ color: '#dd1100' }));
        tickFrame(1 / 30);
        expect(renderPose.mock.calls.length).toBe(last + 1);
        expect(renderPose.mock.instances.at(-1)).toBe(instance);
        expect(renderPose.mock.calls.at(-1)![1].x).toBeGreaterThan(0);
        expect(readAssetBytes).toHaveBeenCalledOnce();
        runtime.rerender(ui({ fabric: 'silk' }));
        const prev = renderPose.mock.calls.length;
        tickFrame(1 / 30);
        await waitFor(() => expect(warning).toHaveBeenCalledWith('garment_cache_unavailable'));
        expect(renderPose.mock.calls).toHaveLength(prev);
        expect(step.mock.instances.at(-1)).not.toBe(instance);
        expect(readAssetBytes).toHaveBeenCalledOnce();
    });
});
