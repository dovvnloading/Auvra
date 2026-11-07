/**
 * MULTI-ANGLE CAPTURE: A SURFACE'S NORMAL AND COLOUR FROM PHOTOS LIT FROM DIFFERENT SIDES
 *
 * Three to eight photos of one flat surface, taken from the same spot with the light from a different
 * side each time. A matte surface's brightness in a photo is its colour times how squarely it faces
 * that photo's light (the cosine between its normal and the light), so a pixel seen under three or more
 * known lights gives its normal and colour by least squares (photometric stereo). The light directions
 * are worked out from the photos themselves when not given; the height is the normal integrated.
 *
 * Pictures here are rows of pixels, top row first, as a canvas gives them. Directions use x to the
 * right, y up the picture and z out of it (a normal map's usual green-up convention). A light's
 * azimuth is its direction round the picture (0 from the right, a quarter turn from the top); its
 * elevation how high it stands over the surface.
 */

export interface CapturePhoto {
    /** Red, green and blue a pixel, 0 to 1 as stored (sRGB). */
    rgb: Float32Array;
}

export interface CaptureMaps {
    width: number;
    height: number;
    /** The surface's own colour, evenly lit: red, green and blue a pixel (sRGB, 0 to 1). */
    albedo: Float32Array;
    /** Unit normals, x y z a pixel. */
    normal: Float32Array;
}

export type Vec3 = [number, number, number];

/** A light's direction (towards it) from its azimuth and elevation, in radians. */
export const lightDirection = (azimuth: number, elevation: number): Vec3 => [Math.cos(elevation) * Math.cos(azimuth), Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation)];

const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Every pixel's brightness, as light (linear), from a photo's stored colours. */
export const linearBrightness = (photo: CapturePhoto): Float32Array => {
    const out = new Float32Array(photo.rgb.length / 3);
    for (let i = 0; i < out.length; i++) out[i] = luma(srgbToLinear(photo.rgb[i * 3]), srgbToLinear(photo.rgb[i * 3 + 1]), srgbToLinear(photo.rgb[i * 3 + 2]));
    return out;
};

// ---- small linear algebra ----

/** Eigenvalues and eigenvectors of a symmetric matrix (rows), by Jacobi rotations: vectors are columns of `vectors`, largest value first. */
export const symmetricEigen = (matrix: readonly (readonly number[])[]): { values: number[]; vectors: number[][] } => {
    const n = matrix.length;
    const a = matrix.map((row) => [...row]);
    const v: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
    for (let sweep = 0; sweep < 60; sweep++) {
        let off = 0;
        for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
        if (off < 1e-22) break;
        for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
            if (Math.abs(a[p][q]) < 1e-30) continue;
            const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
            const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
            const c = 1 / Math.sqrt(t * t + 1);
            const s = t * c;
            for (let k = 0; k < n; k++) {
                const akp = a[k][p], akq = a[k][q];
                a[k][p] = c * akp - s * akq;
                a[k][q] = s * akp + c * akq;
            }
            for (let k = 0; k < n; k++) {
                const apk = a[p][k], aqk = a[q][k];
                a[p][k] = c * apk - s * aqk;
                a[q][k] = s * apk + c * aqk;
            }
            for (let k = 0; k < n; k++) {
                const vkp = v[k][p], vkq = v[k][q];
                v[k][p] = c * vkp - s * vkq;
                v[k][q] = s * vkp + c * vkq;
            }
        }
    }
    const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[j][j] - a[i][i]);
    return { values: order.map((i) => a[i][i]), vectors: v.map((row) => order.map((i) => row[i])) };
};

/** Solves a 3 × 3 system (rows), or null when it has no single answer. */
const solve3 = (m: readonly number[], b: readonly number[]): Vec3 | null => {
    const [a, bb, c, d, e, f, g, h, i] = m;
    const det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g);
    if (Math.abs(det) < 1e-12) return null;
    const x = (b[0] * (e * i - f * h) - bb * (b[1] * i - f * b[2]) + c * (b[1] * h - e * b[2])) / det;
    const y = (a * (b[1] * i - f * b[2]) - b[0] * (d * i - f * g) + c * (d * b[2] - b[1] * g)) / det;
    const z = (a * (e * b[2] - b[1] * h) - bb * (d * b[2] - b[1] * g) + b[0] * (d * h - e * g)) / det;
    return [x, y, z];
};

