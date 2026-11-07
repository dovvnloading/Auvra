import * as THREE from 'three';
import type { GpuImage } from '../gpu/textureGpu';
import type { CurvePoint, CurveSet, NodeRunContext, PortKind, RampStop, TexNodeDef, TexParamDef, TexPortDef } from './types';

/**
 * NODE KIT
 *
 * What node definitions are written with. A node's GLSL sees:
 *   - each input `key` as `c_key(uv)` (colour) and `g_key(uv)` (grey), its sampler `t_key`, and
 *     `w_key` (1 when something is wired to it);
 *   - each setting as `p_key`: float, int (also selects, as the option's index, and switches), vec4
 *     (colours), vec2; a ramp as `p_key_colors`, `p_key_positions`, `p_key_count` (pass them to
 *     sampleRamp); a curve as the lookup `curveValue(p_key, value, channel)`; a bitmap as sampler
 *     `p_key` with `p_key_ok`;
 *   - `uSeed`, the node's random seed, and `uSize`, its size in pixels; `uWorld`, the metres its
 *     picture spans; `uIteration` and `uIterations`, the pass of an Iterate node it runs in.
 *
 * A setting shown as a pin (TexGraphNode.valuePins) with a value wired in reads that value on the
 * GPU: its `p_key` is a read of the one-pixel picture `v_key`, so nothing comes back to the CPU.
 */

/** The kinds of setting that can follow a value wired in. */
export const VALUE_SETTING_KINDS: ReadonlySet<TexParamDef['kind']> = new Set(['float', 'int', 'bool', 'color', 'vec2']);

/** The input a setting shown as a pin takes its value through. */
export const valuePinKey = (paramKey: string): string => `@${paramKey}`;
export const isValuePin = (inputKey: string): boolean => inputKey.startsWith('@');

/** GLSL reading a setting's value from the one-pixel picture `v_key`, kept inside the setting's limits. */
const valueRead = (param: TexParamDef, sampler: string): string => {
    const texel = `texelFetch(${sampler}, ivec2(0), 0)`;
    const limit = (expression: string, whole: boolean) => {
        const low = Number.isFinite(param.min) ? param.min! : null;
        const high = Number.isFinite(param.max) ? param.max! : null;
        if (low === null && high === null) return expression;
        const literal = (value: number) => (whole ? String(Math.round(value)) : (Number.isInteger(value) ? `${value}.0` : String(value)));
        if (low !== null && high !== null) return `clamp(${expression}, ${literal(low)}, ${literal(high)})`;
        return low !== null ? `max(${expression}, ${literal(low)})` : `min(${expression}, ${literal(high!)})`;
    };
    switch (param.kind) {
        case 'int': return limit(`int(floor(${texel}.x + 0.5))`, true);
        case 'bool': return `(${texel}.x > 0.5 ? 1 : 0)`;
        case 'color': return texel;
        case 'vec2': return limit(`${texel}.xy`, false);
        default: return limit(`${texel}.x`, false);
    }
};

export const float = (key: string, label: string, value: number, min: number, max: number, extra: Partial<TexParamDef> = {}): TexParamDef =>
    ({ key, label, kind: 'float', default: value, min, max, step: extra.step ?? (max - min > 20 ? 0.1 : 0.01), ...extra });
export const int = (key: string, label: string, value: number, min: number, max: number, extra: Partial<TexParamDef> = {}): TexParamDef =>
    ({ key, label, kind: 'int', default: value, min, max, step: 1, ...extra });
export const bool = (key: string, label: string, value: boolean, extra: Partial<TexParamDef> = {}): TexParamDef =>
    ({ key, label, kind: 'bool', default: value, ...extra });
export const color = (key: string, label: string, value: [number, number, number, number], extra: Partial<TexParamDef> = {}): TexParamDef =>
    ({ key, label, kind: 'color', default: value, ...extra });
export const vec2 = (key: string, label: string, value: [number, number], min: number, max: number, extra: Partial<TexParamDef> = {}): TexParamDef =>
    ({ key, label, kind: 'vec2', default: value, min, max, step: 0.01, ...extra });
export const select = (key: string, label: string, value: string, options: ReadonlyArray<[string, string]>, extra: Partial<TexParamDef> = {}): TexParamDef =>
    ({ key, label, kind: 'select', default: value, options: options.map(([v, l]) => ({ value: v, label: l })), ...extra });
export const ramp = (key: string, label: string, stops: RampStop[]): TexParamDef => ({ key, label, kind: 'ramp', default: { stops } });
export const curve = (key: string, label: string): TexParamDef => ({ key, label, kind: 'curve', default: defaultCurves() });
export const seed = (): TexParamDef => int('seed', 'Random seed', 0, 0, 9999, { hint: 'Each seed gives a different variation of the same look.' });

