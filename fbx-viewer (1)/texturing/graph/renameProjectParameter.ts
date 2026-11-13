import { materialAssetDocument, type MaterialAsset } from '../../runtime/materials/materialLibrary';
import type { ProjectChange } from '../../utils/projectService';
import { renameParameter, formulaNameProblem } from './parameters';
import { readStoredGraph, withParameterPictures } from './stored';
import { GRAPH_USING_TYPES } from './nodes/io';

/**
 * M0: A pure cross-document inventory/rename plan, not a UI save action.
 *
 * A public graph parameter may be referenced in material graph nodes, paint fill
 * graphs, model assignments and per-object overrides. Rewriting only the open
 * graph can silently change appearances. The caller must supply COMPLETE
 * snapshots for all four host domains, validate this plan, and persist all
 * changes in a SINGLE project.applyChanges transaction before updating caches.
 * Do not apply one change at a time or mutate input documents optimistically.
 */

export interface ProjectModelForRename {
    id: string;
    materialOverrides?: unknown;
    [key: string]: unknown;
}
export interface ProjectObjectForRename {
    id: string;
    modelId: string;
    materialOverrides?: unknown;
    [key: string]: unknown;
}
export interface ProjectMetadataForRename {
    id: string;
    settings?: unknown;
    [key: string]: unknown;
}

export interface TextureParameterRenameInput {
    sourceMaterialId: string;
    from: string;
    to: string;
    /** Complete authoritative contents of each domain, not just currently visible objects. */
    materials: readonly MaterialAsset[];
    models: readonly ProjectModelForRename[];
    objects: readonly ProjectObjectForRename[];
    metadata: readonly ProjectMetadataForRename[];
}

export interface RenameImpact {
    sourceMaterialId: string;
    from: string;
    to: string;
    /** Material asset IDs, including the source, in deterministic input order. */
    materials: string[];
    models: string[];
    objects: string[];
    metadata: string[];
    nestedNodes: number;
    paintReferences: number;
    modelOverrides: number;
    objectOverrides: number;
    sharedPresets: number;
}

export interface TextureParameterRenamePlan {
    impact: RenameImpact;
    /** All upserts are for complete documents; commit them in one host transaction. */
    changes: ProjectChange[];
    /** Reverse full-document snapshots for a single atomic undo operation. */
    undoChanges: ProjectChange[];
    /** Updated assets to publish in materialLibrary only after host commit succeeds. */
    changedMaterials: MaterialAsset[];
}

