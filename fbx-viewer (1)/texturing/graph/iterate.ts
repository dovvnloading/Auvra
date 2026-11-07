import { INPUT_NODE_TYPE, ITERATE_NODE_TYPE, MATERIAL_INPUT_NODE_TYPE, MATERIAL_OUTPUT_NODE_TYPE, OUTPUT_NODE_TYPE, SUBGRAPH_SEED_KEY, subgraphParamDefs } from './nodes/io';
import { MATERIAL_CHANNELS, materialKey } from './material';
import { outputNodeKind, OUTPUT_CHANNEL_LABELS, type OutputChannel, type PortKind, type TexGraphNode, type TexNodeDef, type TexParamDef, type TexPortDef, type TextureGraph } from './types';

/**
 * ITERATE
 *
 * An Iterate node runs a graph of the project a set number of times, each pass's results fed into the
 * next: an Output of the graph feeds the Input of the same name on the next pass (a Material output the
 * Material input of its name, every channel), and Inputs with no such Output take what is wired into
 * the node every pass. Each pass knows which pass it is ($iteration in formulas, uIteration in code,
 * the Pass number function node) and runs with a seed of its own. Inside, only what a pass changes
 * draws again: what its fed-back pictures reach, what reads the pass, and (with a new seed each pass)
 * what follows the seed; the rest is kept from the pass before.
 */

/** Passes an Iterate node runs at most. */
export const MAX_PASSES = 64;

interface IterateGraphEntry { id: string; name: string; graph: TextureGraph }

/** An Output's name as the node shows it (its own name, else its channel's). */
const outputName = (node: TexGraphNode): string => {
    const name = typeof node.params.name === 'string' ? node.params.name.trim() : '';
    return name || OUTPUT_CHANNEL_LABELS[node.params.channel as OutputChannel] || 'Output';
};
const inputName = (node: TexGraphNode): string => String(node.params.name || node.id);
/** A Material output's name as the node shows it. */
const materialOutputName = (node: TexGraphNode): string => (typeof node.params.name === 'string' ? node.params.name.trim() : '') || 'Material';
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Which Output feeds which Input on the next pass: those of the same name (letter case aside), each
 * Input once; a Material output feeds the Material input of its name.
 */
export const feedbackPairs = (graph: Pick<TextureGraph, 'nodes'>): Array<{ output: string; input: string; material?: true }> => {
    const inputs = graph.nodes.filter((node) => node.type === INPUT_NODE_TYPE).map(inputName);
    const materialInputs = graph.nodes.filter((node) => node.type === MATERIAL_INPUT_NODE_TYPE).map(inputName);
    const pairs: Array<{ output: string; input: string; material?: true }> = [];
    for (const node of graph.nodes) {
        if (node.type === OUTPUT_NODE_TYPE) {
            const input = inputs.find((name) => same(name, outputName(node)));
            if (input && !pairs.some((pair) => pair.input === input && !pair.material)) pairs.push({ output: node.id, input });
        } else if (node.type === MATERIAL_OUTPUT_NODE_TYPE) {
            const input = materialInputs.find((name) => same(name, materialOutputName(node)));
            if (input && !pairs.some((pair) => pair.input === input && pair.material)) pairs.push({ output: node.id, input, material: true });
        }
    }
    return pairs;
};

/** The pairs as the passes feed them: a material's pair once for each of its channels. */
export const feedKeys = (pairs: ReadonlyArray<{ output: string; input: string; material?: true }>): Array<{ output: string; input: string }> =>
    pairs.flatMap((pair) => (pair.material
        ? MATERIAL_CHANNELS.map((channel) => ({ output: materialKey(pair.output, channel), input: materialKey(pair.input, channel) }))
        : [{ output: pair.output, input: pair.input }]));

/** How many passes a setting asks for, kept from 1 to MAX_PASSES. */
export const passCount = (value: unknown): number => Math.max(1, Math.min(MAX_PASSES, Math.round(Number(value) || 1)));

/**
 * Runs `count` passes: the first with `outer`, each later one with the results the pairs name fed in
 * place of their inputs. `step` gives a pass's results, which become the runner's: each pass's go back
 * (`release`) once the next has made its own, and the last pass's are returned.
 */
export const runPasses = async <T>(
    count: number,
    outer: Readonly<Record<string, T | null>>,
    pairs: ReadonlyArray<{ output: string; input: string }>,
    step: (inputs: Record<string, T | null>, pass: number) => Promise<Record<string, T>>,
    release: (value: T) => void,
): Promise<Record<string, T>> => {
    let last: Record<string, T> = {};
    for (let pass = 0; pass < count; pass++) {
        const inputs: Record<string, T | null> = { ...outer };
        if (pass > 0) for (const pair of pairs) if (last[pair.output] !== undefined) inputs[pair.input] = last[pair.output];
        let made: Record<string, T>;
        try {
            made = await step(inputs, pass);
        } catch (error) {
            for (const value of Object.values(last)) release(value);
            throw error;
        }
        for (const value of Object.values(last)) release(value);
        last = made;
    }
    return last;
};

