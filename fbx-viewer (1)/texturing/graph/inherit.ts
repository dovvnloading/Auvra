import type { ImagePrecision } from '../gpu/textureGpu';
import { shaderSeed } from './document';
import type { PortKind, TilingMode } from './types';

/**
 * WHERE A NODE'S SETTINGS COME FROM
 *
 * A node's size, bit depth, tiling and seed each come from its input (the first one wired), from the
 * graph it sits in, or are fixed on the node. Generators (nodes with no inputs) take the graph's by
 * default, filters their input's.
 */

export const TILING_MODES: ReadonlyArray<[TilingMode, string]> = [['both', 'Both ways'], ['horizontal', 'Across only'], ['vertical', 'Down only'], ['none', 'Not at all']];

const isTiling = (value: unknown): value is TilingMode => value === 'both' || value === 'horizontal' || value === 'vertical' || value === 'none';

/** A node's tiling: as fixed on it, else its input's (when it takes after its input and one is wired), else the graph's. */
export const resolveTiling = (choice: unknown, input: TilingMode | undefined, graph: TilingMode, hasInputs: boolean): TilingMode => {
    if (isTiling(choice)) return choice;
    const from = choice === 'input' || choice === 'graph' ? choice : hasInputs ? 'input' : 'graph';
    return from === 'input' ? input ?? graph : graph;
};

/** Whether a tiling repeats across (x) and down (y). */
export const tilingAxes = (mode: TilingMode): [boolean, boolean] => [mode === 'both' || mode === 'horizontal', mode === 'both' || mode === 'vertical'];

/**
 * A node's bit depth: as fixed on it; the graph's when it takes after the graph (by the kind it makes
 * when the graph sets none); else the widest of its wired inputs, by the kind it makes when none is
 * wired (8 for colour, 16 for grey).
 */
export const resolvePrecision = (choice: unknown, inputs: readonly ImagePrecision[], graph: ImagePrecision | undefined, kind: PortKind): ImagePrecision => {
    if (choice === 8 || choice === 16 || choice === 32) return choice;
    const byKind: ImagePrecision = kind === 'color' ? 8 : 16;
    if (choice === 'graph') return graph ?? byKind;
    return inputs.length ? (Math.max(...inputs) as ImagePrecision) : byKind;
};

/**
 * The seed a node's shaders see: its own seed mixed with the graph's (as before), with its input's when
 * it takes after its input (the graph's when nothing is wired), or alone when fixed (so it looks the same
 * whatever the graph's seed).
 */
export const resolveSeed = (choice: unknown, own: number, graphSeed: number, inputSeed: number | undefined): number => {
    if (choice === 'fixed') return shaderSeed(0, own);
    if (choice === 'input' && inputSeed !== undefined) return shaderSeed(inputSeed, own);
    return shaderSeed(graphSeed, own);
};

/** A node's size in pixels: its input's or the graph's scaled by powers of two, or fixed (2^w × 2^h). */
export const resolveSize = (
    mode: 'input' | 'graph' | 'absolute',
    own: { w: number; h: number } | undefined,
    input: { width: number; height: number } | undefined,
    graph: { width: number; height: number },
): { width: number; height: number } => {
    if (mode === 'absolute') return { width: 2 ** (own?.w ?? 10), height: 2 ** (own?.h ?? 10) };
    const base = mode === 'input' && input ? input : graph;
    return { width: base.width * 2 ** (own?.w ?? 0), height: base.height * 2 ** (own?.h ?? 0) };
};
