import type { GarmentMaterial } from './solver';

export const GARMENT_FABRICS = {
    cotton: {},
    linen: { arealDensity: 0.22, warp: 2600, weft: 1900, shear: 290, bend: 0.00012 },
    silk: { arealDensity: 0.09, warp: 1050, weft: 760, shear: 65, bend: 0.000012 },
} satisfies Record<string, Partial<GarmentMaterial>>;

export type GarmentFabric = keyof typeof GARMENT_FABRICS;

/** Fitting body in local metres. y is the lowest point of the rounded capsule. */
export const FITTING_TORSO = { x: 0, y: 1.05, z: 0, height: 0.51, radius: 0.1, radiusX: 0.145, id: 'fitting-torso' };

/** Analytic translation shared by live fitting and baking. Returns an offset from the authored pose. */
export function fittingOffsetAt(time: number, animated: boolean, out: { x: number; y: number; z: number }): void {
    out.x = animated ? 0.025 * Math.sin(2.2 * time) : 0;
    out.y = 0;
    out.z = animated ? 0.012 * Math.sin(1.1 * time) : 0;
}
