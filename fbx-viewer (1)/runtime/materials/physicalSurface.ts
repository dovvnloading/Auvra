import * as THREE from 'three';
import type { PhysicalFeature } from './materialGraph';

/**
 * THE PHYSICAL SURFACE OF A GRAPH-SHADED MATERIAL
 *
 * A graph using any part of the physical surface (coat, sheen, thin film, transmission, anisotropy, or
 * specular values away from their defaults) is drawn by three's physical material; any other by the
 * standard one, which costs less.
 *
 * A model's material is shared by every placed copy of the model, so it cannot be swapped for another
 * object. It changes kind in place instead: a standard material a graph needs drawn as physical becomes
 * a physical material (its prototype, type and physical values), and becomes standard again once no graph
 * needs it to be. Everything that holds it (placed copies, overrides, weather, the compiled programs'
 * keys) follows, as the material is the same object.
 *
 * The graph's values reach the physical shader where three sets up its physical material: right after
 * that setup each part's values are set again from the graph, and transmission's chunk reads the graph
 * instead of three's uniforms. The parts in use are switched on through the material's own values (a coat
 * of 1, a sheen of 1...), as three switches its shader's parts on from them.
 */

/** The physical material value that switches each part on in three's shader. */
export const FEATURE_SWITCH_PROPERTY: Partial<Record<PhysicalFeature, 'clearcoat' | 'sheen' | 'iridescence' | 'transmission' | 'dispersion' | 'anisotropy'>> = {
    coat: 'clearcoat',
    sheen: 'sheen',
    thinFilm: 'iridescence',
    transmission: 'transmission',
    dispersion: 'dispersion',
    anisotropy: 'anisotropy',
};

type SwitchProperty = NonNullable<(typeof FEATURE_SWITCH_PROPERTY)[PhysicalFeature]>;

export const SWITCH_PROPERTIES: readonly SwitchProperty[] = ['clearcoat', 'sheen', 'iridescence', 'transmission', 'dispersion', 'anisotropy'];

/** Own properties a physical material has that a standard one does not, read once from fresh materials. */
const PHYSICAL_KEYS: readonly string[] = (() => {
    const standard = new Set(Object.keys(new THREE.MeshStandardMaterial()));
    return Object.keys(new THREE.MeshPhysicalMaterial()).filter(key => !standard.has(key));
})();

/** Materials made physical here, from standard, with the prototype each had. */
const upgraded = new WeakMap<THREE.Material, object>();

/** For a class built on the standard material, a physical prototype carrying its own methods too. */
const physicalPrototypes = new WeakMap<object, object>();

const physicalPrototypeFor = (standard: object): object => {
    if (standard === THREE.MeshStandardMaterial.prototype) return THREE.MeshPhysicalMaterial.prototype;
    let prototype = physicalPrototypes.get(standard);
    if (!prototype) {
        const { constructor: _constructor, ...methods } = Object.getOwnPropertyDescriptors(standard);
        prototype = Object.create(THREE.MeshPhysicalMaterial.prototype, methods) as object;
        physicalPrototypes.set(standard, prototype);
    }
    return prototype;
};

/** Whether a material is physical only because a graph needs it to be (it was imported as a standard one). */
export const isGraphUpgraded = (material: THREE.Material): boolean => upgraded.has(material);