// ---- Fourier transforms (for integrating slopes into a height) ----

/** An in-place radix-2 FFT of `re`/`im` (length a power of two); `inverse` divides by the length. */
const fft = (re: Float64Array, im: Float64Array, inverse: boolean): void => {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
        }
    }
    for (let size = 2; size <= n; size <<= 1) {
        const angle = ((inverse ? 2 : -2) * Math.PI) / size;
        const wr = Math.cos(angle), wi = Math.sin(angle);
        const half = size >> 1;
        for (let start = 0; start < n; start += size) {
            let cr = 1, ci = 0;
            for (let k = 0; k < half; k++) {
                const a = start + k, b = a + half;
                const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr; im[b] = im[a] - ti;
                re[a] += tr; im[a] += ti;
                const next = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = next;
            }
        }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
};

/** A 2D FFT of rows `width` long (both sides powers of two), in place. */
const fft2 = (re: Float64Array, im: Float64Array, width: number, height: number, inverse: boolean): void => {
    const rowRe = new Float64Array(width), rowIm = new Float64Array(width);
    for (let y = 0; y < height; y++) {
        rowRe.set(re.subarray(y * width, (y + 1) * width));
        rowIm.set(im.subarray(y * width, (y + 1) * width));
        fft(rowRe, rowIm, inverse);
        re.set(rowRe, y * width);
        im.set(rowIm, y * width);
    }
    const colRe = new Float64Array(height), colIm = new Float64Array(height);
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) { colRe[y] = re[y * width + x]; colIm[y] = im[y * width + x]; }
        fft(colRe, colIm, inverse);
        for (let y = 0; y < height; y++) { re[y * width + x] = colRe[y]; im[y * width + x] = colIm[y]; }
    }
};

const isPowerOfTwo = (n: number) => n > 0 && (n & (n - 1)) === 0;

/**
 * The height whose slopes are closest to `slopeX` (rise a pixel to the right) and `slopeY` (rise a
 * pixel up the picture), solved over all frequencies at once (Frankot and Chellappa). A picture that
 * tiles is solved as it repeats; one that doesn't is mirrored each way first, so its edges don't pull.
 * Both sides must be powers of two. Heights in pixels, their mean 0.
 *
 * `keepFrom` (waves across the picture) takes out the broad drift integrating gathers from small errors
 * in the slopes: changes much slower than that many waves across fade out (a Gaussian high pass, as if a
 * wide blur were taken away), while the surface's own relief, finer, stays.
 */
