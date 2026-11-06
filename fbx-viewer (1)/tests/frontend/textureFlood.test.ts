import { describe, expect, it } from 'vitest';
import { labelReference, packBoxSize, shortestOffset, unpackBoxSize } from '../../texturing/graph/flood';

/** A mask from rows of text, the first row at the bottom as the GPU reads it ('#' inside). */
const maskOf = (rows: string[]) => {
    const width = rows[0].length;
    const height = rows.length;
    const values = new Float32Array(width * height);
    rows.forEach((row, y) => [...row].forEach((char, x) => { values[y * width + x] = char === '#' ? 1 : 0; }));
    return { values, width, height };
};

/** How many islands the labels make, and whether two places share one. */
const islands = (labels: Int32Array) => new Set([...labels].filter((label) => label >= 0)).size;

/** Islands by a plain flood from each pixel, for comparing. */
const floodIslands = (values: ArrayLike<number>, width: number, height: number): number => {
    const seen = new Uint8Array(width * height);
    let count = 0;
    for (let start = 0; start < width * height; start++) {
        if (seen[start] || values[start] < 0.5) continue;
        count++;
        const stack = [start];
        seen[start] = 1;
        while (stack.length) {
            const i = stack.pop()!;
            const x = i % width;
            const y = Math.floor(i / width);
            for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
                if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                const n = ny * width + nx;
                if (!seen[n] && values[n] >= 0.5) { seen[n] = 1; stack.push(n); }
            }
        }
    }
    return count;
};

describe('flood fill labelling', () => {
    it('labels separate islands apart, each by its first pixel', () => {
        const { values, width, height } = maskOf(['##..#', '##..#', '.....', '###..']);
        const { labels } = labelReference(values, width, height);
        expect(islands(labels)).toBe(3);
        expect(labels[0]).toBe(0);
        expect(labels[6]).toBe(0);
        expect(labels[4]).toBe(4);
        expect(labels[9]).toBe(4);
        expect(labels[15]).toBe(15);
        expect(labels[10]).toBe(-1);
    });

    it('keeps diagonal neighbours apart (four-way connection) and holes inside a ring', () => {
        expect(islands(labelReference(maskOf(['#.', '.#']).values, 2, 2).labels)).toBe(2);
        const ring = maskOf(['#####', '#...#', '#.#.#', '#...#', '#####']);
        const { labels } = labelReference(ring.values, 5, 5);
        expect(islands(labels)).toBe(2);
        expect(labels[12]).toBe(12);
        expect(labels[24]).toBe(0);
    });

    it('joins an island across the edge where the image repeats, and not where it does not', () => {
        const edge = maskOf(['#...#', '#...#']);
        expect(islands(labelReference(edge.values, 5, 2, [false, false]).labels)).toBe(2);
        expect(islands(labelReference(edge.values, 5, 2, [true, false]).labels)).toBe(1);
        expect(islands(labelReference(edge.values, 5, 2, [false, true]).labels)).toBe(2);
    });

    it('settles winding islands, and agrees with a plain flood on a noisy mask', () => {
        const snake = maskOf(['#########', '........#', '#########', '#........', '#########']);
        const settled = labelReference(snake.values, 9, 5);
        expect(islands(settled.labels)).toBe(1);
        let seed = 12345;
        const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
        const width = 40;
        const height = 30;
        const noise = Float32Array.from({ length: width * height }, () => (random() < 0.55 ? 1 : 0));
        const { labels, rounds } = labelReference(noise, width, height);
        expect(islands(labels)).toBe(floodIslands(noise, width, height));
        // Pointer jumping keeps the rounds far below the pixels an island could chain through.
        expect(rounds).toBeLessThan(width * height / 4);
    });
});

describe('flood fill boxes', () => {
    it('takes offsets the short way round only along repeating axes', () => {
        expect(shortestOffset(90, 100, true)).toBe(-10);
        expect(shortestOffset(90, 100, false)).toBe(90);
        expect(shortestOffset(-60, 100, true)).toBe(40);
    });

    it('packs a box\'s size into one float exactly, to a 4095th of the image', () => {
        const packed = packBoxSize(128, 64, 1024, 1024);
        expect(packed).toBeLessThan(2 ** 24);
        expect(Math.fround(packed)).toBe(packed);
        const [w, h] = unpackBoxSize(packed);
        expect(w * 1024).toBeCloseTo(128, 0);
        expect(h * 1024).toBeCloseTo(64, 0);
        expect(unpackBoxSize(packBoxSize(1024, 1024, 1024, 1024))).toEqual([1, 1]);
    });
});
