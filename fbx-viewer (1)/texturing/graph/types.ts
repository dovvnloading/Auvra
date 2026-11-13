import type * as THREE from 'three';
import type { GpuImage, ImagePrecision, PassOptions } from '../gpu/textureGpu';
import type { TexturingGpu } from '../gpu/texturingGpu';
import type { GraphAnimation, GraphTime } from './animation';
import type { Point } from './curves';
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
 * What a pin carries: one image (colour or grey; 'any' either), a whole material (one wire carrying
 * every surface channel: base colour, normal, roughness...), a value: one number or vector worked
 * out on the GPU (a picture one pixel across), which a setting shown as a pin follows, or a curve:
 * paths in the picture (a Curve's, a mask's outlines), worked out on the CPU, which the spline nodes
 * draw and the path tools change.
 */
export type PinKind = PortKind | 'any' | 'material' | 'value' | 'curve';

/** One path on a curve wire: a polyline in picture places (u across, v up, 0 to 1); a closed one ends where it starts. */
export interface CurvePath { points: Point[]; closed: boolean }

/** What a curve wire carries: one or more paths. */
export type CurvePaths = readonly CurvePath[];

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

export type TexParamKind = 'float' | 'int' | 'bool' | 'color' | 'vec2' | 'select' | 'ramp' | 'curve' | 'texture' | 'string' | 'font' | 'code' | 'graph' | 'function' | 'settings' | 'points';

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
    /** A slider's ends; typing can go past them up to `min` and `max`. */
    softMin?: number;
    softMax?: number;
    step?: number;
    options?: ReadonlyArray<{ value: string; label: string }>;
    hint?: string;
    /** Shown only while this holds for the node's other settings. */
    showIf?: (params: Readonly<Record<string, unknown>>) => boolean;
    /** A heading it is listed under (a graph's parameter group, on a node using the graph). */
    group?: string;
    /** Text of many lines (an SVG drawing), typed in a box with a button to read it from a file of these types. */
    multiline?: { accept: string; limit: number };
    /** An input that takes this setting's place while something is wired to it (a curve wired in instead of points placed here). */
    replacedBy?: string;
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
    /** Settings shown as pins, which follow a value wired in (a Value processor's) instead of their own. */
    valuePins?: string[];
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

/** What a parameter holds: a number, switch, colour, pair or choice, or a gradient, curves, a picture, text or a font. */
export type GraphParameterKind = 'float' | 'int' | 'bool' | 'color' | 'vec2' | 'select' | 'ramp' | 'curve' | 'texture' | 'string' | 'font';

/** A parameter value: a number, switch, vector or text, or a gradient's stops or curves. */
export type GraphParameterValue = number | boolean | number[] | string | { stops: RampStop[] } | CurveSet;

/** A value the graph exposes: set on the material (or wherever the graph is used) and read by nodes. */
export interface GraphParameter {
    /** The name formulas use: letters, digits and underscores. */
    name: string;
    label: string;
    kind: GraphParameterKind;
    default: GraphParameterValue;
    /** Hard limits: a value never goes past them. */
    min?: number;
    max?: number;
    /** The slider's ends, inside the hard limits: typing can go past them. */
    softMin?: number;
    softMax?: number;
    step?: number;
    options?: Array<{ value: string; label: string }>;
    group?: string;
    description?: string;
    /** Shown only while this formula of the other parameters holds (is not 0): "pattern == 2", "wear > 0.5". */
    visibleIf?: string;
}

/** A heading parameters are listed under, with words about it, and whether it starts folded. */
export interface GraphParameterGroup {
    name: string;
    description?: string;
    folded?: boolean;
}

