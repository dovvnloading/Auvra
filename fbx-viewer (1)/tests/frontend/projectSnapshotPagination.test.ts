import { describe, expect, it, vi } from 'vitest';
import { ProjectService, type ProjectSnapshot } from '../../utils/projectService';

const page = (revision: number, hasMore: boolean, cursor?: string, projectId = 'project-a'): ProjectSnapshot => ({
    projectId, revision, hasMore, cursor,
    domains: { materials: [{ id: `asset-${revision}` }] },
});

describe('native project snapshot pagination consistency', () => {
    it('combines pages only when the project identity and revision agree', async () => {
        const service = new ProjectService();
        const getSnapshot = vi.spyOn(service, 'getSnapshot')
            .mockResolvedValueOnce(page(8, true, 'next'))
            .mockResolvedValueOnce(page(8, false));
        const snapshot = await service.getSnapshotAll();
        expect(snapshot?.projectId).toBe('project-a');
        expect(snapshot?.revision).toBe(8);
        expect(snapshot?.domains?.materials).toEqual([{ id: 'asset-8' }, { id: 'asset-8' }]);
        expect(getSnapshot).toHaveBeenCalledTimes(2);
    });

    it('refuses to combine revisions from different saves', async () => {
        const service = new ProjectService();
        vi.spyOn(service, 'getSnapshot')
            .mockResolvedValueOnce(page(7, true, 'next'))
            .mockResolvedValueOnce(page(8, false));
        await expect(service.getSnapshotAll()).rejects.toThrow(/changed while reading/);
    });

    it('refuses a project switch during pagination', async () => {
        const service = new ProjectService();
        vi.spyOn(service, 'getSnapshot')
            .mockResolvedValueOnce(page(8, true, 'next'))
            .mockResolvedValueOnce(page(8, false, undefined, 'project-b'));
        await expect(service.getSnapshotAll()).rejects.toThrow(/changed while reading/);
    });

    it('refuses a truncated paginated response', async () => {
        const service = new ProjectService();
        vi.spyOn(service, 'getSnapshot')
            .mockResolvedValueOnce(page(8, true, 'next'))
            .mockResolvedValueOnce(null);
        await expect(service.getSnapshotAll()).rejects.toThrow(/before all documents/);
    });

    it('rejects a missing or repeated continuation cursor', async () => {
        const missing = new ProjectService();
        vi.spyOn(missing, 'getSnapshot').mockResolvedValue(page(8, true));
        await expect(missing.getSnapshotAll()).rejects.toThrow(/no continuation cursor/);

        const repeating = new ProjectService();
        const read = vi.spyOn(repeating, 'getSnapshot').mockResolvedValue(page(8, true, 'next'));
        await expect(repeating.getSnapshotAll()).rejects.toThrow(/repeated a continuation cursor/);
        expect(read).toHaveBeenCalledTimes(2);
    });
});