export const colorIn = (key: string, label: string, fallback: TexPortDef['fallback'] = 'black'): TexPortDef => ({ key, label, kind: 'color', fallback });
export const grayIn = (key: string, label: string, fallback: TexPortDef['fallback'] = 'black'): TexPortDef => ({ key, label, kind: 'gray', fallback });
export const anyIn = (key: string, label: string, fallback: TexPortDef['fallback'] = 'black'): TexPortDef => ({ key, label, kind: 'any', fallback });
export const out = (kind: PortKind | 'any', key = 'out', label = 'Output'): TexPortDef => ({ key, label, kind });
/** A pin carrying a whole material (every surface channel on one wire). */
export const materialIn = (key: string, label: string): TexPortDef => ({ key, label, kind: 'material' });
export const materialOut = (key = 'out', label = 'Material'): TexPortDef => ({ key, label, kind: 'material' });
/** A pin carrying a curve: paths in the picture, worked out on the CPU. */
export const curveIn = (key: string, label: string): TexPortDef => ({ key, label, kind: 'curve' });
export const curveOut = (key = 'path', label = 'Path'): TexPortDef => ({ key, label, kind: 'curve' });

export const defaultCurves = (): CurveSet => {
    const line = (): CurvePoint[] => [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    return { all: line(), r: line(), g: line(), b: line(), a: line() };
};

/** The option's index in a select's list (what the shader sees). */
export const optionIndex = (param: TexParamDef, value: unknown): number => {
    const index = param.options?.findIndex((option) => option.value === value) ?? -1;
    return index < 0 ? Math.max(0, param.options?.findIndex((option) => option.value === param.default) ?? 0) : index;
};

// ---------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------

/** Monotone cubic through sorted points (Fritsch and Carlson), so a curve never overshoots between them. */
export const sampleCurve = (points: readonly CurvePoint[], x: number): number => {
    const sorted = [...points].filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)).sort((a, b) => a.x - b.x);
    if (sorted.length === 0) return x;
    if (sorted.length === 1 || x <= sorted[0].x) return sorted[0].y;
    if (x >= sorted[sorted.length - 1].x) return sorted[sorted.length - 1].y;
    const n = sorted.length;
    const slopes: number[] = [];
    for (let i = 0; i < n - 1; i++) slopes.push((sorted[i + 1].y - sorted[i].y) / Math.max(1e-6, sorted[i + 1].x - sorted[i].x));
    const tangents: number[] = [slopes[0]];
    for (let i = 1; i < n - 1; i++) tangents.push(slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2);
    tangents.push(slopes[n - 2]);
    for (let i = 0; i < n - 1; i++) {
        if (slopes[i] === 0) { tangents[i] = 0; tangents[i + 1] = 0; continue; }
        const a = tangents[i] / slopes[i];
        const b = tangents[i + 1] / slopes[i];
        const h = a * a + b * b;
        if (h > 9) {
            const t = 3 / Math.sqrt(h);
            tangents[i] = t * a * slopes[i];
            tangents[i + 1] = t * b * slopes[i];
        }
    }
    let i = 0;
    while (i < n - 2 && x > sorted[i + 1].x) i++;
    const x0 = sorted[i].x;
    const x1 = sorted[i + 1].x;
    const h = x1 - x0;
    const t = (x - x0) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * sorted[i].y + (t3 - 2 * t2 + t) * h * tangents[i] + (-2 * t3 + 3 * t2) * sorted[i + 1].y + (t3 - t2) * h * tangents[i + 1];
};

const CURVE_SIZE = 256;
const curveTextures = new Map<string, THREE.DataTexture>();

/** A 256-wide lookup: each channel's curve after the master curve. */
export const curveTexture = (set: CurveSet): THREE.DataTexture => {
    const key = JSON.stringify(set);
    let texture = curveTextures.get(key);
    if (texture) return texture;
    const data = new Float32Array(CURVE_SIZE * 4);
    const channels: Array<keyof CurveSet> = ['r', 'g', 'b', 'a'];
    for (let i = 0; i < CURVE_SIZE; i++) {
        const x = i / (CURVE_SIZE - 1);
        const master = sampleCurve(set.all, x);
        channels.forEach((channel, c) => { data[i * 4 + c] = channel === 'a' ? sampleCurve(set.a, x) : sampleCurve(set[channel], master); });
    }
    texture = new THREE.DataTexture(data, CURVE_SIZE, 1, THREE.RGBAFormat, THREE.FloatType);
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    if (curveTextures.size > 64) {
        const oldest = curveTextures.keys().next().value as string;
        curveTextures.get(oldest)?.dispose();
        curveTextures.delete(oldest);
    }
    curveTextures.set(key, texture);
    return texture;
};

