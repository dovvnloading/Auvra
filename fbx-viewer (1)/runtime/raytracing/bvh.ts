/**
 * BOUNDING VOLUME HIERARCHY
 *
 * A tree of boxes over a set of primitives, in the flat form a shader can walk: each node takes 8 floats,
 *   min x, y, z, then the left child (an interior node) or the first primitive (a leaf)
 *   max x, y, z, then how many primitives it holds (0 for an interior node)
 * The right child always follows the left one, and a parent always comes before its children, so a tree can
 * be refitted in a single pass from the back.
 */

export const NODE_FLOATS = 8;
/** Six floats per primitive's box: min x, y, z, max x, y, z. */
export const BOUNDS_FLOATS = 6;

/** The count of a leaf holding nothing: not 0, which means an interior node. */
const EMPTY_LEAF = -1;
const BINS = 16;
const TRAVERSAL_COST = 1;
const PRIMITIVE_COST = 1.5;

export interface Bvh {
    /** NODE_FLOATS per node; the root is node 0. */
    nodes: Float32Array;
    nodeCount: number;
    /** Primitive indices in leaf order: a leaf's `first` and `count` are a range of this. */
    order: Uint32Array;
}

const surface = (dx: number, dy: number, dz: number): number => (dx < 0 || dy < 0 || dz < 0 ? 0 : 2 * (dx * dy + dy * dz + dz * dx));

/**
 * Builds a tree over `count` boxes by binned surface area: at each node, along the longest axis of the box
 * around the primitives' centres, the split that makes the cheapest pair of children. A node whose best split
 * costs more than testing what it holds stays a leaf, up to `maxLeaf` primitives; past that it is cut anyway.
 */
