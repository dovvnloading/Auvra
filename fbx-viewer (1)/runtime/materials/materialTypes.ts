/**
 * Types shared by the material graph's node definitions (materialNodes.ts), its compiler
 * (materialGraph.ts) and the material binding (graphMaterial.ts).
 */

export type MaterialValueType = 'float' | 'vec2' | 'vec3' | 'vec4';

/**
 * A port's type. 'auto' ports take the widest type wired into the node's auto inputs (float when
 * none is), so an Add of two colours gives a colour and an Add of two numbers a number.
 */
export type MaterialPortType = MaterialValueType | 'auto';

/**
 * Where a graph runs: the surface's pixels, its vertices (World Position Offset), or the pixels
 * of its shadow (a masked material's cut-out).
 */
export type MaterialStage = 'fragment' | 'vertex' | 'shadow';

/**
 * Values a graph reads from the mesh and the camera. Each stage computes them its own way (a
 * varying in the fragment shader, an attribute in the vertex shader).
 */
export type MaterialBuiltin =
    | 'uv'
    | 'worldPosition'
    | 'localPosition'
    | 'objectPosition'
    | 'worldNormal'
    | 'localNormal'
    | 'viewDirection'
    | 'cameraPosition'
    | 'cameraDistance'
    | 'vertexColor'
    | 'time';

export const BUILTIN_TYPES: Record<MaterialBuiltin, MaterialValueType> = {
    uv: 'vec2',
    worldPosition: 'vec3',
    localPosition: 'vec3',
    objectPosition: 'vec3',
    worldNormal: 'vec3',
    localNormal: 'vec3',
    viewDirection: 'vec3',
    cameraPosition: 'vec3',
    cameraDistance: 'float',
    vertexColor: 'vec3',
    time: 'float',
};

/**
 * float, color, vec2, vec3, texture and ramp params are uniforms (changing them keeps the shader);
 * select, boolean and code params are written into the shader (changing them rebuilds it).
 */
export type MaterialParamKind = 'float' | 'color' | 'vec2' | 'vec3' | 'texture' | 'ramp' | 'select' | 'boolean' | 'code';

export const STATIC_PARAM_KINDS: ReadonlySet<MaterialParamKind> = new Set(['select', 'boolean', 'code']);

/** A colour ramp: stops by position (0 to 1), colours in sRGB. */
export interface MaterialRamp {
    stops: Array<{ position: number; color: number[] }>;
}

/** Stops a ramp holds at most (the uniform array's length). */
export const MAX_RAMP_STOPS = 8;

export type MaterialParamValue = number | number[] | string | boolean | MaterialRamp;

export interface MaterialParamDef {
    key: string;
    label: string;
    kind: MaterialParamKind;
    default: MaterialParamValue;
    min?: number;
    max?: number;
    step?: number;
    /** A select's choices. */
    options?: ReadonlyArray<{ value: string; label: string }>;
}

export interface MaterialPortDef {
    key: string;
    label: string;
    type: MaterialPortType;
}

/**
 * The value an unconnected input takes: GLSL of the input's type, one of the node's params, a
 * number (splatted to an auto input's type), or a builtin (as the stage computes it).
 */
export type MaterialInputFallback = string | { param: string } | { value: number } | { builtin: MaterialBuiltin };

export interface MaterialInputDef extends MaterialPortDef {
    fallback: MaterialInputFallback;
}

/** What a node definition sees while it is compiled. */
export interface NodeEmitContext {
    readonly stage: MaterialStage;
    /** The GLSL type of the node's auto ports. */
    readonly auto: MaterialValueType;
    /** True where screen-space derivatives (dFdx, dFdy, fwidth) exist: the surface's pixels. */
    readonly derivatives: boolean;
    /** The uniform holding this node's param `key` (a uniform kind). */
    param(key: string): string;
    /** The value of a static (select, boolean or code) param, written into the shader. */
    static(key: string): unknown;
    /** A GLSL name unique to this node, for statements that need one. */
    local(name: string): string;
    /** The stage's expression for a builtin. */
    builtin(name: MaterialBuiltin): string;
    /** Makes a helper function of materialGlsl.ts available. */
    helper(name: string): void;
    /** Adds GLSL at the top level of the shader (a function of this node's own). */
    global(source: string): void;
    /** `value` as the node's auto type. */
    splat(value: string | number): string;
}

export type MaterialNodeCategory =
    | 'Output'
    | 'Input'
    | 'Geometry'
    | 'UV'
    | 'Texture'
    | 'Procedural'
    | 'Color'
    | 'Math'
    | 'Vector'
    | 'Logic'
    | 'Custom'
    | 'Utility';

export interface MaterialNodeDef {
    type: string;
    label: string;
    category: MaterialNodeCategory;
    description: string;
    /** Other words the node palette finds it by. */
    keywords?: readonly string[];
    /** How the editor shows the node's value: as it is, or as a tangent-space normal (encoded like a normal map). */
    preview?: 'value' | 'normal';
    inputs: MaterialInputDef[];
    outputs: MaterialPortDef[];
    params: MaterialParamDef[];
    /** The auto type from the node's own static params (a Swizzle's mask), instead of its inputs. */
    autoType?: (statics: Readonly<Record<string, unknown>>) => MaterialValueType;
    /**
     * GLSL statements computing the outputs, given each input as an expression of its type;
     * returns each output as an expression (of its type) the statements made available.
     */
    emit(inputs: Record<string, string>, context: NodeEmitContext): { statements?: string[]; outputs: Record<string, string> };
}
