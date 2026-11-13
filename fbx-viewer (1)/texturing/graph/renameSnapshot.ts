import { readMaterialAsset, type MaterialAsset } from '../../runtime/materials/materialLibrary';
import type { ProjectSnapshot } from '../../utils/projectService';
import type { ProjectMetadataForRename, ProjectModelForRename, ProjectObjectForRename, ProjectPrefabForRename } from './renameProjectParameter';

/**
 * A rename preflight must use a COMPLETE, single-revision host inventory. The
 * material library is used for immediate editor previews, but it is not a
 * substitute for the documents saved in the active project.
 *
 * Fail closed rather than silently filtering malformed records: a hidden
 * dependent is worse than a refused rename.
 */
export interface TextureRenameInventory {
    materials: readonly MaterialAsset[];
    models: ProjectModelForRename[];
    objects: ProjectObjectForRename[];
    prefabs: ProjectPrefabForRename[];
    metadata: ProjectMetadataForRename[];
}

const record = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

const validateOverrides = (overrides: unknown, owner: string): void => {
    if (overrides === undefined) return;
    const slots = record(overrides);
    if (!slots) throw new Error(`${owner} has unreadable material overrides. Nothing was renamed.`);
    for (const [name, slot] of Object.entries(slots)) {
        const entry = record(slot);
        if (!entry || (entry.materialId !== undefined && typeof entry.materialId !== 'string')) {
            throw new Error(`${owner} has an unreadable material assignment for "${name}". Nothing was renamed.`);
        }
        if (entry.parameters !== undefined && (!Array.isArray(entry.parameters)
            || entry.parameters.some(parameter => typeof record(parameter)?.name !== 'string'))) {
            throw new Error(`${owner} has unreadable parameters for "${name}". Nothing was renamed.`);
        }
    }
};

/** Ignore object property insertion order, not array order, when comparing saved and live material documents. */
const signature = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => {
    const object = record(item);
    return object ? Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b))) : item;
});

const records = (documents: unknown, name: string): Array<Record<string, unknown> & { id: string }> => {
    if (!Array.isArray(documents)) {
        throw new Error(`The project rename inventory is missing the complete "${name}" domain. Nothing was renamed.`);
    }
    const ids = new Set<string>();
    return documents.map((candidate, index) => {
        const value = record(candidate);
        if (!value || typeof value.id !== 'string' || !value.id) {
            throw new Error(`The project rename inventory has an invalid "${name}" record at position ${index}. Nothing was renamed.`);
        }
        if (ids.has(value.id)) {
            throw new Error(`The project rename inventory contains duplicate "${name}" id "${value.id}". Nothing was renamed.`);
        }
        ids.add(value.id);
        return value as Record<string, unknown> & { id: string };
    });
};

const validateMaterial = (document: Record<string, unknown> & { id: string }): MaterialAsset => {
    if (!record(document.graph)) {
        throw new Error(`Saved material "${document.id}" has an unreadable shader graph. Nothing was renamed.`);
    }
    if (document.textureGraph !== undefined) {
        const stored = record(document.textureGraph);
        if (!stored || record(stored.graph)?.version !== 1) {
            throw new Error(`Saved material "${document.id}" has an unsupported texture graph. Nothing was renamed.`);
        }
    }
    if (document.paint !== undefined) {
        const paint = record(document.paint);
        // The Paint workspace also stores smart materials and export templates as
        // standalone library assets. Only painted sets have a top-level layer stack.
        const libraryAsset = paint && (paint.smartMaterial !== undefined || paint.exportTemplates !== undefined)
            && Object.keys(paint).every(key => key === 'smartMaterial' || key === 'exportTemplates');
        const smart = record(paint?.smartMaterial);
        if (!paint || (paint.version !== undefined && paint.version !== 1)
            || (!Array.isArray(paint.layers) && !libraryAsset)
            || (paint.exportTemplates !== undefined && !Array.isArray(paint.exportTemplates))
            || (paint.smartMaterial !== undefined && (smart?.version !== 1 || !record(smart.layer)))) {
            throw new Error(`Saved material "${document.id}" has an unsupported paint document. Nothing was renamed.`);
        }
    }
    const material = readMaterialAsset(document);
    if (!material) throw new Error(`Saved material "${document.id}" could not be read. Nothing was renamed.`);
    return material;
};

/**
 * Validates all reference-bearing host domains, including empty ones,
 * and makes sure no unsaved/late material-library changes can be omitted from
 * the decision to permit an otherwise graph-local rename.
 */
export const readTextureRenameInventory = (
    snapshot: ProjectSnapshot | null,
    liveMaterials: readonly MaterialAsset[],
    expected: { projectId: string; revision: number },
): TextureRenameInventory => {
    if (!snapshot || !expected.projectId || snapshot.projectId !== expected.projectId
        || !Number.isSafeInteger(expected.revision) || snapshot.revision !== expected.revision || snapshot.hasMore) {
        throw new Error('The project changed while collecting rename references. Nothing was renamed; reload and try again.');
    }
    const domains = record(snapshot.domains);
    if (!domains) throw new Error('The complete project reference inventory could not be loaded. Nothing was renamed.');

    const savedMaterialDocs = records(domains.materials, 'materials');
    const models = records(domains.models, 'models');
    const objects = modelObjects(records(domains.objects, 'objects'), 'Object');
    const prefabs = records(domains.prefabs, 'prefabs').map(prefab => ({
        id: prefab.id,
        objects: modelObjects(records(prefab.objects, `objects in prefab "${prefab.id}"`), `Prefab "${prefab.id}" object`),
    }));
    const metadata = records(domains.metadata, 'metadata');

    for (const model of models) {
        validateOverrides(model.materialOverrides, `Model "${model.id}"`);
    }
    for (const doc of metadata) {
        if (doc.id !== 'texture-graph-presets') continue;
        const settings = record(doc.settings);
        if (!settings || settings.version !== 1 || !Array.isArray(settings.presets)) {
            throw new Error('Project-shared graph presets have an unsupported schema. Nothing was renamed.');
        }
    }

    const savedMaterials = savedMaterialDocs.map(validateMaterial);
    const live = new Map<string, MaterialAsset>();
    for (const material of liveMaterials) {
        if (!material.id || live.has(material.id)) {
            throw new Error('The editor material library has missing or duplicate asset identities. Nothing was renamed.');
        }
        live.set(material.id, material);
    }
    if (live.size !== savedMaterials.length) {
        throw new Error('The editor material library does not match the saved project. Finish pending saves or reload before renaming.');
    }
    for (const saved of savedMaterials) {
        const material = live.get(saved.id);
        // textureIds is a derived index whose order can change when the host sorts JSON keys.
        if (!material || signature(material) !== signature(saved)) {
            throw new Error(`Material "${saved.id}" differs from the saved project. Finish pending saves or reload before renaming.`);
        }
    }
    return { materials: liveMaterials, models, objects, prefabs, metadata };
};

/** Placed objects and prefab members use the same model-slot override schema. */
const modelObjects = (documents: Array<Record<string, unknown> & { id: string }>, label: string): ProjectObjectForRename[] => {
    const objects: ProjectObjectForRename[] = [];
    for (const object of documents) {
        const owner = `${label} "${object.id}"`;
        validateOverrides(object.materialOverrides, owner);
        if (typeof object.modelId === 'string' && object.modelId) {
            objects.push({ ...object, modelId: object.modelId });
        } else if (Object.keys(record(object.materialOverrides) ?? {}).length) {
            throw new Error(`${owner} has material overrides but no model identity. Nothing was renamed.`);
        }
    }
    return objects;
};