export const buildBvh = (bounds: Float32Array, count: number, maxLeaf = 4): Bvh => {
    const order = new Uint32Array(count);
    for (let index = 0; index < count; index++) order[index] = index;
    // A binary tree over n leaves has fewer than 2n nodes.
    const nodes = new Float32Array(Math.max(1, 2 * count) * NODE_FLOATS);
    const centres = new Float32Array(count * 3);
    for (let index = 0; index < count; index++) {
        const from = index * BOUNDS_FLOATS;
        centres[index * 3] = (bounds[from] + bounds[from + 3]) * 0.5;
        centres[index * 3 + 1] = (bounds[from + 1] + bounds[from + 4]) * 0.5;
        centres[index * 3 + 2] = (bounds[from + 2] + bounds[from + 5]) * 0.5;
    }

    const binCount = new Int32Array(BINS);
    const binBounds = new Float32Array(BINS * BOUNDS_FLOATS);
    const rightArea = new Float64Array(BINS);

    let nodeCount = 1;
    // Pending nodes: index, first primitive, count.
    const pending: number[] = [0, 0, count];
    while (pending.length) {
        const span = pending.pop()!;
        const first = pending.pop()!;
        const node = pending.pop()!;
        let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        let lowX = Infinity, lowY = Infinity, lowZ = Infinity, highX = -Infinity, highY = -Infinity, highZ = -Infinity;
        for (let at = first; at < first + span; at++) {
            const primitive = order[at];
            const from = primitive * BOUNDS_FLOATS;
            if (bounds[from] < minX) minX = bounds[from];
            if (bounds[from + 1] < minY) minY = bounds[from + 1];
            if (bounds[from + 2] < minZ) minZ = bounds[from + 2];
            if (bounds[from + 3] > maxX) maxX = bounds[from + 3];
            if (bounds[from + 4] > maxY) maxY = bounds[from + 4];
            if (bounds[from + 5] > maxZ) maxZ = bounds[from + 5];
            const cx = centres[primitive * 3], cy = centres[primitive * 3 + 1], cz = centres[primitive * 3 + 2];
            if (cx < lowX) lowX = cx;
            if (cy < lowY) lowY = cy;
            if (cz < lowZ) lowZ = cz;
            if (cx > highX) highX = cx;
            if (cy > highY) highY = cy;
            if (cz > highZ) highZ = cz;
        }
        const offset = node * NODE_FLOATS;
        if (span === 0) {
            // A tree over nothing: a leaf that holds no primitives, in a box no bigger than a point.
            nodes[offset + 3] = 0;
            nodes[offset + 7] = EMPTY_LEAF;
            continue;
        }
        nodes[offset] = minX;
        nodes[offset + 1] = minY;
        nodes[offset + 2] = minZ;
        nodes[offset + 4] = maxX;
        nodes[offset + 5] = maxY;
        nodes[offset + 6] = maxZ;

        const extentX = highX - lowX, extentY = highY - lowY, extentZ = highZ - lowZ;
        const axis = extentX >= extentY && extentX >= extentZ ? 0 : extentY >= extentZ ? 1 : 2;
        const low = axis === 0 ? lowX : axis === 1 ? lowY : lowZ;
        const extent = axis === 0 ? extentX : axis === 1 ? extentY : extentZ;

        let split = -1;
        let middle = first;
        if (span > 1 && extent > 1e-7) {
            const toBin = BINS / extent;
            binCount.fill(0);
            binBounds.fill(0);
            for (let bin = 0; bin < BINS; bin++) {
                const from = bin * BOUNDS_FLOATS;
                binBounds[from] = binBounds[from + 1] = binBounds[from + 2] = Infinity;
                binBounds[from + 3] = binBounds[from + 4] = binBounds[from + 5] = -Infinity;
            }
            for (let at = first; at < first + span; at++) {
                const primitive = order[at];
                const bin = Math.min(BINS - 1, Math.floor((centres[primitive * 3 + axis] - low) * toBin));
                binCount[bin]++;
                const to = bin * BOUNDS_FLOATS;
                const from = primitive * BOUNDS_FLOATS;
                for (let k = 0; k < 3; k++) {
                    if (bounds[from + k] < binBounds[to + k]) binBounds[to + k] = bounds[from + k];
                    if (bounds[from + 3 + k] > binBounds[to + 3 + k]) binBounds[to + 3 + k] = bounds[from + 3 + k];
                }
            }
            // Sweep from the right for each split's right side, then from the left to compare them.
            let rMinX = Infinity, rMinY = Infinity, rMinZ = Infinity, rMaxX = -Infinity, rMaxY = -Infinity, rMaxZ = -Infinity;
            for (let bin = BINS - 1; bin > 0; bin--) {
                const from = bin * BOUNDS_FLOATS;
                if (binCount[bin]) {
                    rMinX = Math.min(rMinX, binBounds[from]);
                    rMinY = Math.min(rMinY, binBounds[from + 1]);
                    rMinZ = Math.min(rMinZ, binBounds[from + 2]);
                    rMaxX = Math.max(rMaxX, binBounds[from + 3]);
                    rMaxY = Math.max(rMaxY, binBounds[from + 4]);
                    rMaxZ = Math.max(rMaxZ, binBounds[from + 5]);
                }
                rightArea[bin] = surface(rMaxX - rMinX, rMaxY - rMinY, rMaxZ - rMinZ);
            }
            let lMinX = Infinity, lMinY = Infinity, lMinZ = Infinity, lMaxX = -Infinity, lMaxY = -Infinity, lMaxZ = -Infinity;
            let leftCount = 0;
            let bestCost = Infinity;
            for (let bin = 0; bin < BINS - 1; bin++) {
                const from = bin * BOUNDS_FLOATS;
                if (binCount[bin]) {
                    lMinX = Math.min(lMinX, binBounds[from]);
                    lMinY = Math.min(lMinY, binBounds[from + 1]);
                    lMinZ = Math.min(lMinZ, binBounds[from + 2]);
                    lMaxX = Math.max(lMaxX, binBounds[from + 3]);
                    lMaxY = Math.max(lMaxY, binBounds[from + 4]);
                    lMaxZ = Math.max(lMaxZ, binBounds[from + 5]);
                }
                leftCount += binCount[bin];
                const rightCount = span - leftCount;
                if (!leftCount || !rightCount) continue;
                const cost = surface(lMaxX - lMinX, lMaxY - lMinY, lMaxZ - lMinZ) * leftCount + rightArea[bin + 1] * rightCount;
                if (cost < bestCost) {
                    bestCost = cost;
                    split = bin;
                }
            }
            const parentArea = surface(maxX - minX, maxY - minY, maxZ - minZ);
            const worthIt = parentArea <= 0 || TRAVERSAL_COST + (PRIMITIVE_COST * bestCost) / parentArea < PRIMITIVE_COST * span;
            if (split >= 0 && (worthIt || span > maxLeaf)) {
                let left = first;
                let right = first + span - 1;
                while (left <= right) {
                    const bin = Math.min(BINS - 1, Math.floor((centres[order[left] * 3 + axis] - low) * toBin));
                    if (bin <= split) {
                        left++;
                    } else {
                        const swap = order[left];
                        order[left] = order[right];
                        order[right] = swap;
                        right--;
                    }
                }
                middle = left;
            } else {
                split = -1;
            }
        }
        if (split < 0 && span > maxLeaf) {
            // Centres all in one place, or no split between them: cut in half regardless, so leaves stay small.
            split = 0;
            middle = first + (span >> 1);
        }
        if (split < 0) {
            nodes[offset + 3] = first;
            nodes[offset + 7] = span;
            continue;
        }
        const leftChild = nodeCount;
        nodeCount += 2;
        nodes[offset + 3] = leftChild;
        nodes[offset + 7] = 0;
        pending.push(leftChild + 1, middle, first + span - middle);
        pending.push(leftChild, first, middle - first);
    }
    return { nodes: nodes.subarray(0, nodeCount * NODE_FLOATS), nodeCount, order };
};

