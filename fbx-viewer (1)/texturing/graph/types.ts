import type * as THREE from 'three';
import type { GpuImage, ImagePrecision, PassOptions, TextureGpu } from '../gpu/textureGpu';
import type { MaterialImages } from './material';

/**
 * TEXTURE GRAPHS: TYPES
 *
 * A texture graph makes images, not shaders: each node draws one or more full images on the GPU
 * from its inputs and settings, so a node can look at any pixel of its inputs (blurs, distance,
 * flood fill, warps) as well as its own. Images are colour (RGBA) or grey (one channel); a grey
 * image wired into a colour input reads as grey colour, a colour image wired into a grey input
 * reads as its brightness.
 */

export type PortKind = 'color' | 'gray';

/** Which ways an image repeats seamlessly: both, across only, down only, or not at all. */
export type TilingMode = 'none' | 'horizontal' | 'vertical' | 'both';

/** What an input nothing is wired to reads. */
export type InputFallback = 'white' | 'black' | 'mid' | 'normal' | 'clear';

/**
 * What a pin carries: one image (colour or grey; 'any' either), or a whole material, one wire carrying
 * every surface channel (base colour, normal, roughness...).
 */
export type PinKind = PortKind | 'any' | 'material';

export interface TexPortDef {
    key: string;
    label: string;
    /** 'any' takes either kind; an 'any' output is the kind of the node's `kindFrom` input. */
    kind: PinKind;
    /** An image input that also takes a material wire, keeping one channel of it (an Output's). */
    material?: boolean;
    /** Not shown on the canvas: a named link's wire runs to it instead. */
    hidden?: boolean;
    fallback?: InputFallback;
    /** A heading the canvas lists the port under, for nodes with many ports. */
    group?: string;
}

export type TexParamKind = 'float' | 'int' | 'bool' | 'color' | 'vec2' | 'select' | 'ramp' | 'curve' | 'texture' | 'string' | 'code' | 'graph';

export interface RampStop { position: number; color: [number, number, number, number] }
export interface CurvePoint { x: number; y: number }
/** A curve per channel: the master curve applies to all, then each channel's own. */
export interface CurveSet { all: CurvePoint[]; r: CurvePoint[]; g: CurvePoint[]; b: CurvePoint[]; a: CurvePoint[] }

export interface TexParamDef {
    key: string;
    label: string;
    kind: TexParamKind;
    default: unknown;
    min?: number;
    max?: number;
    /** A slider's end; typing can go past it up to `max`. */
    softMax?: number;
    step?: number;
    options?: ReadonlyArray<{ value: string; label: string }>;
    hint?: string;
    /** Shown only while this holds for the node's other settings. */
    showIf?: (params: Readonly<Record<string, unknown>>) => boolean;
}

/** A node setting following the graph's parameters: one of them as it is, or a formula of them. */
export type ParamLink = { $bind: string } | { $expr: string };

export const isParamLink = (value: unknown): value is ParamLink =>
    !!value && typeof value === 'object' && !Array.isArray(value) && (typeof (value as { $bind?: unknown }).$bind === 'string' || typeof (value as { $expr?: unknown }).$expr === 'string');

/**
 * A node's size: 'input' follows its first wired input (else the graph), 'graph' follows the
 * graph's size, each scaled by powers of two; 'absolute' is a power of two of its own.
 */
export interface NodeSize {
    mode: 'input' | 'graph' | 'absolute';
    /** Powers of two: an offset for the relative modes, the size's own for 'absolute'. */
    w: number;
    h: number;
}

export interface TexGraphNode {
    id: string;
    type: string;
    x: number;
    y: number;
    params: Record<string, unknown>;
    size?: NodeSize;
    /** Bits a channel the node's images keep; 'auto' takes its inputs' (8 for colour, 16 for grey when it makes them), 'graph' the graph's. */
    precision?: 'auto' | 'graph' | 8 | 16 | 32;
    /** Which ways it tiles: its input's, the graph's, or fixed (generators take the graph's unless set, filters their input's). */
    tiling?: 'input' | 'graph' | TilingMode;
    /** Where its seed comes from besides its own: the graph's (unless set), its input's, or nowhere (fixed). */
    seedFrom?: 'input' | 'fixed';
    /** A name of the user's own, shown instead of the node's kind. */
    name?: string;
    /** Its header's colour (#rrggbb), instead of its category's. */
    color?: string;
    /** Shown on the canvas as its header only. */
    collapsed?: boolean;
    /** Passes its main input straight through instead of doing its work. */
    bypass?: boolean;
}

/** Fields of a node that change only how the canvas shows it, never what it draws. */
export const SHOWN_ONLY_FIELDS = ['x', 'y', 'name', 'color', 'collapsed'] as const;

export interface TexGraphLink {
    from: string;
    fromOutput: string;
    to: string;
    toInput: string;
}

export interface TexGraphComment {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
    color: string;
}

export type GraphParameterKind = 'float' | 'int' | 'bool' | 'color' | 'vec2' | 'select';

/** A value the graph exposes: set on the material (or wherever the graph is used) and read by nodes. */
export interface GraphParameter {
    /** The name formulas use: letters, digits and underscores. */
    name: string;
    label: string;
    kind: GraphParameterKind;
    default: number | boolean | number[] | string;
    min?: number;
    max?: number;
    step?: number;
    options?: Array<{ value: string; label: string }>;
    group?: string;
    description?: string;
}

