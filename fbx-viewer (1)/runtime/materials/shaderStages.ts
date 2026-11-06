import * as THREE from 'three';

/**
 * SHADER STAGES OF A MATERIAL
 *
 * Several parts of the engine patch a lit material's shader, and each must keep the others' patches.
 * Each is a named stage, and a material's stages run in this fixed order inside one compile hook:
 *
 *   1. graph     a material graph shading it (runtime/materials/graphMaterial.ts): it replaces how
 *                the material reads its colour, opacity, roughness, metalness, normal, emission and
 *                occlusion, and offsets its vertices;
 *   2. normalRg  a two-channel (BC5) normal map rebuilding its third component
 *                (utils/textureCompression/compressTextures.ts);
 *   3. weather   rain and snow, and wind for foliage (runtime/weatherSurfaces.ts).
 *
 * They run after the hook the material has of its own (terrain's, water's), so each sees what came
 * before it: weather darkens and whitens whatever colour and roughness the graph worked out, and wind
 * moves the vertices where the graph's offset left them. A graph wiring its own normal leaves the
 * normal map's rebuild nothing to change, and one that does not wire it reads no normal map at all.
 * The program key joins the material's own key and each stage's, so programs are shared only by
 * materials patched alike.
 *
 * The uniforms trap: three keeps, for each material, the uniforms its last new program was built with,
 * and reuses them when the material goes back to a program it compiled before, without calling the hook
 * again. So a stage's uniforms are objects that live as long as the material and change only in value,
 * and every program the material compiles is handed all of them, including those of stages it no
 * longer has.
 */

export type ShaderStageName = 'graph' | 'normalRg' | 'weather';

/** The order a material's stages run in. */
export const SHADER_STAGE_ORDER: readonly ShaderStageName[] = ['graph', 'normalRg', 'weather'];

export interface ShaderStage {
    /** Changes the shader three is about to compile; `renderer` is null when a renderer of another kind asks for the uniforms. */
    patch(shader: THREE.WebGLProgramParametersWithUniforms, renderer: THREE.WebGLRenderer | null): void;
    /** What the patched program depends on, for the program key. */
    key(): string;
    /** The uniform objects the stage's programs read: the same objects for as long as the material lives. */
    uniforms?(): Record<string, THREE.IUniform>;
}

type CompileHook = THREE.Material['onBeforeCompile'];

interface Composition {
    readonly stages: Map<ShaderStageName, ShaderStage>;
    /** The uniforms of every stage the material has had, handed to each program it compiles (the trap above). */
    readonly uniforms: Map<ShaderStageName, () => Record<string, THREE.IUniform>>;
    /** The hook and key the material has of its own; the key null where three's own applies. */
    ownHook: CompileHook;
    ownKey: (() => string) | null;
    readonly hook: CompileHook;
    readonly key: () => string;
    /** True while the hook runs, so a hook of its own that calls back into it does not run the stages twice. */
    running: boolean;
}

const compositions = new WeakMap<THREE.Material, Composition>();

const DEFAULT_HOOK: CompileHook = THREE.Material.prototype.onBeforeCompile;

const ownKeyOf = (material: THREE.Material): (() => string) | null =>
    Object.prototype.hasOwnProperty.call(material, 'customProgramCacheKey') ? material.customProgramCacheKey : null;

const compose = (material: THREE.Material): Composition => {
    let composition = compositions.get(material);
    if (!composition) {
        const made: Composition = {
            stages: new Map(),
            uniforms: new Map(),
            ownHook: material.onBeforeCompile,
            ownKey: ownKeyOf(material),
            hook: (shader, renderer) => {
                if (made.running) return;
                made.running = true;
                try {
                    for (const provide of made.uniforms.values()) Object.assign(shader.uniforms, provide());
                    made.ownHook.call(material, shader, renderer);
                    for (const name of SHADER_STAGE_ORDER) made.stages.get(name)?.patch(shader, renderer);
                } finally {
                    made.running = false;
                }
            },
            key: () => {
                const own = made.ownKey ? made.ownKey.call(material) : made.ownHook.toString();
                const stages = SHADER_STAGE_ORDER.flatMap((name) => {
                    const stage = made.stages.get(name);
                    return stage ? [stage.key()] : [];
                });
                return stages.length ? `${own}|${stages.join('|')}` : own;
            },
            running: false,
        };
        composition = made;
        compositions.set(material, made);
    } else {
        // A hook or key set since the stages were put in place is the material's own now: the stages run after it.
        if (material.onBeforeCompile !== composition.hook) composition.ownHook = material.onBeforeCompile;
        if (material.customProgramCacheKey !== composition.key) composition.ownKey = ownKeyOf(material);
    }
    material.onBeforeCompile = composition.hook;
    material.customProgramCacheKey = composition.key;
    return composition;
};

/** Puts a stage on a material, or with null takes it off; the material compiles again. */
export const setShaderStage = (material: THREE.Material, name: ShaderStageName, stage: ShaderStage | null): void => {
    if (!stage && !compositions.get(material)?.stages.has(name)) return;
    const composition = compose(material);
    if (stage) {
        composition.stages.set(name, stage);
        if (stage.uniforms) composition.uniforms.set(name, stage.uniforms.bind(stage));
    } else {
        composition.stages.delete(name);
    }
    material.needsUpdate = true;
};

/** Whether a material has a stage. */
export const hasShaderStage = (material: THREE.Material, name: ShaderStageName): boolean =>
    compositions.get(material)?.stages.has(name) === true && material.onBeforeCompile === compositions.get(material)?.hook;

/** A material's stages, in the order they run. */
export const shaderStageNames = (material: THREE.Material): ShaderStageName[] => {
    const composition = compositions.get(material);
    if (!composition || material.onBeforeCompile !== composition.hook) return [];
    return SHADER_STAGE_ORDER.filter((name) => composition.stages.has(name));
};

/** The compile hook a material has of its own, apart from its stages: three's empty one when it has none. */
export const ownCompileHook = (material: THREE.Material): CompileHook => {
    const composition = compositions.get(material);
    return composition && material.onBeforeCompile === composition.hook ? composition.ownHook : material.onBeforeCompile;
};

/** Whether a material patches its shader in a way of its own (terrain, water), apart from the stages above. */
export const hasOwnCompileHook = (material: THREE.Material): boolean => ownCompileHook(material) !== DEFAULT_HOOK;
