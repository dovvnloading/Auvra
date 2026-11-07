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
    private loading: Promise<void> | null = null;
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

    /** Reads them from the project the first time they are wanted there (again when another project is open). */
    load(): void {
        const project = projectService.getStatus().projectId ?? null;
        if (!project || (project === this.project && this.loading)) return;
        this.project = project;
        this.presets = [];
        this.loading = (async () => {
            try {
                const snapshot = await projectService.getSnapshotAll('metadata');
                const documents = (snapshot?.domains?.metadata ?? snapshot?.documents ?? []) as Array<{ id?: string; settings?: { presets?: unknown } }>;
                const document = Array.isArray(documents) ? documents.find((candidate) => candidate?.id === SHARED_PRESETS_DOCUMENT) : undefined;
                if (this.project === project) this.presets = readSharedPresets(document?.settings?.presets);
            } catch (error) {
                frontendDiagnostics.failure('texture_graph_shared_presets_read_failed', error);
            }
            this.changed();
        })();
    }

    /** The shared presets for a graph. */
    of(graphId: string): GraphPreset[] {
        return this.presets.filter((preset) => preset.graphId === graphId);
    }

    private async write(next: SharedPreset[]): Promise<boolean> {
        const before = this.presets;
        this.presets = next;
        this.changed();
        try {
            await projectService.applyChanges([{ domain: 'metadata', operation: 'upsert', id: SHARED_PRESETS_DOCUMENT, value: sharedPresetsDocument(next) }]);
            return true;
        } catch (error) {
            frontendDiagnostics.failure('texture_graph_shared_presets_write_failed', error);
            this.presets = before;
            this.changed();
            return false;
        }
    }

    /** Keeps a preset for a graph (a new one, or in place of the one of its id). */
    put(graphId: string, preset: GraphPreset): Promise<boolean> {
        const others = this.presets.filter((candidate) => candidate.graphId !== graphId);
        const mine = putPreset(this.of(graphId), preset).map((candidate) => ({ ...candidate, graphId }));
        return this.write([...others, ...mine]);
    }

    rename(id: string, name: string): Promise<boolean> {
        return this.write(renamePreset(this.presets, id, name) as SharedPreset[]);
    }

    remove(id: string): Promise<boolean> {
        return this.write(removePreset(this.presets, id) as SharedPreset[]);
    }
}

export const sharedPresets = new SharedPresets();
