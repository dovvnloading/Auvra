/**
 * HOW WIDE A PICTURE'S BRIGHT AND DARK SHAPES ARE
 *
 * Crevices (mortar, grout, cracks) are thin lines and the faces between them broad blocks, so which of a
 * picture's bright and dark parts makes the thinner shapes says which are the low ones: the photo
 * material's invert guess asks it of a photo's brightness, multi-angle capture of a recovered height.
 */

/** A light blur (1 2 1 across and down, edges held), so single grains of a photo don't count as shapes. */
const lightBlur = (values: ArrayLike<number>, width: number, height: number): Float32Array => {
    const across = new Float32Array(width * height);
    const blurred = new Float32Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = y * width + x;
        across[i] = (values[y * width + Math.max(x - 1, 0)] + 2 * values[i] + values[y * width + Math.min(x + 1, width - 1)]) / 4;
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = y * width + x;
        blurred[i] = (across[Math.max(y - 1, 0) * width + x] + 2 * across[i] + across[Math.min(y + 1, height - 1) * width + x]) / 4;
    }
    return blurred;
};

/**
 * How wide the shapes a set of pixels makes are, on average: twice its area over the length of its edge.
 * A line comes out as its width, a block as about half its shorter side. Null when the set is too small
 * a share of the picture to tell.
 */
const shapeWidth = (values: Float32Array, width: number, height: number, inSet: (value: number) => boolean): number | null => {
    let area = 0;
    let edge = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const here = inSet(values[i]);
        if (here) area++;
        if (x + 1 < width && here !== inSet(values[i + 1])) edge++;
        if (y + 1 < height && here !== inSet(values[i + width])) edge++;
    }
    return area >= width * height * 0.01 && edge > 0 ? (2 * area) / edge : null;
};

/**
 * How wide the shapes of a picture's bright parts and of its dark parts are (see shapeWidth), as the
 * invert guess measures them: lightly blurred, bright and dark a quarter of the range either side of its
 * middle (the range from the 5th to the 95th percentile). Either is null when there is too little of it.
 */
export const brightAndDarkWidths = (values: ArrayLike<number>, width = Math.round(Math.sqrt(values.length))): { bright: number | null; dark: number | null } => {
    const height = width > 0 ? Math.floor(values.length / width) : 0;
    if (width < 8 || height < 8) return { bright: null, dark: null };
    const blurred = lightBlur(values, width, height);
    const sorted = Float32Array.from(blurred).sort();
    const low = sorted[Math.floor(sorted.length * 0.05)];
    const high = sorted[Math.floor(sorted.length * 0.95)];
    const middle = (low + high) / 2;
    const quarter = (high - low) / 4;
    if (quarter < 1e-3) return { bright: null, dark: null };
    return {
        bright: shapeWidth(blurred, width, height, (value) => value > middle + quarter),
        dark: shapeWidth(blurred, width, height, (value) => value < middle - quarter),
    };
};