export const integrateSlopes = (slopeX: Float32Array, slopeY: Float32Array, width: number, height: number, tiles: boolean, keepFrom = 0): Float32Array => {
    if (!isPowerOfTwo(width) || !isPowerOfTwo(height)) throw new Error('Slopes are integrated at a power-of-two size.');
    const w = tiles ? width : width * 2;
    const h = tiles ? height : height * 2;
    // Packed as one complex picture: x slopes real, slopes down the rows imaginary.
    const re = new Float64Array(w * h), im = new Float64Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const mirrorX = x >= width, mirrorY = y >= height;
        const sx = mirrorX ? w - 1 - x : x, sy = mirrorY ? h - 1 - y : y;
        const i = sy * width + sx;
        // Mirroring across a side turns the slope across it round.
        re[y * w + x] = slopeX[i] * (mirrorX ? -1 : 1);
        im[y * w + x] = -slopeY[i] * (mirrorY ? -1 : 1); // Rise a row down the picture.
    }
    fft2(re, im, w, h, false);
    const outRe = new Float64Array(w * h), outIm = new Float64Array(w * h);
    for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) {
        const k = v * w + u;
        const mirror = ((h - v) % h) * w + ((w - u) % w);
        // The two real pictures' spectra, unpacked.
        const pRe = (re[k] + re[mirror]) / 2, pIm = (im[k] - im[mirror]) / 2;
        const qRe = (im[k] + im[mirror]) / 2, qIm = -(re[k] - re[mirror]) / 2;
        const wx = (2 * Math.PI * (u <= w / 2 ? u : u - w)) / w;
        const wy = (2 * Math.PI * (v <= h / 2 ? v : v - h)) / h;
        const d = wx * wx + wy * wy;
        if (d === 0) continue;
        // Waves across the picture itself (a mirrored copy holds it twice).
        const waves = Math.hypot(((u <= w / 2 ? u : u - w) * width) / w, ((v <= h / 2 ? v : v - h) * height) / h);
        const keep = keepFrom > 0 ? 1 - Math.exp(-((waves / keepFrom) ** 2)) : 1;
        // H = -i (wx P + wy Q) / |w|^2
        const sRe = wx * pRe + wy * qRe, sIm = wx * pIm + wy * qIm;
        outRe[k] = (sIm / d) * keep;
        outIm[k] = (-sRe / d) * keep;
    }
    fft2(outRe, outIm, w, h, true);
    const result = new Float32Array(width * height);
    let mean = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) mean += result[y * width + x] = outRe[y * w + x];
    mean /= width * height;
    for (let i = 0; i < result.length; i++) result[i] -= mean;
    return result;
};

/** The height of a normal map (unit normals x y z a pixel), in pixels: see integrateSlopes. */
export const heightFromNormals = (normal: Float32Array, width: number, height: number, tiles: boolean, keepFrom = 0): Float32Array => {
    const slopeX = new Float32Array(width * height), slopeY = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) {
        const nz = Math.max(normal[i * 3 + 2], 0.1);
        slopeX[i] = -normal[i * 3] / nz;
        slopeY[i] = -normal[i * 3 + 1] / nz;
    }
    return integrateSlopes(slopeX, slopeY, width, height, tiles, keepFrom);
};

// ---- the light directions, from the photos ----

/** A picture box-averaged down to at most `limit` across, by whole steps. */
const shrink = (values: Float32Array, width: number, height: number, limit: number) => {
    const step = Math.max(1, Math.ceil(Math.max(width, height) / limit));
    const w = Math.floor(width / step), h = Math.floor(height / step);
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let j = 0; j < step; j++) for (let i = 0; i < step; i++) sum += values[(y * step + j) * width + x * step + i];
        out[y * w + x] = sum / (step * step);
    }
    return { data: out, width: w, height: h };
};

/** A three-by-three box blur, edges held. */
const box3 = (values: Float32Array, width: number, height: number): Float32Array => {
    const out = new Float32Array(values.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        let sum = 0;
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) sum += values[Math.min(height - 1, Math.max(0, y + j)) * width + Math.min(width - 1, Math.max(0, x + i))];
        out[y * width + x] = sum / 9;
    }
    return out;
};

export interface LightEstimate {
    /** Each photo's light azimuth, in radians. */
    azimuths: number[];
    /**
     * How much of the photos' differences the lights explain (0 to 1): low when the photos hardly
     * differ, or differ by more than the light (moved camera, changing scene).
     */
    fit: number;
}

/**
 * Each photo's light azimuth, worked out from the photos (their linear brightness, rows `width` long).
 * Where a surface faces a light it is brighter than its average over all the photos, by an amount in
 * proportion to its slope towards that light; so the photos' differences from their average span two
 * pictures, the height's two slopes mixed by the lights. The mix that makes those two pictures the
 * slopes of one height (they must not curl) gives the lights' directions, up to turning them all half
 * round (the same photos come from a relief turned inside out). That is settled by taking the parts dark
 * on average to be the low ones: crevices catch less light whichever side it comes from.
 */
