import { seamMasks, seamTile, softenMask, type Picture } from '../graph/seamCut';
import { heightFromNormals, photometricStereo, type CapturePhoto, type Vec3 } from './photometricStereo';

export interface CapturedMaps {
    width: number;
    height: number;
    /** sRGB colour, red green blue a pixel. */
    albedo: Float32Array;
    /** Unit normals, x y z a pixel (green up). */
    normal: Float32Array;
    /** Height, 0 (lowest) to 1, a value a pixel. */
    heightMap: Float32Array;
}

/** A picture of rows (top first) as the seam cutter takes them: it reads with wrapping, either way up. */
const asPicture = (data: Float32Array, width: number, height: number, channels: number): Picture => ({ data, width, height, channels });

/**
 * The capture's maps, from photos and their lights: solved, then made to tile with one set of joins
 * for colour and normal (found on the colour, `band` of the picture wide, as Make it tile does), and
 * the height integrated from the tiling normal, so it tiles too and agrees with it. Sides must be
 * powers of two.
 */
export const captureMaps = (photos: readonly CapturePhoto[], lights: readonly Vec3[], width: number, height: number, band = 0.2): CapturedMaps => {
    const solved = photometricStereo(photos, lights, width, height);
    const colour = asPicture(solved.albedo, width, height, 3);
    const masks = seamMasks(colour, (band * Math.min(width, height)) / 2);
    const soft = { upright: softenMask(masks.upright, width, height, 2), level: softenMask(masks.level, width, height, 2) };
    const albedo = seamTile(colour, soft).data;
    const normal = seamTile(asPicture(solved.normal, width, height, 3), soft).data;
    // Joins blend normals a little: unit length again.
    for (let i = 0; i < width * height; i++) {
        const length = Math.hypot(normal[i * 3], normal[i * 3 + 1], normal[i * 3 + 2]) || 1;
        for (let c = 0; c < 3; c++) normal[i * 3 + c] /= length;
    }
    const raw = heightFromNormals(normal, width, height, true, DRIFT_WAVES);
    return { width, height, albedo, normal, heightMap: stretched(raw) };
};

/**
 * Changes in the height slower than this many waves across the picture are taken out: the broad drift
 * integrating a measured normal gathers (a bright middle, a dark corner). A brick wall's courses and
 * bricks, at five or more across, stay.
 */
const DRIFT_WAVES = 2.5;

/** Heights stretched to 0 to 1 between their half-percent lowest and highest (a stray few don't squash the rest). */
const stretched = (values: Float32Array): Float32Array => {
    const sorted = Float32Array.from(values).sort();
    const low = sorted[Math.floor(sorted.length * 0.005)];
    const high = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.995))];
    const range = Math.max(high - low, 1e-6);
    return values.map((value) => Math.min(1, Math.max(0, (value - low) / range)));
};