/** Makes a standard material physical in place, with three's default physical values; its own values are kept. */
export const makePhysical = (material: THREE.MeshStandardMaterial): THREE.MeshPhysicalMaterial => {
    if ((material as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial) return material as THREE.MeshPhysicalMaterial;
    const template = new THREE.MeshPhysicalMaterial() as unknown as Record<string, unknown>;
    const target = material as unknown as Record<string, unknown>;
    for (const key of PHYSICAL_KEYS) target[key] = template[key];
    material.type = 'MeshPhysicalMaterial';
    material.defines = { ...(material.defines ?? {}), PHYSICAL: '' };
    const standard = Object.getPrototypeOf(material) as object;
    Object.setPrototypeOf(material, physicalPrototypeFor(standard));
    upgraded.set(material, standard);
    material.needsUpdate = true;
    return material as unknown as THREE.MeshPhysicalMaterial;
};

/** Makes a material this module made physical standard again, as it was imported. */
export const makeStandard = (material: THREE.MeshStandardMaterial): void => {
    const standard = upgraded.get(material);
    if (!standard) return;
    upgraded.delete(material);
    Object.setPrototypeOf(material, standard);
    const target = material as unknown as Record<string, unknown>;
    for (const key of PHYSICAL_KEYS) delete target[key];
    material.type = 'MeshStandardMaterial';
    if (material.defines) {
        const { PHYSICAL: _physical, ...rest } = material.defines;
        material.defines = rest;
    }
    material.needsUpdate = true;
};

/** A physical material's switching values, to give back when no graph shades it. */
export const switchValues = (material: THREE.Material): Partial<Record<SwitchProperty, number>> => {
    if (!(material as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial) return {};
    const physical = material as unknown as Record<SwitchProperty, number>;
    return Object.fromEntries(SWITCH_PROPERTIES.map(key => [key, physical[key]]));
};

/** Switches on the parts a graph uses and off the rest (1 or 0: the graph gives the values). */
export const switchFeatures = (material: THREE.MeshPhysicalMaterial, features: ReadonlySet<PhysicalFeature>): void => {
    const physical = material as unknown as Record<SwitchProperty, number>;
    for (const [feature, key] of Object.entries(FEATURE_SWITCH_PROPERTY) as Array<[PhysicalFeature, SwitchProperty]>) {
        physical[key] = features.has(feature) ? 1 : 0;
    }
};

/** Gives a physical material back its own switching values. */
export const restoreSwitches = (material: THREE.Material, values: Partial<Record<SwitchProperty, number>>): void => {
    if (!(material as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial) return;
    const physical = material as unknown as Record<SwitchProperty, number>;
    for (const key of SWITCH_PROPERTIES) if (values[key] !== undefined) physical[key] = values[key]!;
};

/**
 * GLSL setting three's physical material up again from the graph's values, right after three's own setup
 * (lights_physical_fragment). `outputs` are the graph's expressions by Material Output input.
 */
export const physicalOverrides = (outputs: Record<string, string>, features: ReadonlySet<PhysicalFeature>): string => {
    const parts = [
        // The graph's specular values, as three works them out from its own.
        `#ifdef IOR
    material.ior = clamp(${outputs.ior}, 1.0, 3.0);
    material.specularF90 = mix(clamp(${outputs.specularWeight}, 0.0, 1.0), 1.0, metalnessFactor);
    material.specularColor = mix(min(pow2((material.ior - 1.0) / (material.ior + 1.0)) * ${outputs.specularColor}, vec3(1.0)) * clamp(${outputs.specularWeight}, 0.0, 1.0), diffuseColor.rgb, metalnessFactor);
#endif`,
    ];
    if (features.has('coat')) {
        parts.push(`#ifdef USE_CLEARCOAT
    material.clearcoat = saturate(${outputs.coat});
    material.clearcoatRoughness = min(max(${outputs.coatRoughness}, 0.0525) + geometryRoughness, 1.0);
#endif`);
    }
    if (features.has('dispersion')) {
        parts.push(`#ifdef USE_DISPERSION
    material.dispersion = max(${outputs.dispersion}, 0.0);
#endif`);
    }
    if (features.has('thinFilm')) {
        parts.push(`#ifdef USE_IRIDESCENCE
    material.iridescence = saturate(${outputs.thinFilm});
    material.iridescenceThickness = max(${outputs.thinFilmThickness}, 0.0);
#endif`);
    }
    if (features.has('sheen')) {
        parts.push(`#ifdef USE_SHEEN
    material.sheenColor = max(${outputs.sheenColor}, vec3(0.0));
    material.sheenRoughness = clamp(${outputs.sheenRoughness}, 0.07, 1.0);
#endif`);
    }
    if (features.has('anisotropy')) {
        parts.push(`#ifdef USE_ANISOTROPY
{
    float mgAnisotropyAngle = radians(${outputs.anisotropyRotation});
    vec2 mgAnisotropy = saturate(${outputs.anisotropy}) * vec2(cos(mgAnisotropyAngle), sin(mgAnisotropyAngle));
    material.anisotropy = length(mgAnisotropy);
    vec2 mgAnisotropyDirection = material.anisotropy == 0.0 ? vec2(1.0, 0.0) : mgAnisotropy / material.anisotropy;
    material.alphaT = mix(pow2(material.roughness), 1.0, pow2(material.anisotropy));
    material.anisotropyT = tbn[0] * mgAnisotropyDirection.x + tbn[1] * mgAnisotropyDirection.y;
    material.anisotropyB = tbn[1] * mgAnisotropyDirection.x - tbn[0] * mgAnisotropyDirection.y;
}
#endif`);
    }
    return `// The graph's physical surface.\n${parts.join('\n')}`;
};

const replaceOnce = (source: string, find: string, replacement: string): string => {
    if (!source.includes(find)) throw new Error(`The physical shader has no "${find}" to replace.`);
    return source.replace(find, replacement);
};

/** Three's transmission chunk, reading the graph's transmission, thickness and absorption. */
export const graphTransmission = (outputs: Record<string, string>): string => {
    let chunk = THREE.ShaderChunk.transmission_fragment;
    chunk = replaceOnce(chunk, 'material.transmission = transmission;', `material.transmission = saturate(${outputs.transmission});`);
    chunk = replaceOnce(chunk, 'material.thickness = thickness;', `material.thickness = max(${outputs.thickness}, 0.0);`);
    chunk = replaceOnce(chunk, 'material.attenuationDistance = attenuationDistance;', `material.attenuationDistance = max(${outputs.attenuationDistance}, 1e-4);`);
    chunk = replaceOnce(chunk, 'material.attenuationColor = attenuationColor;', `material.attenuationColor = ${outputs.attenuationColor};`);
    return chunk;
};

/** The coat's own normal from the graph (tangent space), in place of three's coat normal map. */
export const graphCoatNormal = (normal: string): string => `#ifdef USE_CLEARCOAT
{
    mat3 mgCoatFrame = mgTangentFrame(-vViewPosition, clearcoatNormal, vUv);
    clearcoatNormal = normalize(mgCoatFrame * normalize(${normal}));
}
#endif`;