export const estimateLightAzimuths = (brightness: readonly Float32Array[], width: number, height: number): LightEstimate => {
    const count = brightness.length;
    if (count < 2) return { azimuths: brightness.map(() => 0), fit: 0 };
    // Worked out on a small copy: the lights are the same all over.
    const small = brightness.map((photo) => shrink(photo, width, height, 128));
    const w = small[0].width, h = small[0].height, n = w * h;
    // Each photo's exposure taken out, then each pixel's difference from the photos' average.
    const photos = small.map(({ data }) => {
        let mean = 0;
        for (let i = 0; i < n; i++) mean += data[i];
        mean = Math.max(mean / n, 1e-6);
        return data.map((value) => value / mean);
    });
    const average = new Float32Array(n);
    for (const photo of photos) for (let i = 0; i < n; i++) average[i] += photo[i] / count;
    const differences = photos.map((photo) => box3(photo.map((value, i) => value / Math.max(average[i], 1e-4) - 1), w, h));
    // The two pictures that carry most of the differences.
    const covariance = differences.map((a) => differences.map((b) => { let sum = 0; for (let i = 0; i < n; i++) sum += a[i] * b[i]; return sum / n; }));
    const { values, vectors } = symmetricEigen(covariance);
    const total = values.reduce((sum, value) => sum + Math.max(value, 0), 0);
    const fit = total > 0 ? (Math.max(values[0], 0) + Math.max(values[1] ?? 0, 0)) / total : 0;
    const e1 = vectors.map((row) => row[0]), e2 = vectors.map((row) => row[1] ?? 0);
    const u = new Float32Array(n), v = new Float32Array(n);
    for (let k = 0; k < count; k++) for (let i = 0; i < n; i++) { u[i] += e1[k] * differences[k][i]; v[i] += e2[k] * differences[k][i]; }
    // slopeX = a u + b v, slopeY = c u + d v must not curl: a dy(u) + b dy(v) - c dx(u) - d dx(v) = 0.
    const normal = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const ux = (u[i + 1] - u[i - 1]) / 2, vx = (v[i + 1] - v[i - 1]) / 2;
        const uy = (u[i - w] - u[i + w]) / 2, vy = (v[i - w] - v[i + w]) / 2; // Up the picture.
        const f = [uy, vy, -ux, -vx];
        for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) normal[r][c] += f[r] * f[c];
    }
    const smallest = symmetricEigen(normal).vectors.map((row) => row[3]);
    let [a, b, c, d] = smallest;
    const det = a * d - b * c;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return { azimuths: brightness.map((_, k) => (k / count) * Math.PI * 2), fit: 0 };
    // Settle which way round: the height must be low where the photos are dark on average.
    const slopeX = new Float32Array(n), slopeY = new Float32Array(n);
    for (let i = 0; i < n; i++) { slopeX[i] = a * u[i] + b * v[i]; slopeY[i] = c * u[i] + d * v[i]; }
    const side = Math.max(nextPowerOfTwo(w), nextPowerOfTwo(h));
    const padded = (values: Float32Array) => {
        const out = new Float32Array(side * side);
        for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) out[y * side + x] = values[Math.min(h - 1, y) * w + Math.min(w - 1, x)];
        return out;
    };
    const relief = integrateSlopes(padded(slopeX), padded(slopeY), side, side, false);
    let agreement = 0;
    let meanAverage = 0;
    for (let i = 0; i < n; i++) meanAverage += average[i] / n;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) agreement += relief[y * side + x] * (average[y * w + x] - meanAverage);
    if (agreement < 0) { a = -a; b = -b; c = -c; d = -d; }
    // differences = [e1 e2] (u; v) = [e1 e2] M^-1 (slopes): each photo's row says its light's direction (towards the light, against the rise).
    const inverse = [[d / (a * d - b * c), -b / (a * d - b * c)], [-c / (a * d - b * c), a / (a * d - b * c)]];
    const azimuths = Array.from({ length: count }, (_, k) => {
        const gx = e1[k] * inverse[0][0] + e2[k] * inverse[1][0];
        const gy = e1[k] * inverse[0][1] + e2[k] * inverse[1][1];
        return Math.atan2(-gy, -gx);
    });
    return { azimuths, fit };
};