export const readCurves = (value: unknown): CurveSet => {
    const fallback = defaultCurves();
    if (!value || typeof value !== 'object') return fallback;
    const result = { ...fallback };
    for (const channel of Object.keys(fallback) as Array<keyof CurveSet>) {
        const points = (value as Partial<CurveSet>)[channel];
        if (!Array.isArray(points)) continue;
        const valid = points
            .filter((p): p is CurvePoint => !!p && Number.isFinite(p.x) && Number.isFinite(p.y))
            .map((p) => ({ x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) }))
            .slice(0, 32);
        if (valid.length >= 2) result[channel] = valid;
    }
    return result;
};

export const MAX_RAMP_STOPS = 16;

export const readRamp = (value: unknown, fallback: RampStop[]): RampStop[] => {
    const stops = (value as { stops?: unknown } | null)?.stops;
    if (!Array.isArray(stops)) return fallback;
    const valid = stops
        .filter((stop): stop is RampStop => !!stop && Number.isFinite(stop.position) && Array.isArray(stop.color) && stop.color.length >= 3 && stop.color.every(Number.isFinite))
        .map((stop) => ({ position: Math.min(1, Math.max(0, stop.position)), color: [stop.color[0], stop.color[1], stop.color[2], stop.color[3] ?? 1].map((c) => Math.min(1, Math.max(0, c))) as RampStop['color'] }))
        .sort((a, b) => a.position - b.position)
        .slice(0, MAX_RAMP_STOPS);
    return valid.length ? valid : fallback;
};

// ---------------------------------------------------------------------------
// Binding a node's inputs and settings to a pass
// ---------------------------------------------------------------------------

export const CURVE_GLSL = /* glsl */ `
float curveValue(sampler2D lut, float value, int channel) {
    vec4 v = texture(lut, vec2(clamp(value, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0, 0.5));
    return channel == 0 ? v.r : channel == 1 ? v.g : channel == 2 ? v.b : v.a;
}
`;