const record = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const owns = (r: Record<string, unknown>, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(r, key);

const collision = (path: string, key: string): never => {
    throw new Error(\`Cannot rename graph parameter: "\${key}" already exists in \${path}. No project documents were changed.\`);
};

/** One exact key only; substring matches and local parameter names must not be edited. */
const renameValueKey = (values: Record<string, unknown>, from: string, to: string, path: string): boolean => {
    if (!owns(values, from)) return false;
    if (owns(values, to)) collision(path, to);
    values[to] = values[from];
    delete values[from];
    return true;
};

/** The graph used as a node keeps exposed parameter values on the using node. */
const renamedGraphUser = (
    material: MaterialAsset, sourceId: string, from: string, to: string,
): { asset: MaterialAsset; count: number } | null => {
    const stored = record(material.textureGraph);
    const graph = record(stored?.graph);
    if (!graph || !Array.isArray(graph.nodes)) return null;
    let count = 0;
    const nodes = graph.nodes.map((candidate) => {
        const node = record(candidate);
        const params = record(node?.params);
        if (!node || !params || !GRAPH_USING_TYPES.has(String(node.type)) || params.graph !== sourceId || !owns(params, from)) return candidate;
        if (graph.version !== 1) throw new Error(\`Cannot edit a graph in "\${material.name}": unsupported graph version.\`);
        const next = { ...params };
        renameValueKey(next, from, to, \`graph node \${String(node.id)} in "\${material.name}"\`);
        count++;
        return { ...node, params: next };
    });
    if (!count) return null;
    return {
        asset: { ...material, textureGraph: { ...stored, graph: { ...graph, nodes } } },
        count,
    };
};

/** Only graph-valued paint fill/mask references use the source's parameter keys. */
const renamedPaintUsers = (
    material: MaterialAsset, sourceId: string, from: string, to: string,
): { asset: MaterialAsset; count: number } | null => {
    const paint = record(material.paint);
    if (!paint || !Array.isArray(paint.layers)) return null;
    // Clone only the paint document. Leave other material and graph documents untouched.
    const copy = structuredClone(paint);
    let count = 0;
    const visit = (layers: unknown[], depth: number): void => {
        if (depth > 16) throw new Error(\`Paint layers in "\${material.name}" are nested too deeply to rename safely.\`);
        for (const candidate of layers) {
            const layer = record(candidate);
            if (!layer) continue;
            const fill = record(layer.fill);
            if (fill) for (const [key, candidateFill] of Object.entries(fill)) {
                const entry = record(candidateFill);
                const values = record(entry?.values);
                if (entry?.kind === 'graph' && entry.graphId === sourceId && values && renameValueKey(values, from, to, \`paint fill \${key} in "\${material.name}"\`)) count++;
            }
            if (Array.isArray(layer.mask)) for (const candidateMask of layer.mask) {
                const mask = record(candidateMask), values = record(mask?.values);
                if (mask?.graphId === sourceId && values && renameValueKey(values, from, to, \`paint mask in "\${material.name}"\`)) count++;
            }
            if (Array.isArray(layer.layers)) visit(layer.layers, depth + 1);
        }
    };
    visit(copy.layers as unknown[], 0);
    if (!count) return null;
    if (paint.version !== 1 && paint.version !== undefined) {
        throw new Error(\`Cannot rename a reference inside "\${material.name}": unsupported paint document version.\`);
    }
    return { asset: { ...material, paint: copy }, count };
};

/** Model/object overrides are arrays of named parameters, not dictionary keys. */
const renamedOverrideSettings = (
    overrides: unknown, relevant: (name: string, entry: Record<string, unknown>) => boolean,
    from: string, to: string, path: string,
): { value: unknown; count: number } => {
    const top = record(overrides);
    if (!top) return { value: overrides, count: 0 };
    const next: Record<string, unknown> = { ...top };
    let count = 0;
    for (const [name, candidate] of Object.entries(top)) {
        const entry = record(candidate);
        if (!entry || !relevant(name, entry) || !Array.isArray(entry.parameters)) continue;
        const fields = entry.parameters.map((item) => record(item));
        if (!fields.some((item) => item?.name === from)) continue;
        if (fields.some((item) => item?.name === to)) collision(\`\${path} material "\${name}"\`, to);
        count += fields.filter((item) => item?.name === from).length;
        next[name] = {
            ...entry,
            parameters: entry.parameters.map((item) => {
                const field = record(item);
                return field?.name === from ? { ...field, name: to } : item;
            }),
        };
    }
    return { value: count ? next : overrides, count };
};

/** Metadata document for graph presets kept in the open project. */
const renamedSharedPresets = (
    doc: ProjectMetadataForRename, sourceId: string, from: string, to: string,
): { document: ProjectMetadataForRename; count: number } | null => {
    if (doc.id !== 'texture-graph-presets') return null;
    const settings = record(doc.settings);
    if (!settings || !Array.isArray(settings.presets)) return null;
    let count = 0;
    const presets = settings.presets.map((candidate) => {
        const preset = record(candidate), values = record(preset?.values);
        if (!preset || preset.graphId !== sourceId || !values || !owns(values, from)) return candidate;
        if (settings.version !== 1) throw new Error('Shared graph presets use an unsupported version.');
        const copied = { ...values };
        renameValueKey(copied, from, to, 'project-shared graph preset');
        count++;
        return { ...preset, values: copied };
    });
    return count ? { document: { ...doc, settings: { ...settings, presets } }, count } : null;
};

/**
 * Constructs a reversible atomic change set. This does not persist or mutate anything.
 * Source material, referenced materials, models, objects and metadata are all included.
 */
export const planTextureParameterRename = (input: TextureParameterRenameInput): TextureParameterRenamePlan => {
    const { materials, models, objects, metadata, sourceMaterialId, from, to } = input;
    if (!sourceMaterialId || !from || !to || from === to) throw new Error('Choose an existing parameter and a different valid name.');
    const source = materials.find((material) => material.id === sourceMaterialId);
    if (!source?.textureGraph) throw new Error('The material with the texture graph was not found.');
    if (materials.filter((candidate) => candidate.id === sourceMaterialId).length !== 1) throw new Error('Duplicate source material id.');
    const raw = record(source.textureGraph);
    const rawGraph = record(raw?.graph);
    if (!rawGraph || rawGraph.version !== 1) throw new Error('The source texture graph has an unsupported version.');
    const stored = readStoredGraph(source.textureGraph);
    if (!stored.graph.parameters.some((parameter) => parameter.name === from)) throw new Error(\`No parameter named "\${from}" exists in this graph.\`);
    const problem = formulaNameProblem(to, stored.graph.parameters, from);
    if (problem) throw new Error(problem);
    const renamed = renameParameter(stored.graph, stored.values, from, to);
    const first: MaterialAsset = {
        ...source,
        textureGraph: withParameterPictures({ ...stored, graph: renamed.graph, values: renamed.values }) as unknown as Record<string, unknown>,
    };
    const nextMaterials = new Map<string, MaterialAsset>([[source.id, first]]);
    const impact: RenameImpact = {
        sourceMaterialId, from, to, materials: [], models: [], objects: [], metadata: [],
        nestedNodes: 0, paintReferences: 0, modelOverrides: 0, objectOverrides: 0, sharedPresets: 0,
    };
    const put = (asset: MaterialAsset): void => { nextMaterials.set(asset.id, asset); };
    for (const material of materials) {
        const nested = renamedGraphUser(nextMaterials.get(material.id) ?? material, sourceMaterialId, from, to);
        if (nested) { put(nested.asset); impact.nestedNodes += nested.count; }
        const painted = renamedPaintUsers(nextMaterials.get(material.id) ?? material, sourceMaterialId, from, to);
        if (painted) { put(painted.asset); impact.paintReferences += painted.count; }
    }
    const changes: ProjectChange[] = [];
    const undoChanges: ProjectChange[] = [];
    const changedMaterials: MaterialAsset[] = [];
    const commit = (domain: string, id: string, before: unknown, after: unknown): void => {
        changes.push({ domain, operation: 'upsert', id, value: after });
        undoChanges.push({ domain, operation: 'upsert', id, value: before });
    };
    for (const material of materials) {
        const after = nextMaterials.get(material.id);
        if (!after) continue;
        impact.materials.push(material.id);
        changedMaterials.push(after);
        commit('materials', material.id, materialAssetDocument(material), materialAssetDocument(after));
    }
    const nextModels = new Map<string, ProjectModelForRename>();
    for (const model of models) {
        const changed = renamedOverrideSettings(model.materialOverrides,
            (_name, entry) => entry.materialId === sourceMaterialId, from, to, \`model \${model.id}\`);
        if (!changed.count) continue;
        const next = { ...model, materialOverrides: changed.value };
        nextModels.set(model.id, next);
        impact.models.push(model.id);
        impact.modelOverrides += changed.count;
        commit('models', model.id, model, next);
    }
    for (const object of objects) {
        const model = nextModels.get(object.modelId) ?? models.find((candidate) => candidate.id === object.modelId);
        const assigned = record(model?.materialOverrides);
        const changed = renamedOverrideSettings(object.materialOverrides,
            (name) => record(assigned?.[name])?.materialId === sourceMaterialId,
            from, to, \`object \${object.id}\`);
        if (!changed.count) continue;
        const next = { ...object, materialOverrides: changed.value };
        impact.objects.push(object.id);
        impact.objectOverrides += changed.count;
        commit('objects', object.id, object, next);
    }
    for (const doc of metadata) {
        const changed = renamedSharedPresets(doc, sourceMaterialId, from, to);
        if (!changed) continue;
        impact.metadata.push(doc.id);
        impact.sharedPresets += changed.count;
        commit('metadata', doc.id, doc, changed.document);
    }
    return { impact, changes, undoChanges, changedMaterials };
};
