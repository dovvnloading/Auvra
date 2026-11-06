import * as THREE from 'three';
import { materialLibrary, type MaterialBinding } from '../runtime/materials/materialLibrary';
import {
    materialGraphParameters,
    materialShaderVersions,
    readParam,
    type MaterialParameterValue,
    type MaterialParameterValues,
} from '../runtime/materials/materialGraph';
import { isWeatherPatched, patchWeatherMaterial } from '../runtime/weatherSurfaces';
import { materialParameterValues, normalizeMaterialOverrides, type MaterialOverrides, type MaterialParameterSetting } from './materialOverrides';

/**
 * MATERIAL INSTANCES
 *
 * A material asset's graph can leave values to each use of it (its parameters: numbers, colours,
 * textures and switches). A model's Material Overrides set them for the model and every copy of it; a
 * placed object can set its own on top, for that object alone. Such an object is drawn on its own (not
 * in an instanced layer), its meshes wearing instances of the model's materials: copies bound to the same
 * asset with the merged values. Objects asking for the same values share one instance, and values and
 * textures change only what its shader is given; each choice of a switch is a shader version of its own.
 *
 * A play session can also set values on one object (the blueprint's Set Material Number and Set
 * Material Colour): that object then gets copies of its own for the session.
 */

/** A placed object's own parameter values for its model's materials, by material name. */
export type ObjectMaterialOverrides = Record<string, { parameters?: MaterialParameterSetting[] }>;

/** A stored object's material values made safe (entries without parameters dropped); undefined when none remain. */
export const normalizeObjectMaterialOverrides = (value: unknown): ObjectMaterialOverrides | undefined => {
    const result: ObjectMaterialOverrides = {};
    for (const [name, entry] of Object.entries(normalizeMaterialOverrides(value))) {
        if (entry.parameters?.length) result[name] = { parameters: entry.parameters };
    }
    return Object.keys(result).length ? result : undefined;
};

/** Whether a placed object sets any material value of its own (and so is drawn on its own). */
export const hasObjectMaterialValues = (object: { materialOverrides?: ObjectMaterialOverrides }): boolean =>
    Object.values(object.materialOverrides ?? {}).some(entry => (entry?.parameters?.length ?? 0) > 0);

/** The object's values set on one material's, with the parameters it leaves alone kept as they were. */
export const withObjectParameters = (
    overrides: ObjectMaterialOverrides | undefined,
    materialName: string,
    parameters: MaterialParameterSetting[] | undefined,
): ObjectMaterialOverrides | undefined => {
    const next: ObjectMaterialOverrides = { ...(overrides ?? {}) };
    if (parameters?.length) next[materialName] = { parameters };
    else delete next[materialName];
    return Object.keys(next).length ? next : undefined;
};

/** The values a material of a placed object is drawn with: its model's, then the object's own. */
export const mergedParameterValues = (
    model: MaterialParameterValues | undefined,
    object: MaterialParameterSetting[] | undefined,
): MaterialParameterValues | undefined => {
    const own = materialParameterValues(object);
    if (!own) return model;
    return { ...(model ?? {}), ...own };
};

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

interface Instance {
    material: THREE.Material;
    source: THREE.Material;
    key: string;
    users: number;
}

const instancesBySource = new WeakMap<THREE.Material, Map<string, Instance>>();
const instanceRecords = new WeakMap<THREE.Material, Instance>();

const valuesKey = (values: MaterialParameterValues | undefined): string =>
    JSON.stringify(Object.entries(values ?? {}).sort(([a], [b]) => a.localeCompare(b)));

/** A copy of `source` shaded by `binding`'s asset with `values`, patched for the weather as the source is. */
const makeInstance = (source: THREE.Material, binding: Readonly<MaterialBinding>, values: MaterialParameterValues | undefined): THREE.Material => {
    const material = source.clone();
    materialLibrary.assign(material, binding.materialId, binding.flipY, values);
    if (isWeatherPatched(source)) patchWeatherMaterial(material);
    return material;
};

