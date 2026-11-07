import * as THREE from 'three';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { formulaScope, parameterValues, resolveNodeParams } from '../../texturing/graph/document';
import { FN_RESULT_TYPE, compileFunction, functionNodeDefinition, glslFunction, readFunctionGraph, type FnType } from '../../texturing/graph/functionGraph';
import { tilingAxes } from '../../texturing/graph/inherit';
import { nodeBindings } from '../../texturing/graph/nodeKit';
import { PROCESSOR_PICTURES, PROCESSOR_TYPES, VALUE_PROCESSOR_TYPE, defaultFunctionFor, processorUse, readNamedSettings } from '../../texturing/graph/nodes/processors';
import { textureNodeDefinition, type GraphResolver } from '../../texturing/graph/registry';
import type { TextureGraph } from '../../texturing/graph/types';
import type { TextureGraphSession } from './textureGraphSession';

/** Pixels across a function node's picture. */
export const FUNCTION_PREVIEW_SIZE = 64;
/** Function nodes previewed at most (the rest show their pins only). */
const MOST_PREVIEWS = 96;

export interface FunctionPreview {
    /** A Pixel processor's node: its value over the picture. */
    image?: ImageData;
    /** A Value processor's node: its numbers. */
    value?: number[];
    type?: FnType;
    error?: string;
}

/** A value's numbers in words, as short as they read: "0.42", "0.1, 0.5", "yes". */
export const valueWords = (type: FnType | undefined, value: readonly number[]): string => {
    const number = (item: number) => (Math.abs(item) >= 1000 ? item.toExponential(1) : String(Number(item.toFixed(Math.abs(item) < 10 ? 3 : 1))));
    switch (type) {
        case 'bool': return value[0] > 0.5 ? 'yes' : 'no';
        case 'int': return String(Math.round(value[0]));
        case 'vec2': return value.slice(0, 2).map(number).join(', ');
        case 'vec3': return value.slice(0, 3).map(number).join(', ');
        case 'vec4': return value.slice(0, 4).map(number).join(', ');
        default: return number(value[0] ?? 0);
    }
};

/**
 * The value at every node of a processor's function graph, worked out as the processor works it out
 * (with its pictures, settings, seed, size and tiling): a small picture at each node of a Pixel
 * processor, the numbers at each node of a Value processor. Drawn again whenever the function, the
 * processor's settings or what is wired into it changes.
 */
export class FunctionPreviews {
    private readonly previews = new Map<string, FunctionPreview>();
    private readonly listeners = new Set<() => void>();
    private version = 0;
    private key = '';
    private ticket = 0;
    private pending: { graph: TextureGraph; values: Readonly<Record<string, unknown>>; processorId: string } | null = null;
    private scheduled = false;
    private disposed = false;

    constructor(private readonly session: TextureGraphSession, private readonly resolve: GraphResolver) {}

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getVersion = (): number => this.version;

    get(nodeId: string): FunctionPreview | undefined {
        return this.previews.get(nodeId);
    }

    private changed(): void {
        this.version++;
        for (const listener of this.listeners) listener();
    }

    /** Draws the previews for the processor `processorId` of `graph` (whose parameters have `values`) when anything they show changed. */
    update(graph: TextureGraph, values: Readonly<Record<string, unknown>>, processorId: string): void {
        const node = graph.nodes.find((candidate) => candidate.id === processorId);
        if (!node || !PROCESSOR_TYPES.has(node.type)) return;
        const inputs = graph.links.filter((link) => link.to === processorId).map((link) => `${link.toInput}=${this.session.state(link.from)?.signature ?? '-'}`);
        const state = this.session.state(processorId);
        const key = JSON.stringify([node.params, node.valuePins, inputs, values, graph.parameters, graph.physicalSize, graph.tiling, state?.width, state?.height, state?.seed, state?.tiling]);
        if (key === this.key) return;
        this.key = key;
        this.pending = { graph, values, processorId };
        if (this.scheduled) return;
        this.scheduled = true;
        let done = false;
        const run = () => {
            if (done) return;
            done = true;
            this.scheduled = false;
            const next = this.pending;
            this.pending = null;
            if (next && !this.disposed) this.draw(next.graph, next.values, next.processorId);
        };
        requestAnimationFrame(run);
        setTimeout(run, 60);
    }

