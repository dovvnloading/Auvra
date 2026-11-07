/**
 * PULLING ONE MATERIAL OUT OF A PHOTO
 *
 * A click on a photo picks the material there: the region grown from the click over everything that
 * looks like it, by colour and by texture, within a tolerance. Each pixel is judged by its
 * surroundings (a window a thirty-second of the photo across), not by itself: the colour there on
 * average (so a brick wall's red bricks and pale mortar read as one wall) and how much it varies (so a
 * smooth door beside a rough wall reads apart even in a like colour). The best square inside the region
 * (the largest, then the most evenly lit) is what the material is then made from, so a photo of a wall
 * with a door gives just the wall.
 *
 * Pictures here are rows of pixels, top row first, red green blue a pixel (sRGB, 0 to 1).
 */

export interface RegionPicture { rgb: Float32Array; width: number; height: number }

export interface RegionSquare { x: number; y: number; size: number }

export interface RegionPick {
    /** 1 for each pixel in the region. */
    mask: Uint8Array;
    /** The region's share of the picture. */
    share: number;
    /** The best square inside it, in pixels from the top left; null when there is none. */
    square: RegionSquare | null;
}

const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const labF = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);

/** A colour as L a b (L 0 to 100): distances in it are about as the eye sees them. */
const toLab = (r: number, g: number, b: number): [number, number, number] => {
    const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
    const x = labF((0.4124 * lr + 0.3576 * lg + 0.1805 * lb) / 0.95047);
    const y = labF(0.2126 * lr + 0.7152 * lg + 0.0722 * lb);
    const z = labF((0.0193 * lr + 0.1192 * lg + 0.9505 * lb) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
};

/** Sums over a picture's rectangles in constant time: a summed-area table (one row and column of zeros first). */
const summed = (values: Float64Array, width: number, height: number): Float64Array => {
    const table = new Float64Array((width + 1) * (height + 1));
    for (let y = 0; y < height; y++) {
        let row = 0;
        for (let x = 0; x < width; x++) {
            row += values[y * width + x];
            table[(y + 1) * (width + 1) + x + 1] = table[y * (width + 1) + x + 1] + row;
        }
    }
    return table;
};

/** The sum of a summed-area table's values over columns x0..x1 and rows y0..y1 (ends excluded), clamped to the picture. */
const sumOver = (table: Float64Array, width: number, height: number, x0: number, y0: number, x1: number, y1: number): [number, number] => {
    const ax = Math.max(0, x0), ay = Math.max(0, y0), bx = Math.min(width, x1), by = Math.min(height, y1);
    const stride = width + 1;
    const total = table[by * stride + bx] - table[ay * stride + bx] - table[by * stride + ax] + table[ay * stride + ax];
    return [total, Math.max(1, (bx - ax) * (by - ay))];
};

/** The window, in pixels each way, a pixel's surroundings are judged over. */
export const regionReach = (width: number, height: number) => Math.max(2, Math.round(Math.min(width, height) / 32));

interface Surroundings { colour: [Float32Array, Float32Array, Float32Array]; texture: Float32Array; reach: number }

/** Each pixel's surroundings: their average colour (L a b) and how much their lightness varies. */
const surroundingsOf = (picture: RegionPicture): Surroundings => {
    const { rgb, width, height } = picture;
    const n = width * height;
    const channels = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
    const squared = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const lab = toLab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
        for (let c = 0; c < 3; c++) channels[c][i] = lab[c];
        squared[i] = lab[0] * lab[0];
    }
    const tables = channels.map((values) => summed(values, width, height));
    const squares = summed(squared, width, height);
    const reach = regionReach(width, height);
    const colour: [Float32Array, Float32Array, Float32Array] = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    const texture = new Float32Array(n);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = y * width + x;
        for (let c = 0; c < 3; c++) {
            const [total, count] = sumOver(tables[c], width, height, x - reach, y - reach, x + reach + 1, y + reach + 1);
            colour[c][i] = total / count;
        }
        const [total, count] = sumOver(squares, width, height, x - reach, y - reach, x + reach + 1, y + reach + 1);
        texture[i] = Math.sqrt(Math.max(0, total / count - colour[0][i] * colour[0][i]));
    }
    return { colour, texture, reach };
};

/** The largest square of 1s in a mask, the most evenly lit (by `lightness`) where several are as large. */
export const bestSquare = (mask: Uint8Array, width: number, height: number, lightness?: Float32Array): RegionSquare | null => {
    const run = new Int32Array(width * height);
    let largest = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (!mask[i]) continue;
        run[i] = x === 0 || y === 0 ? 1 : 1 + Math.min(run[i - 1], run[i - width], run[i - width - 1]);
        largest = Math.max(largest, run[i]);
    }
    if (!largest) return null;
    let tables: [Float64Array, Float64Array] | null = null;
    if (lightness) {
        const values = Float64Array.from(lightness);
        tables = [summed(values, width, height), summed(values.map((v) => v * v), width, height)];
    }
    let best: RegionSquare | null = null;
    let bestSpread = Infinity;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (run[y * width + x] < largest) continue;
        const square = { x: x - largest + 1, y: y - largest + 1, size: largest };
        let spread = 0;
        if (tables) {
            const [total, count] = sumOver(tables[0], width, height, square.x, square.y, x + 1, y + 1);
            const [squares] = sumOver(tables[1], width, height, square.x, square.y, x + 1, y + 1);
            spread = squares / count - (total / count) ** 2;
        }
        if (spread < bestSpread) { bestSpread = spread; best = square; }
    }
    return best;
};

