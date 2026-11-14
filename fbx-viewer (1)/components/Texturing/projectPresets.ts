import { materialLibrary } from '../../runtime/materials/materialLibrary';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { projectService } from '../../utils/projectService';
import { MAX_PRESETS, putPreset, removePreset, renamePreset } from '../../texturing/graph/parameters';
import type { GraphParameterValue, GraphPreset } from '../../texturing/graph/types';

/**
 * PRESETS SHARED IN THE PROJECT
 *
 * Presets kept in the project rather than in a graph: each is for one graph (by its id), and shows
 * wherever that graph is edited or used, without changing the graph. They live in one document of
 * the project's metadata (its free-form `settings`), read when first wanted and written on change.
 */

export const SHARED_PRESETS_DOCUMENT = 'texture-graph-presets';

export interface SharedPreset extends GraphPreset {
    /** The graph it is for. */
    graphId: string;
}

/** Shared presets as stored made safe: an id, a name, the graph, plain values. */
export const readSharedPresets = (value: unknown): SharedPreset[] => {
    if (!Array.isArray(value)) return [];
    const presets: SharedPreset[] = [];
    for (const candidate of value.slice(0, MAX_PRESETS * 32)) {
        const raw = candidate as Partial<SharedPreset> | null;
        if (!raw || typeof raw.id !== 'string' || !raw.id || typeof raw.graphId !== 'string' || !raw.graphId || presets.some((preset) => preset.id === raw.id)) continue;
        const values = raw.values && typeof raw.values === 'object' && !Array.isArray(raw.values) ? JSON.parse(JSON.stringify(raw.values)) as Record<string, GraphParameterValue> : {};
        const preset: SharedPreset = { id: raw.id, graphId: raw.graphId, name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 64) : 'Preset', values };
        if (typeof raw.seed === 'number' && Number.isFinite(raw.seed)) preset.seed = Math.round(raw.seed);
        presets.push(preset);
    }
    return presets;
};

/** The document the shared presets are kept in. */
export const sharedPresetsDocument = (presets: readonly SharedPreset[]): Record<string, unknown> => ({
    id: SHARED_PRESETS_DOCUMENT,
    name: 'Texture graph presets',
    settings: { version: 1, presets },
});

class SharedPresets {
    private presets: SharedPreset[] = [];
    private project: string | null = null;
    private generation = -1;
    private loading: Promise<boolean> | null = null;
    private writes: Promise<unknown> = Promise.resolve();
    private readonly listeners = new Set<() => void>();
    private version = 0;

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getVersion = (): number => this.version;

    private changed(): void {
        this.version++;
        for (const listener of this.listeners) listener();
    }

    private current(project: string | null, generation: number): boolean {
        return project !== null && project === projectService.getStatus().projectId && generation === materialLibrary.generation;
    }

    /** Reload even when the same project is reopened after an external edit. */
    load(): Promise<boolean> {
        const project = projectService.getStatus().projectId;
        const generation = materialLibrary.generation;
        if (!project) return Promise.resolve(false);
        if (this.loading && this.project === project && this.generation === generation) return this.loading;
        this.project = project;
        this.generation = generation;
        this.presets = [];
        this.loading = (async () => {
            try {
                const snapshot = await projectService.getSnapshotAll('metadata');
                if (!this.current(project, generation)) return false;
                if (!snapshot || snapshot.projectId !== project) throw new Error('The shared preset snapshot belongs to a different project.');
                const documents = (snapshot.domains?.metadata ?? snapshot.documents) as Array<{ id?: string; settings?: { presets?: unknown } }>;
                if (!Array.isArray(documents)) throw new Error('The project did not return its metadata documents.');
                const document = documents.find(candidate => candidate?.id === SHARED_PRESETS_DOCUMENT);
                this.presets = readSharedPresets(document?.settings?.presets);
                this.changed();
                return true;
            } catch (error) {
                if (this.current(project, generation)) {
                    this.loading = null; // A later request can retry; never write from an unread inventory.
                    frontendDiagnostics.failure('texture_graph_shared_presets_read_failed', error);
                    this.changed();
                }
                return false;
            }
        })();
        this.changed();
        return this.loading;
    }

    of(graphId: string): GraphPreset[] {
        return this.current(this.project, this.generation) ? this.presets.filter(preset => preset.graphId === graphId) : [];
    }

    /** Compute each edit after its generation's load and all older edits have settled. */
    private write(update: (current: SharedPreset[]) => SharedPreset[]): Promise<boolean> {
        const project = projectService.getStatus().projectId;
        const generation = materialLibrary.generation;
        const write = async () => {
            if (!this.current(project, generation) || !await this.load() || !this.current(project, generation)) return false;
            const next = update(this.presets);
            try {
                await projectService.applyChanges([{ domain: 'metadata', operation: 'upsert', id: SHARED_PRESETS_DOCUMENT, value: sharedPresetsDocument(next) }]);
                if (!this.current(project, generation)) return false;
                this.presets = next;
                this.changed();
                return true;
            } catch (error) {
                frontendDiagnostics.failure('texture_graph_shared_presets_write_failed', error);
                return false;
            }
        };
        const result = this.writes.then(write, write);
        this.writes = result;
        return result;
    }

    /** Drain writes started from the shared-preset UI before snapshotting a rename. */
    async flushPendingWrites(): Promise<void> {
        // The editor can queue another preset edit while an earlier write runs.
        // Observe the final queued result, not an intermediate successful one.
        let pending = this.writes;
        for (;;) {
            const saved = await pending;
            if (saved === false) throw new Error('A shared parameter preset could not be saved. Retry it before renaming.');
            if (pending === this.writes) return;
            pending = this.writes;
        }
    }

    put(graphId: string, preset: GraphPreset): Promise<boolean> {
        return this.write(current => {
            const others = current.filter(candidate => candidate.graphId !== graphId);
            const mine = putPreset(current.filter(candidate => candidate.graphId === graphId), preset)
                .map(candidate => ({ ...candidate, graphId }));
            return [...others, ...mine];
        });
    }

    rename(id: string, name: string): Promise<boolean> {
        return this.write(current => renamePreset(current, id, name) as SharedPreset[]);
    }

    remove(id: string): Promise<boolean> {
        return this.write(current => removePreset(current, id) as SharedPreset[]);
    }
}

export const sharedPresets = new SharedPresets();