/**
 * An instance of `source` (a material bound to an asset) drawn with `values` for the asset's parameters,
 * shared by every caller asking for the same; give it back with releaseMaterialInstance. `source` itself
 * when it is not bound to an asset.
 */
export const acquireMaterialInstance = (source: THREE.Material, values: MaterialParameterValues): THREE.Material => {
    const binding = materialLibrary.bindingOf(source);
    if (!binding) return source;
    const merged = { ...(binding.parameters ?? {}), ...values };
    const key = `${binding.materialId}|${binding.flipY}|${valuesKey(merged)}`;
    let byKey = instancesBySource.get(source);
    if (!byKey) instancesBySource.set(source, byKey = new Map());
    let instance = byKey.get(key);
    if (!instance) {
        instance = { material: makeInstance(source, binding, merged), source, key, users: 0 };
        byKey.set(key, instance);
        instanceRecords.set(instance.material, instance);
    }
    instance.users += 1;
    return instance.material;
};

/** Gives back an instance from acquireMaterialInstance; the last user's release frees it. */
export const releaseMaterialInstance = (material: THREE.Material): void => {
    const instance = instanceRecords.get(material);
    if (!instance) return;
    instance.users -= 1;
    if (instance.users > 0) return;
    instancesBySource.get(instance.source)?.delete(instance.key);
    instanceRecords.delete(material);
    materialLibrary.assign(material, null);
    material.dispose();
};

/** Whether a material is an instance made here (tests, and what must not be swapped twice). */
export const isMaterialInstance = (material: THREE.Material): boolean => instanceRecords.has(material);

/** Meshes under `root` that belong to it, not to a nested object with a level id of its own. */
const ownMeshes = (root: THREE.Object3D): THREE.Mesh[] => {
    const ownId = root.userData?.levelObjectId;
    const meshes: THREE.Mesh[] = [];
    const stack = [root];
    while (stack.length) {
        const node = stack.pop()!;
        const nodeId = node.userData?.levelObjectId;
        if (node !== root && typeof nodeId === 'string' && ownId !== undefined && nodeId !== ownId) continue;
        if ((node as THREE.Mesh).isMesh) meshes.push(node as THREE.Mesh);
        stack.push(...node.children);
    }
    return meshes;
};

const materialsOf = (mesh: THREE.Mesh): THREE.Material[] => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]);

const setMaterials = (mesh: THREE.Mesh, materials: THREE.Material[]): void => {
    mesh.material = Array.isArray(mesh.material) ? materials : materials[0];
};

/**
 * Dresses the meshes under `root` (a placed object's copy of its model, sharing the model's materials) in
 * instances carrying the object's own values; returns what undoes it (the model's materials back, the
 * instances given back).
 */
export const applyMaterialInstances = (root: THREE.Object3D, overrides: ObjectMaterialOverrides | undefined): (() => void) => {
    if (!hasObjectMaterialValues({ materialOverrides: overrides })) return () => undefined;
    const swapped: Array<[THREE.Mesh, THREE.Material | THREE.Material[]]> = [];
    const acquired: THREE.Material[] = [];
    for (const mesh of ownMeshes(root)) {
        let changed = false;
        const materials = materialsOf(mesh).map((material) => {
            const own = material && overrides?.[material.name]?.parameters;
            const values = own?.length ? materialParameterValues(own) : undefined;
            if (!values || !materialLibrary.bindingOf(material)) return material;
            const instance = acquireMaterialInstance(material, values);
            acquired.push(instance);
            changed = true;
            return instance;
        });
        if (!changed) continue;
        swapped.push([mesh, mesh.material]);
        setMaterials(mesh, materials);
    }
    return () => {
        for (const [mesh, material] of swapped) mesh.material = material;
        for (const instance of acquired) releaseMaterialInstance(instance);
    };
};