/** The GLSL declarations a node's pass gets, and the values they take. */
export const nodeBindings = (
    definition: TexNodeDef,
    context: Pick<NodeRunContext, 'input' | 'params' | 'seed' | 'texture' | 'tiling'> & Partial<Pick<NodeRunContext, 'world' | 'iteration' | 'time'>>,
    gpuConstant: (name: NonNullable<TexPortDef['fallback']>) => THREE.Texture,
): { declarations: string; inputs: Record<string, GpuImage | THREE.Texture>; uniforms: Record<string, unknown> } => {
    // The node's tiling: inputs read past an edge come round where it repeats and stop at the edge where
    // it does not; noises repeat only where it repeats.
    const lines: string[] = [
        'uniform float uSeed;',
        'uniform ivec2 uTiles;',
        // Metres the picture spans: slopes per metre are slopes per unit of the picture over this.
        'uniform vec2 uWorld;',
        'uniform int uIteration;',
        'uniform int uIterations;',
        // The graph's time: seconds into its loop, and how far round the loop (0 to 1).
        'uniform float uTime;',
        'uniform float uPhase;',
        'vec2 tileUv(vec2 uv) { return vec2(uTiles.x == 1 ? fract(uv.x) : clamp(uv.x, 0.0, 1.0), uTiles.y == 1 ? fract(uv.y) : clamp(uv.y, 0.0, 1.0)); }',
        'ivec2 tilePeriod(ivec2 cells) { return ivec2(uTiles.x == 1 ? cells.x : 1048576, uTiles.y == 1 ? cells.y : 1048576); }',
    ];
    const inputs: Record<string, GpuImage | THREE.Texture> = {};
    const world = context.world ?? [1, 1];
    const uniforms: Record<string, unknown> = {
        uSeed: context.seed, uTiles: [context.tiling[0] ? 1 : 0, context.tiling[1] ? 1 : 0], uWorld: new THREE.Vector2(world[0], world[1]),
        uIteration: context.iteration?.index ?? 0, uIterations: context.iteration?.count ?? 1,
        uTime: context.time?.seconds ?? 0, uPhase: context.time?.phase ?? 0,
    };
    for (const port of definition.inputs) {
        // A material input carries a picture per channel: the node binds the ones it reads itself. A
        // value goes to the setting it is wired to.
        if (port.kind === 'material' || port.kind === 'value' || port.kind === 'curve') continue;
        const image = context.input(port.key);
        const gray = image ? image.kind === 'gray' : false;
        inputs[`t_${port.key}`] = image ?? gpuConstant(port.fallback ?? 'black');
        lines.push(`uniform int w_${port.key};`);
        uniforms[`w_${port.key}`] = image ? 1 : 0;
        lines.push(gray
            ? `vec4 c_${port.key}(vec2 uv) { float v = texture(t_${port.key}, tileUv(uv)).r; return vec4(v, v, v, 1.0); }\nfloat g_${port.key}(vec2 uv) { return texture(t_${port.key}, tileUv(uv)).r; }`
            : `vec4 c_${port.key}(vec2 uv) { return texture(t_${port.key}, tileUv(uv)); }\nfloat g_${port.key}(vec2 uv) { return luma(texture(t_${port.key}, tileUv(uv)).rgb); }`);
    }
    let needsCurve = false;
    for (const param of definition.params) {
        const value = context.params[param.key];
        const name = `p_${param.key}`;
        const following = VALUE_SETTING_KINDS.has(param.kind) ? context.input(valuePinKey(param.key)) : null;
        if (following) {
            lines.push(`uniform sampler2D v_${param.key};\n#define ${name} (${valueRead(param, `v_${param.key}`)})`);
            inputs[`v_${param.key}`] = following;
            continue;
        }
        switch (param.kind) {
            case 'float':
                lines.push(`uniform float ${name};`);
                uniforms[name] = Number(value) || 0;
                break;
            case 'int':
                lines.push(`uniform int ${name};`);
                uniforms[name] = Math.round(Number(value) || 0);
                break;
            case 'bool':
                lines.push(`uniform int ${name};`);
                uniforms[name] = value ? 1 : 0;
                break;
            case 'select':
                lines.push(`uniform int ${name};`);
                uniforms[name] = optionIndex(param, value);
                break;
            case 'color': {
                lines.push(`uniform vec4 ${name};`);
                const c = Array.isArray(value) ? value : (param.default as number[]);
                uniforms[name] = new THREE.Vector4(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 1);
                break;
            }
            case 'vec2': {
                lines.push(`uniform vec2 ${name};`);
                const v = Array.isArray(value) ? value : (param.default as number[]);
                uniforms[name] = new THREE.Vector2(v[0] ?? 0, v[1] ?? 0);
                break;
            }
            case 'ramp': {
                const stops = readRamp(value, (param.default as { stops: RampStop[] }).stops);
                lines.push(`uniform vec4 ${name}_colors[16];\nuniform float ${name}_positions[16];\nuniform int ${name}_count;`);
                const colors = Array.from({ length: 16 }, (_, i) => { const s = stops[Math.min(i, stops.length - 1)]; return new THREE.Vector4(...s.color); });
                uniforms[`${name}_colors`] = colors;
                uniforms[`${name}_positions`] = Array.from({ length: 16 }, (_, i) => stops[Math.min(i, stops.length - 1)].position);
                uniforms[`${name}_count`] = stops.length;
                break;
            }
            case 'curve':
                needsCurve = true;
                inputs[name] = curveTexture(readCurves(value));
                break;
            case 'texture': {
                const texture = typeof value === 'string' && value ? context.texture(value) : null;
                inputs[name] = texture ?? gpuConstant('black');
                lines.push(`uniform int ${name}_ok;`);
                uniforms[`${name}_ok`] = texture ? 1 : 0;
                // Pictures kept as sRGB read back linear: the _srgb flag says to turn them back.
                lines.push(`uniform int ${name}_srgb;`);
                uniforms[`${name}_srgb`] = texture?.colorSpace === THREE.SRGBColorSpace ? 1 : 0;
                break;
            }
            default:
                break;
        }
    }
    if (needsCurve) lines.push(CURVE_GLSL);
    return { declarations: lines.join('\n'), inputs, uniforms };
};

/**
 * A node drawn in one pass of `glsl` (which writes `outColor`) into one output called 'out'.
 * Most nodes are this.
 */
export const onePass = (definition: Omit<TexNodeDef, 'run'> & { glsl: string; cost?: (params: Readonly<Record<string, unknown>>) => number }): TexNodeDef => {
    const { glsl, cost, ...rest } = definition;
    return {
        ...rest,
        settingsInShader: true,
        async run(context) {
            const port = rest.outputs[0];
            const image = context.image(context.outputKind(port.key));
            await context.pass(image, glsl, { cost: cost?.(context.params) ?? 1 });
            return { [port.key]: image };
        },
    };
};