/**
 * Small holes the region encloses (a stain, a fixing: under a hundredth of the picture, not reached from
 * its edge) put in; larger ones, such as a window in a wall, stay out.
 */
const filled = (mask: Uint8Array, width: number, height: number): Uint8Array => {
    const out = Uint8Array.from(mask);
    const seen = new Uint8Array(width * height);
    const limit = Math.max(4, Math.floor(width * height * 0.01));
    for (let start = 0; start < width * height; start++) {
        if (mask[start] || seen[start]) continue;
        // One gap in the region: its pixels, and whether it reaches the picture's edge.
        const gap = [start];
        seen[start] = 1;
        let open = false;
        for (let k = 0; k < gap.length; k++) {
            const i = gap[k];
            const x = i % width, y = (i - x) / width;
            if (x === 0 || y === 0 || x === width - 1 || y === height - 1) open = true;
            const visit = (j: number) => { if (!mask[j] && !seen[j]) { seen[j] = 1; gap.push(j); } };
            if (x > 0) visit(i - 1);
            if (x < width - 1) visit(i + 1);
            if (y > 0) visit(i - width);
            if (y < height - 1) visit(i + width);
        }
        if (!open && gap.length <= limit) for (const i of gap) out[i] = 1;
    }
    return out;
};

/**
 * A mask shrunk by `reach` pixels (square) away from what it leaves out, so a square inside it keeps clear
 * of what the windows smeared in. The picture's own edge is no such border: the region may run to it.
 */
const shrunk = (mask: Uint8Array, width: number, height: number, reach: number): Uint8Array => {
    const table = summed(Float64Array.from(mask), width, height);
    const out = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const [total, count] = sumOver(table, width, height, x - reach, y - reach, x + reach + 1, y + reach + 1);
        if (total >= count) out[y * width + x] = 1;
    }
    return out;
};

/**
 * The region of `picture` that looks like it does at (`x`, `y`) (pixels from the top left), grown from
 * there; `tolerance` 0 takes in only what is very like it, 1 much that differs. Holes inside it (a
 * stain, a fixing) are put in. Its best square keeps clear of its edge by the window's reach.
 */
export const pickRegion = (picture: RegionPicture, x: number, y: number, tolerance: number): RegionPick => {
    const { width, height } = picture;
    const t = Math.min(1, Math.max(0, tolerance));
    const surroundings = surroundingsOf(picture);
    const { colour, texture, reach } = surroundings;
    const sx = Math.min(width - 1, Math.max(0, Math.round(x))), sy = Math.min(height - 1, Math.max(0, Math.round(y)));
    const seed = sy * width + sx;
    const seedColour = [colour[0][seed], colour[1][seed], colour[2][seed]];
    const seedTexture = texture[seed];
    const colourLimit = 3 + 22 * t;
    const textureLimit = 1 + 4 * t + (0.15 + 0.5 * t) * seedTexture;
    const like = (i: number) => {
        const d = Math.hypot(colour[0][i] - seedColour[0], colour[1][i] - seedColour[1], colour[2][i] - seedColour[2]);
        return d <= colourLimit && Math.abs(texture[i] - seedTexture) <= textureLimit;
    };
    const grown = new Uint8Array(width * height);
    const stack = [seed];
    grown[seed] = 1;
    while (stack.length) {
        const i = stack.pop()!;
        const px = i % width, py = (i - px) / width;
        const visit = (j: number) => { if (!grown[j] && like(j)) { grown[j] = 1; stack.push(j); } };
        if (px > 0) visit(i - 1);
        if (px < width - 1) visit(i + 1);
        if (py > 0) visit(i - width);
        if (py < height - 1) visit(i + width);
    }
    const mask = filled(grown, width, height);
    let area = 0;
    for (let i = 0; i < mask.length; i++) area += mask[i];
    const inner = shrunk(mask, width, height, reach);
    const square = bestSquare(inner.some((value) => value) ? inner : mask, width, height, colour[0]);
    return { mask, share: area / (width * height), square };
};

/**
 * How much more of the world a picture cropped from a photo `width` × `height` stands for after its crop
 * changes from `before` to `after` (each a crop size, a share of the photo across and down). The graph
 * fills its square with the crop, cut to fit, so what it shows is a square as wide as the crop's shorter
 * side: a square half that side shows half as much of the wall, at twice the size, unless the graph's size
 * in the world is halved with it.
 */
export const cropScale = (before: readonly [number, number], after: readonly [number, number], width: number, height: number): number => {
    const side = (crop: readonly [number, number]) => Math.max(1e-6, Math.min(crop[0] * width, crop[1] * height));
    return side(after) / side(before);
};