    private draw(graph: TextureGraph, values: Readonly<Record<string, unknown>>, processorId: string): void {
        const node = graph.nodes.find((candidate) => candidate.id === processorId);
        const definition = node ? textureNodeDefinition(node, this.resolve) : null;
        if (!node || !definition) return;
        const ticket = ++this.ticket;
        const gpu = this.session.gpu;
        try {
            const state = this.session.state(processorId);
            const width = state?.width ?? 2 ** graph.size.w;
            const height = state?.height ?? 2 ** graph.size.h;
            const resolved = parameterValues(graph, values);
            const params = resolveNodeParams(definition, node, resolved, formulaScope(graph, resolved, width, height));
            const use = processorUse(node.type);
            const fn = readFunctionGraph(node.params.function, defaultFunctionFor(node.type));
            const settings = readNamedSettings(node.params.settings);
            const pictures = PROCESSOR_PICTURES[node.type];
            const links = graph.links.filter((link) => link.to === processorId);
            const input = (key: string) => {
                const link = links.find((candidate) => candidate.toInput === key);
                return link ? this.session.imageOf(link.from, link.fromOutput) : null;
            };
            const world: [number, number] = [graph.physicalSize?.w ?? 1, graph.physicalSize?.h ?? 1];
            const bound = nodeBindings(definition, { input, params, seed: state?.seed ?? 0.5, texture: () => null, tiling: tilingAxes(state?.tiling ?? graph.tiling ?? 'both'), world }, (name) => gpu.constant(name));
            const next = new Map<string, FunctionPreview>();
            const reads: Array<Promise<void>> = [];
            for (const fnNode of fn.nodes.slice(0, MOST_PREVIEWS)) {
                const output = functionNodeDefinition(fnNode.type)?.outputs[0]?.key;
                if (fnNode.type !== FN_RESULT_TYPE && !output) continue;
                const compiled = compileFunction(fn, { use, settings, pictures, ...(fnNode.type === FN_RESULT_TYPE ? {} : { target: { node: fnNode.id, output: output! } }) });
                if (!compiled.ir) { next.set(fnNode.id, { error: compiled.error ?? 'It gives no value.' }); continue; }
                const type = compiled.ir.result.type;
                const body = glslFunction(compiled.ir, 'fn_preview', use === 'pixel' ? { size: 'uFnSize', pixel: 'floor(vUv * uFnSize)' } : {});
                const uniforms = { ...bound.uniforms, uFnSize: new THREE.Vector2(width, height) };
                if (use === 'value') {
                    const image = gpu.image(1, 1, 'color', 32);
                    gpu.passNow(image, { fragment: `${bound.declarations}\n${body}\nvoid main() { outColor = fn_preview(); }`, inputs: bound.inputs, uniforms });
                    const reading = gpu.readPixelLater(image, 0, 0);
                    gpu.release(image);
                    const id = fnNode.id;
                    reads.push(reading.then((value) => { if (value) next.set(id, { value: [...value], type }); }));
                    continue;
                }
                const image = gpu.image(FUNCTION_PREVIEW_SIZE, FUNCTION_PREVIEW_SIZE, 'color', 8);
                gpu.passNow(image, {
                    fragment: `${bound.declarations}\nuniform vec2 uFnSize;\n${body}
void main() {
    vec4 v = fn_preview();
    vec2 cell = floor(gl_FragCoord.xy / 8.0);
    vec3 checker = mix(vec3(0.16), vec3(0.22), mod(cell.x + cell.y, 2.0));
    outColor = vec4(mix(checker, clamp(v.rgb, 0.0, 1.0), clamp(v.a, 0.0, 1.0)), 1.0);
}`,
                    inputs: bound.inputs,
                    uniforms,
                });
                const reading = gpu.readRgba8Later(image);
                gpu.release(image);
                const id = fnNode.id;
                reads.push(reading.then((pixels) => {
                    if (!pixels) return;
                    // Bottom row first as read: top row first for the picture.
                    const row = FUNCTION_PREVIEW_SIZE * 4;
                    const flipped = new Uint8ClampedArray(pixels.length);
                    for (let y = 0; y < FUNCTION_PREVIEW_SIZE; y++) flipped.set(pixels.subarray((FUNCTION_PREVIEW_SIZE - 1 - y) * row, (FUNCTION_PREVIEW_SIZE - y) * row), y * row);
                    next.set(id, { image: new ImageData(flipped, FUNCTION_PREVIEW_SIZE, FUNCTION_PREVIEW_SIZE), type });
                }));
            }
            void Promise.all(reads).then(() => {
                // A newer draw began meanwhile: its previews replace these.
                if (this.disposed || ticket !== this.ticket) return;
                this.previews.clear();
                for (const [id, preview] of next) this.previews.set(id, preview);
                this.changed();
            });
        } catch (error) {
            frontendDiagnostics.failure('texture_function_preview_failed', error);
        }
    }

    /** True for the Value processor's previews (numbers rather than pictures). */
    static showsNumbers(type: string): boolean {
        return type === VALUE_PROCESSOR_TYPE;
    }

    dispose(): void {
        this.disposed = true;
        this.listeners.clear();
        this.previews.clear();
    }
}
