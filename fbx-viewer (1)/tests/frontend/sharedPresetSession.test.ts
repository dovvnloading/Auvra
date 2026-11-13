import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { materialLibrary } from '../../runtime/materials/materialLibrary';
import { projectService, type ProjectSnapshot } from '../../utils/projectService';
import { sharedPresets, sharedPresetsDocument, type SharedPreset } from '../../components/Texturing/projectPresets';

const deferredSnapshot = () => {
    let resolve!: (value: ProjectSnapshot) => void;
    const promise = new Promise<ProjectSnapshot>(settle => { resolve = settle; });
    return { promise, resolve };
};
const projectId = 'reopened-project';
const preset = (id: string, name: string): SharedPreset => ({ graphId: 'graph', id, name: id, values: { [name]: 0.25 } });
const snapshot = (...presets: SharedPreset[]): ProjectSnapshot => ({
    projectId, revision: 7, domains: { metadata: [sharedPresetsDocument(presets)] },
});

beforeEach(() => {
    materialLibrary.replaceAll([]);
    const status = projectService.getStatus();
    vi.spyOn(projectService, 'getStatus').mockReturnValue({ ...status, projectId });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('project-shared preset generations', () => {
    it('does not publish a late read after reopening the same project', async () => {
        const pending = deferredSnapshot();
        const load = vi.spyOn(projectService, 'getSnapshotAll').mockReturnValueOnce(pending.promise)
            .mockResolvedValueOnce(snapshot(preset('current', 'patina')));
        const oldRead = sharedPresets.load();
        materialLibrary.replaceAll([]);
        expect(await sharedPresets.load()).toBe(true);
        pending.resolve(snapshot(preset('obsolete', 'wear')));
        expect(await oldRead).toBe(false);
        expect(sharedPresets.of('graph')).toEqual([preset('current', 'patina')]);
        expect(load).toHaveBeenCalledTimes(2);
    });

    it('serializes concurrent updates after loading the current names', async () => {
        vi.spyOn(projectService, 'getSnapshotAll').mockResolvedValue(snapshot(preset('saved', 'patina')));
        const save = vi.spyOn(projectService, 'applyChanges').mockResolvedValue({ revision: 8 });
        expect(await Promise.all([sharedPresets.put('graph', preset('first', 'patina')),
            sharedPresets.put('graph', preset('second', 'patina'))])).toEqual([true, true]);
        expect(sharedPresets.of('graph').map(item => item.id)).toEqual(['saved', 'first', 'second']);
        expect(save).toHaveBeenCalledTimes(2);
        expect(save.mock.calls[1][0][0].value).toEqual(sharedPresetsDocument(sharedPresets.of('graph') as SharedPreset[]));
    });

    it('fences an in-flight write and queued edit when the same project is reopened', async () => {
        vi.spyOn(projectService, 'getSnapshotAll').mockResolvedValueOnce(snapshot(preset('saved', 'wear')))
            .mockResolvedValueOnce(snapshot(preset('saved', 'patina')));
        const pending = deferredSnapshot();
        const save = vi.spyOn(projectService, 'applyChanges').mockReturnValue(pending.promise);
        const first = sharedPresets.put('graph', preset('first', 'wear'));
        const second = sharedPresets.put('graph', preset('second', 'wear'));
        await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
        materialLibrary.replaceAll([]);
        expect(sharedPresets.of('graph')).toEqual([]);
        expect(await sharedPresets.load()).toBe(true);
        pending.resolve({ revision: 8 });
        expect(await Promise.all([first, second])).toEqual([false, false]);
        expect(save).toHaveBeenCalledTimes(1);
        expect(sharedPresets.of('graph')).toEqual([preset('saved', 'patina')]);
    });
});