/** Fits every box of `bvh` to the primitives' new `bounds`, keeping its shape: far quicker than building it again. */
export const refitBvh = (bvh: Bvh, bounds: Float32Array): void => {
    const { nodes, order } = bvh;
    for (let node = bvh.nodeCount - 1; node >= 0; node--) {
        const offset = node * NODE_FLOATS;
        const count = nodes[offset + 7];
        if (count === EMPTY_LEAF) continue;
        let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        if (count > 0) {
            const first = nodes[offset + 3];
            for (let at = first; at < first + count; at++) {
                const from = order[at] * BOUNDS_FLOATS;
                minX = Math.min(minX, bounds[from]);
                minY = Math.min(minY, bounds[from + 1]);
                minZ = Math.min(minZ, bounds[from + 2]);
                maxX = Math.max(maxX, bounds[from + 3]);
                maxY = Math.max(maxY, bounds[from + 4]);
                maxZ = Math.max(maxZ, bounds[from + 5]);
            }
        } else {
            const left = nodes[offset + 3] * NODE_FLOATS;
            const right = left + NODE_FLOATS;
            minX = Math.min(nodes[left], nodes[right]);
            minY = Math.min(nodes[left + 1], nodes[right + 1]);
            minZ = Math.min(nodes[left + 2], nodes[right + 2]);
            maxX = Math.max(nodes[left + 4], nodes[right + 4]);
            maxY = Math.max(nodes[left + 5], nodes[right + 5]);
            maxZ = Math.max(nodes[left + 6], nodes[right + 6]);
        }
        nodes[offset] = minX;
        nodes[offset + 1] = minY;
        nodes[offset + 2] = minZ;
        nodes[offset + 4] = maxX;
        nodes[offset + 5] = maxY;
        nodes[offset + 6] = maxZ;
    }
};

/** Where a ray enters a box before `limit`, or Infinity if it misses. */
const enterBox = (nodes: Float32Array, offset: number, ox: number, oy: number, oz: number, ix: number, iy: number, iz: number, limit: number): number => {
    const t1x = (nodes[offset] - ox) * ix, t2x = (nodes[offset + 4] - ox) * ix;
    const t1y = (nodes[offset + 1] - oy) * iy, t2y = (nodes[offset + 5] - oy) * iy;
    const t1z = (nodes[offset + 2] - oz) * iz, t2z = (nodes[offset + 6] - oz) * iz;
    const near = Math.max(Math.min(t1x, t2x), Math.min(t1y, t2y), Math.min(t1z, t2z), 0);
    const far = Math.min(Math.max(t1x, t2x), Math.max(t1y, t2y), Math.max(t1z, t2z), limit);
    return near <= far ? near : Infinity;
};

/**
 * Walks `bvh` as the shader does (traceShader.ts): nearer child first. `visit` tests one primitive and returns
 * the distance to it, or Infinity. Returns the closest primitive, or -1.
 */
export const closestPrimitive = (
    bvh: Bvh,
    origin: readonly [number, number, number],
    direction: readonly [number, number, number],
    visit: (primitive: number, limit: number) => number,
    limit = Infinity,
): { primitive: number; distance: number; nodesVisited: number } => {
    const { nodes, order } = bvh;
    const [ox, oy, oz] = origin;
    const ix = 1 / direction[0], iy = 1 / direction[1], iz = 1 / direction[2];
    let closest = limit;
    let primitive = -1;
    let nodesVisited = 1;
    const stack: number[] = [];
    let node: number | undefined = enterBox(nodes, 0, ox, oy, oz, ix, iy, iz, closest) < Infinity ? 0 : undefined;
    while (node !== undefined) {
        const offset = node * NODE_FLOATS;
        const count = nodes[offset + 7];
        if (count !== 0) {
            const first = nodes[offset + 3];
            for (let at = first; at < first + count; at++) {
                const distance = visit(order[at], closest);
                if (distance < closest) {
                    closest = distance;
                    primitive = order[at];
                }
            }
            node = stack.pop();
            continue;
        }
        const left = nodes[offset + 3];
        const right = left + 1;
        nodesVisited += 2;
        const toLeft = enterBox(nodes, left * NODE_FLOATS, ox, oy, oz, ix, iy, iz, closest);
        const toRight = enterBox(nodes, right * NODE_FLOATS, ox, oy, oz, ix, iy, iz, closest);
        if (toLeft === Infinity && toRight === Infinity) {
            node = stack.pop();
        } else if (toLeft === Infinity) {
            node = right;
        } else if (toRight === Infinity) {
            node = left;
        } else {
            node = toLeft <= toRight ? left : right;
            stack.push(toLeft <= toRight ? right : left);
        }
    }
    return { primitive, distance: closest, nodesVisited };
};