const nextPowerOfTwo = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

// ---- photometric stereo ----

/**
 * The normal and colour of every pixel from photos (all `width` × `height`) and their lights (unit
 * directions towards each). Each photo's exposure is matched to the others first. A pixel's darkest
 * reading is left out when it is likely in shadow (four photos: far darker than the rest; five or more:
 * always) and its brightest when there are six or more (a shine), and the rest solved by least squares.
 */
export const photometricStereo = (photos: readonly CapturePhoto[], lights: readonly Vec3[], width: number, height: number): CaptureMaps => {
    const count = photos.length;
    if (count < 3 || lights.length !== count) throw new Error('Photometric stereo takes three or more photos, each with its light.');
    const n = width * height;
    const linear = photos.map((photo) => photo.rgb.map(srgbToLinear));
    const brightness = linear.map((rgb) => { const out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = luma(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]); return out; });
    const means = brightness.map((values) => { let sum = 0; for (let i = 0; i < n; i++) sum += values[i]; return Math.max(sum / n, 1e-6); });
    const overall = means.reduce((sum, value) => sum + value, 0) / count;
    const gains = means.map((mean) => overall / mean);
    const albedo = new Float32Array(n * 3);
    const normal = new Float32Array(n * 3);
    const order = Array.from({ length: count }, (_, k) => k);
    const reading = new Float64Array(count);
    let albedoLuma = 0;
    for (let p = 0; p < n; p++) {
        for (let k = 0; k < count; k++) reading[k] = brightness[k][p] * gains[k];
        order.sort((i, j) => reading[i] - reading[j]);
        let from = 0, to = count;
        if (count >= 5) from = 1;
        else if (count === 4) {
            const rest = (reading[order[1]] + reading[order[2]] + reading[order[3]]) / 3;
            if (reading[order[0]] < rest * 0.35) from = 1;
        }
        if (count >= 6) to = count - 1;
        const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
        const b = [0, 0, 0];
        for (let s = from; s < to; s++) {
            const k = order[s];
            const l = lights[k];
            for (let r = 0; r < 3; r++) {
                b[r] += l[r] * reading[k];
                for (let c = 0; c < 3; c++) m[r * 3 + c] += l[r] * l[c];
            }
        }
        const g = solve3(m, b);
        let nx = 0, ny = 0, nz = 1;
        const length = g ? Math.hypot(g[0], g[1], g[2]) : 0;
        if (g && length > 1e-6) {
            nx = g[0] / length; ny = g[1] / length; nz = Math.max(g[2] / length, 0.05);
            const l2 = Math.hypot(nx, ny, nz);
            nx /= l2; ny /= l2; nz /= l2;
        }
        normal[p * 3] = nx; normal[p * 3 + 1] = ny; normal[p * 3 + 2] = nz;
        // Each colour channel: the value that, lit as this normal is by each light, reads closest.
        let shadeSquared = 0;
        const sums = [0, 0, 0];
        for (let s = from; s < to; s++) {
            const k = order[s];
            const l = lights[k];
            const shade = Math.max(0, nx * l[0] + ny * l[1] + nz * l[2]);
            shadeSquared += shade * shade;
            for (let c = 0; c < 3; c++) sums[c] += linear[k][p * 3 + c] * gains[k] * shade;
        }
        for (let c = 0; c < 3; c++) albedo[p * 3 + c] = shadeSquared > 1e-8 ? sums[c] / shadeSquared : 0;
        albedoLuma += luma(albedo[p * 3], albedo[p * 3 + 1], albedo[p * 3 + 2]);
    }
    // As bright on average as the photos, back in stored colours.
    const scale = overall / Math.max(albedoLuma / n, 1e-6);
    for (let i = 0; i < albedo.length; i++) albedo[i] = Math.min(1, Math.max(0, linearToSrgb(Math.max(0, albedo[i] * scale))));
    return { width, height, albedo, normal };
};