/** Values for some of a graph's parameters (and its seed), kept under a name. */
export interface GraphPreset {
    id: string;
    name: string;
    values: Record<string, GraphParameterValue>;
    seed?: number;
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
    /** Its parameter groups' words and folding, in the order shown (groups no parameter is in are dropped). */
    groups?: GraphParameterGroup[];
    /** Presets kept with the graph: they go wherever it goes and wherever it is used. */
    presets?: GraphPreset[];
    /** How long its time takes to come round, and how the game plays it (graphs whose nodes read the time). */
    animation?: GraphAnimation;
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

/** How a graph used inside another runs this time (an Iterate node's passes). */
export interface SubgraphRunOptions {
    iteration?: { index: number; count: number };
    /** Mixed into the seed the graph inside runs with (a new seed each pass). */
    seedOffset?: number;
    owned?: boolean;
    /** CPU curve paths supplied to a nested graph's Curve input nodes, by name. */
    curveInputs?: Readonly<Record<string, CurvePaths | null>>;
    /** The paths produced by nested Curve output nodes, keyed by their stable node id. */
    onCurveOutput?: (outputId: string, paths: CurvePaths) => void;
}

/** Everything a node sees while it draws. */
export interface NodeRunContext {
    readonly gpu: TexturingGpu;
    readonly node: TexGraphNode;
    readonly width: number;
    readonly height: number;
    /** The graph's seed mixed with the node's own. */
    readonly seed: number;
    readonly precision: ImagePrecision;
    /** Whether the node's image repeats across and down (its tiling). */
    readonly tiling: [boolean, boolean];
    /** Inside a graph an Iterate node runs: which pass this is (0 first) and how many there are; else 0 of 1. */
    readonly iteration: { index: number; count: number };
    /**
     * Metres the picture spans across and down: the graph's size in the world ([1, 1] when it has
     * none). Slope-based nodes measure slopes over it, so the same heights make the same bumps.
     */
    readonly world: [number, number];
    /** Settings with links to the graph's parameters worked out. */
    readonly params: Readonly<Record<string, unknown>>;
    /** The graph's time: seconds into its loop, the loop's length and how far round it is (shaders: uTime, uPhase). */
    readonly time?: GraphTime;
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
    /**
     * Evaluates another graph as part of this one (sub-graph and Iterate nodes). The results are the
     * node's to keep or let go of when `owned`; otherwise they go back when the node is done unless it
     * gives them out.
     */
    subgraph(graphId: string, params: Readonly<Record<string, unknown>>, inputs: Readonly<Record<string, GpuImage | null>>, options?: SubgraphRunOptions): Promise<Record<string, GpuImage>>;
    /** An image the caller supplied for one of the graph's Input nodes. */
    external(name: string): GpuImage | THREE.Texture | null;
    /** CPU paths supplied for a Curve input node, or null when absent. */
    externalCurve(name: string): CurvePaths | null;
    /** The channels of the material wired into a material input (null when none is). */
    material(key: string): MaterialImages | null;
    /** The paths of the curve wired into a curve input (null when none is). */
    curve(key: string): CurvePaths | null;
    /** Gives one of the node's curve outputs its paths. */
    giveCurve(key: string, paths: CurvePaths): void;
    /**
     * Says something about how the node drew, shown on it and in its 2D view: a short phrase, then
     * ": " and the rest ("No curvature map: ..."). Not every caller listens.
     */
    note?(text: string): void;
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
    | 'Weathering'
    | 'Photo and scans'
    | 'Splines and paths'
    | 'SDF shapes'
    | 'Checks'
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
    /** Ready-set versions offered in the finder as entries of their own (each grunge look). */
    variants?: ReadonlyArray<{ key: string; label: string; description: string; params: Record<string, unknown> }>;
    /**
     * Bits a channel its images need from its settings, when more than its kind says (a Bitmap of a
     * 16-bit or floating-point picture); used when the node is not set to a depth of its own.
     */
    precisionOf?: (params: Readonly<Record<string, unknown>>, texture: (textureId: string) => THREE.Texture | null) => ImagePrecision | undefined;
    /**
     * Its settings are read only by its shaders (through the kit), so a setting following a value
     * wired in reads it on the GPU; other nodes read such a value back first.
     */
    settingsInShader?: boolean;
    /** It reads the graph's time (with these settings): drawn again as the time changes, and the graph animates. */
    readsTime?: (params: Readonly<Record<string, unknown>>) => boolean;
    /** It reads which Iterate pass it is (with these settings): inside a pass, drawn again each pass. */
    readsPass?: (params: Readonly<Record<string, unknown>>) => boolean;
    /** The node's own drawing. */
    run(context: NodeRunContext): Promise<Record<string, GpuImage>>;
}