const ITERATE_PARAMS: readonly TexParamDef[] = [
    { key: 'passes', label: 'Passes', kind: 'int', default: 4, min: 1, max: MAX_PASSES, step: 1, hint: `How many times the graph runs, each pass taking the last one's results (at most ${MAX_PASSES}).` },
    { key: 'newSeed', label: 'A new seed each pass', kind: 'bool', default: true, hint: 'On: every pass runs with a seed of its own, so random parts differ from pass to pass.' },
    { key: SUBGRAPH_SEED_KEY, label: 'Random seed', kind: 'int', default: 0, min: 0, max: 9999, step: 1 },
];

/** An Iterate node's definition: the run graph's image Inputs and Outputs, its parameters, and the passes. */
export const iterateDefinition = (node: Pick<TexGraphNode, 'params'>, resolve: (id: string) => IterateGraphEntry | undefined): TexNodeDef => {
    const entry = typeof node.params.graph === 'string' && node.params.graph ? resolve(node.params.graph) : undefined;
    const graph = entry?.graph;
    const inputs: TexPortDef[] = (graph?.nodes ?? []).filter((candidate) => candidate.type === INPUT_NODE_TYPE || candidate.type === MATERIAL_INPUT_NODE_TYPE)
        .map((candidate) => (candidate.type === MATERIAL_INPUT_NODE_TYPE
            ? { key: inputName(candidate), label: String(candidate.params.name || 'Material'), kind: 'material' as const }
            : { key: inputName(candidate), label: inputName(candidate), kind: (candidate.params.kind === 'gray' ? 'gray' : 'color') as PortKind, fallback: 'black' as const }));
    const outputs: TexPortDef[] = (graph?.nodes ?? []).filter((candidate) => candidate.type === OUTPUT_NODE_TYPE || candidate.type === MATERIAL_OUTPUT_NODE_TYPE)
        .map((candidate) => (candidate.type === MATERIAL_OUTPUT_NODE_TYPE
            ? { key: candidate.id, label: materialOutputName(candidate), kind: 'material' as const }
            : { key: candidate.id, label: outputName(candidate), kind: outputNodeKind(candidate.params) }));
    const pairs = graph ? feedbackPairs(graph) : [];
    return {
        type: ITERATE_NODE_TYPE,
        label: 'Iterate',
        category: 'Utility',
        description: entry
            ? `Runs "${entry.name}" pass after pass. ${pairs.length ? `Fed back each pass: ${pairs.map((pair) => `${outputs.find((port) => port.key === pair.output)?.label} into ${pair.input}`).join(', ')}.` : 'Nothing feeds back yet: give one of its Outputs the name of one of its Inputs.'}`
            : 'Runs a graph of the project pass after pass, each pass\'s results fed into the next: an Output feeds the Input of the same name. Each pass knows its number and has a seed of its own. Choose the graph it runs in its settings.',
        keywords: ['loop', 'repeat', 'recursive', 'feedback', 'iteration', 'erosion', 'growth', 'passes'],
        inputs,
        outputs,
        params: [{ key: 'graph', label: 'Graph', kind: 'graph', default: '' }, ...ITERATE_PARAMS, ...subgraphParamDefs(graph?.parameters ?? [])],
        sizeFrom: 'graph',
        bypass: false,
        async run(context) {
            if (!entry) throw new Error(typeof node.params.graph === 'string' && node.params.graph ? 'The graph this node ran is no longer in the project.' : 'Choose the graph it runs in its settings.');
            const outer: Record<string, ReturnType<typeof context.input>> = {};
            for (const input of inputs) {
                if (input.kind !== 'material') { outer[input.key] = context.input(input.key); continue; }
                // A material goes in as an image per channel, under its input's name and the channel's.
                const material = context.material(input.key);
                for (const channel of MATERIAL_CHANNELS) outer[materialKey(input.key, channel)] = material?.[channel] ?? null;
            }
            const values: Record<string, unknown> = {};
            for (const parameter of graph!.parameters) values[parameter.name] = context.params[parameter.name];
            const count = passCount(context.params.passes);
            const fresh = context.params.newSeed !== false;
            const results = await runPasses(count, outer, feedKeys(pairs), (given, pass) => context.subgraph(entry.id, values, given, {
                iteration: { index: pass, count },
                ...(fresh ? { seedOffset: pass + 1 } : {}),
                owned: true,
            }), (image) => context.gpu.release(image));
            // Only its outputs are kept (a material output's channels under their keys): anything else the graph gave goes back.
            const keys = new Set(outputs.flatMap((port) => (port.kind === 'material' ? MATERIAL_CHANNELS.map((channel) => materialKey(port.key, channel)) : [port.key])));
            const kept: typeof results = {};
            for (const [key, image] of Object.entries(results)) {
                if (keys.has(key)) kept[key] = image;
                else context.gpu.release(image);
            }
            return kept;
        },
    };
};

export const ITERATE_PLACEHOLDER: TexNodeDef = iterateDefinition({ params: {} }, () => undefined);
