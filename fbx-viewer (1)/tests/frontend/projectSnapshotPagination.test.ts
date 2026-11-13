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

    it('keeps an explicitly empty native domain when the host splits a page between domains', async () => {
        const service = new ProjectService();
        vi.spyOn(service, 'getSnapshot')
            .mockResolvedValueOnce({ ...page(8, true, '0.1'), domains: { models: { schemaVersion: 1, documents: [], hasMore: false } } })
            .mockResolvedValueOnce({ ...page(8, false), domains: { objects: { schemaVersion: 1, documents: [{ id: 'lamp' }], hasMore: false } } });
        expect((await service.getSnapshotAll())?.domains).toEqual({ models: [], objects: [{ id: 'lamp' }] });
    });

    it.each([null, {}, { documents: null }, { documents: 'missing' }])('rejects a malformed domain on a later page (%j)', async (models) => {
        const service = new ProjectService();
        vi.spyOn(service, 'getSnapshot')
            .mockResolvedValueOnce({ ...page(8, true, 'next'), domains: { models: [] } })
            .mockResolvedValueOnce({ ...page(8, false), domains: { models } });
        await expect(service.getSnapshotAll()).rejects.toThrow(/domain "models"/);
    });

    it('preserves flat host pages and refuses a switch from domain pages to flat documents', async () => {
        const service = new ProjectService();
        const flat = { ...page(8, false), domains: undefined, documents: [{ id: 'model' }] };
        const read = vi.spyOn(service, 'getSnapshot').mockResolvedValueOnce(flat);
        expect((await service.getSnapshotAll('models'))?.documents).toEqual(flat.documents);
        read.mockResolvedValueOnce(page(8, true, 'next')).mockResolvedValueOnce(flat);
        await expect(service.getSnapshotAll()).rejects.toThrow(/format between pages/);
    });

    it('refuses an ambiguous end of pagination', async () => {
        const service = new ProjectService();
        vi.spyOn(service, 'getSnapshot').mockResolvedValue({ ...page(8, false), hasMore: undefined });
        await expect(service.getSnapshotAll()).rejects.toThrow(/completion flag/);
    });

    it('requires every domain that promised more documents to resume, including across split pages', async () => {
        const service = new ProjectService();
        const first = { ...page(8, true, '0.1'), domains: { models: { documents: [{ id: 'm1' }], hasMore: true } } };
        const other = { ...page(8, false), domains: { objects: { documents: [], hasMore: false } } };
        const last = { ...page(8, false), domains: { models: { documents: [{ id: 'm2' }], hasMore: false } } };
        const read = vi.spyOn(service, 'getSnapshot').mockResolvedValueOnce(first).mockResolvedValueOnce(other);
        await expect(service.getSnapshotAll()).rejects.toThrow(/before all documents.*models/);

        read.mockResolvedValueOnce(first).mockResolvedValueOnce({ ...other, hasMore: true, cursor: '1' }).mockResolvedValueOnce(last);
        expect((await service.getSnapshotAll())?.domains?.models).toEqual([{ id: 'm1' }, { id: 'm2' }]);
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