export interface TextureGraph {
    version: 1;
    /** The graph's size in powers of two (10 is 1024). */
    size: { w: number; h: number };
    seed: number;
    nodes: TexGraphNode[];
    links: TexGraphLink[];
    comments?: TexGraphComment[];
    parameters: GraphParameter[];
    /** Which ways the graph tiles (both unless set): nodes take it unless they say otherwise. */
    tiling?: TilingMode;
    /** Bits a channel for nodes set to take the graph's. */
    precision?: 8 | 16 | 32;
    /** The size the graph's picture stands for in the world, in metres, across and down (1 × 1 unless set). */
    physicalSize?: { w: number; h: number };
}

/** Engine material channels an output can feed. */
export const OUTPUT_CHANNELS = ['baseColor', 'normal', 'roughness', 'metallic', 'height', 'ambientOcclusion', 'emissive', 'opacity', 'custom'] as const;
export type OutputChannel = typeof OUTPUT_CHANNELS[number];
export const OUTPUT_CHANNEL_LABELS: Record<OutputChannel, string> = {
    baseColor: 'Base colour', normal: 'Normal', roughness: 'Roughness', metallic: 'Metallic', height: 'Height',
    ambientOcclusion: 'Ambient occlusion', emissive: 'Emissive', opacity: 'Opacity', custom: 'Named image',
};
/** Each channel's kind; a named image ('custom') is colour unless its Output node says grey. */
export const CHANNEL_KIND: Record<OutputChannel, PortKind> = {
    baseColor: 'color', normal: 'color', roughness: 'gray', metallic: 'gray', height: 'gray', ambientOcclusion: 'gray', emissive: 'color', opacity: 'gray', custom: 'color',
};

/** The kind of image an Output node gives: its channel's, or for a named image the kind chosen on it. */
export const outputNodeKind = (params: Readonly<Record<string, unknown>>): PortKind => {
    const channel = (OUTPUT_CHANNELS as readonly string[]).includes(String(params.channel)) ? params.channel as OutputChannel : 'custom';
    if (channel === 'custom') return params.kind === 'gray' ? 'gray' : 'color';
    return CHANNEL_KIND[channel];
};

/** Everything a node sees while it draws. */
export interface NodeRunContext {
    readonly gpu: TextureGpu;
    readonly node: TexGraphNode;
    readonly width: number;
    readonly height: number;
    /** The graph's seed mixed with the node's own. */
    readonly seed: number;
    readonly precision: ImagePrecision;
    /** Whether the node's image repeats across and down (its tiling). */
    readonly tiling: [boolean, boolean];
    /** Settings with links to the graph's parameters worked out. */
    readonly params: Readonly<Record<string, unknown>>;
    readonly signal: AbortSignal;
    input(key: string): GpuImage | null;
    /** The kind each output resolved to. */
    outputKind(key: string): PortKind;
    /** A fresh image for an output or for working (release working images when done). */
    image(kind: PortKind, width?: number, height?: number, precision?: ImagePrecision): GpuImage;
    /** Runs a pass with the node's inputs, settings and seed bound as the kit binds them. */
    pass(target: GpuImage, fragment: string, extra?: Omit<PassOptions, 'fragment'>): Promise<void>;
    /** A texture of the project (Bitmap nodes); null while it loads. */
    texture(textureId: string): THREE.Texture | null;
    /** Evaluates another graph as part of this one (sub-graph nodes). */
    subgraph(graphId: string, params: Readonly<Record<string, unknown>>, inputs: Readonly<Record<string, GpuImage | null>>): Promise<Record<string, GpuImage>>;
    /** An image the caller supplied for one of the graph's Input nodes. */
    external(name: string): GpuImage | THREE.Texture | null;
    /** The channels of the material wired into a material input (null when none is). */
    material(key: string): MaterialImages | null;
}

export type NodeCategory =
    | 'Inputs and outputs'
    | 'Noises'
    | 'Patterns'
    | 'Shapes'
    | 'Adjustments'
    | 'Blending'
    | 'Transforms'
    | 'Warps'
    | 'Blurs and sharpening'
    | 'Edges and distance'
    | 'Height and normals'
    | 'Mesh maps'
    | 'Materials'
    | 'Utility';

export interface TexNodeDef {
    type: string;
    label: string;
    category: NodeCategory;
    description: string;
    keywords?: readonly string[];
    inputs: TexPortDef[];
    outputs: TexPortDef[];
    params: TexParamDef[];
    /** Generators follow the graph's size, filters their input's. */
    sizeFrom: 'input' | 'graph';
    /** The inputs an 'any' output takes its kind from: colour when any of them is. */
    kindFrom?: string | readonly string[];
    /** An 'any' output's kind when nothing it follows is wired (grey unless said). */
    anyDefault?: PortKind;
    /** An 'any' output's kind from the node's settings instead (Input and Pixel processor nodes). */
    kindOf?: (params: Readonly<Record<string, unknown>>) => PortKind;
    /** The input a bypassed node passes through (its first unless said: a blend's background). */
    main?: string;
    /** False for a node that cannot be bypassed: what goes in is not what comes out (images into a material). */
    bypass?: false;
    /** How the editor shows its images. */
    preview?: 'normal';
    /** The node's own drawing. */
    run(context: NodeRunContext): Promise<Record<string, GpuImage>>;
}