// ---------------------------------------------------------------------------
// Values set while a game plays
// ---------------------------------------------------------------------------

/** Session copies by the mesh slot they were made for, so each object's values stay its own. */
const sessionCopies = new WeakMap<THREE.Material, THREE.Mesh>();

/** `value` as the parameter's kind takes it: a number, a colour or vector, or a switch's choice (any number but 0 is on). */
const valueForParameter = (kind: string, value: number | number[]): MaterialParameterValue | undefined => {
    const numbers = Array.isArray(value) ? value : [value, value, value, value];
    switch (kind) {
        case 'float': return numbers[0];
        case 'boolean': return numbers[0] !== 0;
        case 'vec2': return numbers.slice(0, 2);
        case 'color':
        case 'vec3': return [numbers[0], numbers[1] ?? numbers[0], numbers[2] ?? numbers[0]];
        default: return undefined;
    }
};

/**
 * Sets the value named `name` on every material of the object under `root` whose asset leaves it to its
 * uses, for this object alone while the game plays: each such material is first copied for this mesh
 * (copies are listed in `made`, for the session to free). Returns how many materials took it.
 */
export const setObjectMaterialValue = (root: THREE.Object3D, name: string, value: number | number[], made: THREE.Material[]): number => {
    let changed = 0;
    for (const mesh of ownMeshes(root)) {
        let swapped = false;
        const materials = materialsOf(mesh).map((material) => {
            const binding = material ? materialLibrary.bindingOf(material) : undefined;
            const asset = binding ? materialLibrary.get(binding.materialId) : undefined;
            const parameter = asset ? materialGraphParameters(asset.graph).find(candidate => candidate.name === name) : undefined;
            const taken = parameter ? valueForParameter(parameter.param.kind, value) : undefined;
            if (!binding || !parameter || taken === undefined) return material;
            let own = material;
            if (sessionCopies.get(material) !== mesh) {
                own = makeInstance(material, binding, binding.parameters);
                sessionCopies.set(own, mesh);
                made.push(own);
                swapped = true;
            }
            const current = materialLibrary.bindingOf(own) ?? binding;
            materialLibrary.assign(own, current.materialId, current.flipY, { ...(current.parameters ?? {}), [name]: readParam(parameter.param, taken) as MaterialParameterValue });
            changed += 1;
            return own;
        });
        if (swapped) setMaterials(mesh, materials);
    }
    return changed;
};

/** Frees the copies a play session made (setObjectMaterialValue). */
export const releaseSessionMaterials = (made: THREE.Material[]): void => {
    for (const material of made.splice(0)) {
        materialLibrary.assign(material, null);
        material.dispose();
    }
};

// ---------------------------------------------------------------------------
// Shader versions
// ---------------------------------------------------------------------------

interface ModelUse { id: string; materialOverrides?: MaterialOverrides }
interface ObjectUse { modelId: string; materialOverrides?: ObjectMaterialOverrides }

/**
 * How many shader versions a material asset builds for its uses: each model material it shades, and each
 * placed copy of those models with values of its own. One per different choice of the graph's switches.
 */
export const assetShaderVersions = (assetId: string, models: readonly ModelUse[], objects: readonly ObjectUse[]): number => {
    const asset = materialLibrary.get(assetId);
    if (!asset) return 1;
    const uses: Array<MaterialParameterValues | undefined> = [];
    for (const model of models) {
        for (const [name, override] of Object.entries(model.materialOverrides ?? {})) {
            if (override.materialId !== assetId) continue;
            const own = materialParameterValues(override.parameters);
            uses.push(own);
            for (const object of objects) {
                if (object.modelId !== model.id) continue;
                const values = object.materialOverrides?.[name]?.parameters;
                if (values?.length) uses.push(mergedParameterValues(own, values));
            }
        }
    }
    return materialShaderVersions(asset.graph, uses.length ? uses : [undefined]);
};
