/** What a proposed script changes, line by line, so each change can be kept or dropped on its own. */

export interface SameBlock {
  kind: 'same';
  lines: string[];
  /** 1-based line of the first of them, in the script as it stands and as proposed. */
  beforeLine: number;
  afterLine: number;
}

export interface ChangeBlock {
  kind: 'change';
  /** Counts up from 0, in the order they appear. */
  id: number;
  removed: string[];
  added: string[];
  beforeLine: number;
  afterLine: number;
}

export type ScriptDiffBlock = SameBlock | ChangeBlock;

/** Past this many line pairs a change is shown whole rather than worked through: a rewrite reads no better split up. */
const MAX_COMPARED_PAIRS = 4_000_000;

/** Which lines of the two lists stay, as pairs of indexes, by longest common subsequence. */
const commonLines = (before: readonly string[], after: readonly string[]): [number, number][] => {
  const width = after.length + 1;
  const lengths = new Uint16Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      lengths[i * width + j] = before[i] === after[j]
        ? lengths[(i + 1) * width + j + 1] + 1
        : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) { pairs.push([i, j]); i += 1; j += 1; }
    else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) i += 1;
    else j += 1;
  }
  return pairs;
};

/** The proposal ending as the script does: an answer's closing newline says nothing about what was asked for. */
export const withEndingOf = (before: string, after: string): string => {
  const ending = /\n*$/.exec(before)?.[0] ?? '';
  return after.replace(/\n*$/, '') + ending;
};

/** The two scripts as stretches that stay and changes between them. Taking every change gives `after`; none, `before`. */
export const diffScript = (before: string, after: string): ScriptDiffBlock[] => {
  const from = before.split('\n');
  const to = after.split('\n');
  let start = 0;
  while (start < from.length && start < to.length && from[start] === to[start]) start += 1;
  let endFrom = from.length;
  let endTo = to.length;
  while (endFrom > start && endTo > start && from[endFrom - 1] === to[endTo - 1]) { endFrom -= 1; endTo -= 1; }

  const middleFrom = from.slice(start, endFrom);
  const middleTo = to.slice(start, endTo);
  // Filling an empty script is one change, whatever blank lines the two have in common.
  const pairs = before.trim() && middleFrom.length * middleTo.length <= MAX_COMPARED_PAIRS ? commonLines(middleFrom, middleTo) : [];

  const blocks: ScriptDiffBlock[] = [];
  let changes = 0;
  const same = (fromIndex: number, toIndex: number, count: number) => {
    if (!count) return;
    const last = blocks[blocks.length - 1];
    if (last?.kind === 'same') last.lines.push(...from.slice(fromIndex, fromIndex + count));
    else blocks.push({ kind: 'same', lines: from.slice(fromIndex, fromIndex + count), beforeLine: fromIndex + 1, afterLine: toIndex + 1 });
  };
  const change = (fromIndex: number, fromEnd: number, toIndex: number, toEnd: number) => {
    if (fromIndex === fromEnd && toIndex === toEnd) return;
    blocks.push({ kind: 'change', id: changes, removed: from.slice(fromIndex, fromEnd), added: to.slice(toIndex, toEnd), beforeLine: fromIndex + 1, afterLine: toIndex + 1 });
    changes += 1;
  };

  same(0, 0, start);
  let i = start;
  let j = start;
  for (const [a, b] of pairs) {
    change(i, start + a, j, start + b);
    same(start + a, start + b, 1);
    i = start + a + 1;
    j = start + b + 1;
  }
  change(i, endFrom, j, endTo);
  same(endFrom, endTo, from.length - endFrom);
  return blocks;
};

export const changesIn = (blocks: readonly ScriptDiffBlock[]): ChangeBlock[] => blocks.filter((block): block is ChangeBlock => block.kind === 'change');

/** The script with the changes in `kept` taken and the others left as they were. */
export const applyKeptChanges = (blocks: readonly ScriptDiffBlock[], kept: ReadonlySet<number>): string => blocks
  .flatMap((block) => (block.kind === 'same' ? block.lines : kept.has(block.id) ? block.added : block.removed))
  .join('\n');
