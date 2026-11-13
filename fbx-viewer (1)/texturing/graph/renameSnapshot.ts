import { materialAssetDocument, readMaterialAsset, type MaterialAsset } from '../../runtime/materials/materialLibrary';
import type { ProjectSnapshot } from '../../utils/projectService';
import type { ProjectMetadataForRename, ProjectModelForRename, ProjectObjectForRename } from './renameProjectParameter';

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
    metadata: ProjectMetadataForRename[];
}

const record = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Ignore object property insertion order, not array order, when comparing saved and live material documents. */
const signature = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => {
    const object = record(item);
    return object ? Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b))) : item;
});

const records = (domains: Record<string, unknown>, name: string): Array<Record<string, unknown> & { id: string }> => {
    if (!Object.hasOwn(domains, name) || !Array.isArray(domains[name])) {
        throw new Error(`The project rename inventory is missing the complete "${name}" domain. Nothing was renamed.`);
    }
    const ids = new Set<string>();
    return (domains[name] as unknown[]).map((candidate, index) => {
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
        if (!paint || (paint.version !== undefined && paint.version !== 1) || !Array.isArray(paint.layers)) {
            throw new Error(`Saved material "${document.id}" has an unsupported paint document. Nothing was renamed.`);
        }
    }
    const material = readMaterialAsset(document);
    if (!material) throw new Error(`Saved material "${document.id}" could not be read. Nothing was renamed.`);
    return material;
};

/**
 * Validates all four reference-bearing host domains, including empty ones,
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

    const savedMaterialDocs = records(domains, 'materials');
    const models = records(domains, 'models');
    const allObjects = records(domains, 'objects');
    const metadata = records(domains, 'metadata');

    for (const model of models) {
        if (model.materialOverrides !== undefined && !record(model.materialOverrides)) {
            throw new Error(`Model "${model.id}" has unreadable material overrides. Nothing was renamed.`);
        }
    }
    const objects: ProjectObjectForRename[] = [];
    for (const object of allObjects) {
        if (object.materialOverrides !== undefined && !record(object.materialOverrides)) {
            throw new Error(`Object "${object.id}" has unreadable material overrides. Nothing was renamed.`);
        }
        if (typeof object.modelId === 'string' && object.modelId) {
            objects.push(object as unknown as ProjectObjectForRename);
        } else if (record(object.materialOverrides) && Object.keys(object.materialOverrides as Record<string, unknown>).length) {
            throw new Error(`Object "${object.id}" has material overrides but no model identity. Nothing was renamed.`);
        }
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
        if (!material || signature(materialAssetDocument(material)) !== signature(materialAssetDocument(saved))) {
            throw new Error(`Material "${saved.id}" differs from the saved project. Finish pending saves or reload before renaming.`);
        }
    }
    return { materials: liveMaterials, models: models as ProjectModelForRename[], objects, metadata: metadata as ProjectMetadataForRename[] };
};
