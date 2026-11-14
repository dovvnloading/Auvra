import { DEFAULT_GARMENT_MATERIAL, type GarmentMaterial } from './solver';

export const GARMENT_FABRICS = {
    cotton: {},
    linen: { arealDensity: 0.22, warp: 2600, weft: 1900, shear: 290, bend: 0.00012 },
    silk: { arealDensity: 0.09, warp: 1050, weft: 760, shear: 65, bend: 0.000012 },
} satisfies Record<string, Partial<GarmentMaterial>>;

export type GarmentFabric = keyof typeof GARMENT_FABRICS;

/** Authoring limits are in the same SI units as GarmentMaterial. Scale converts them for the inspector. */
export const FABRIC_FIELDS = {
    arealDensity: { label: 'Areal density', unit: 'g/m²', scale: 1000, min: 0.005, max: 5 },
    warp: { label: 'Warp stiffness', unit: 'N/m', scale: 1, min: 0, max: 1e6 },
    weft: { label: 'Weft stiffness', unit: 'N/m', scale: 1, min: 0, max: 1e6 },
    shear: { label: 'Shear stiffness', unit: 'N/m', scale: 1, min: 0, max: 1e6 },
    bend: { label: 'Bending stiffness', unit: 'µN·m', scale: 1e6, min: 0, max: 0.1 },
    damping: { label: 'Damping', unit: 's⁻¹', scale: 1, min: 0, max: 100 },
    thickness: { label: 'Contact offset', unit: 'mm', scale: 1000, min: 0, max: 0.05 },
    friction: { label: 'Contact friction', unit: '', scale: 1, min: 0, max: 2 },
} as const;
export type FabricField = keyof typeof FABRIC_FIELDS;
export type GarmentFabricOverrides = Partial<Record<FabricField, number>>;
export const fabricFieldNames = Object.keys(FABRIC_FIELDS) as FabricField[];

export function fabricPreset(fabric: GarmentFabric): Readonly<GarmentMaterial> {
    return { ...DEFAULT_GARMENT_MATERIAL, ...GARMENT_FABRICS[fabric] };
}

/** Return finite, supported deviations from the selected preset in a stable field order. */
export function readFabricOverrides(fabric: GarmentFabric, value: unknown): GarmentFabricOverrides | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const properties = value as Record<string, unknown>;
    const base = fabricPreset(fabric), result: GarmentFabricOverrides = {};
    for (const key of fabricFieldNames) {
        const v = properties[key], field = FABRIC_FIELDS[key];
        if (typeof v === 'number' && Number.isFinite(v) && v >= field.min && v <= field.max && v !== base[key]) result[key] = v;
    }
    return Object.keys(result).length ? result : undefined;
}

/** Fitting body in local metres. y is the lowest point of the rounded capsule. */
export const FITTING_TORSO = { x: 0, y: 1.05, z: 0, height: 0.51, radius: 0.1, radiusX: 0.145, id: 'fitting-torso' };

/** Analytic translation shared by live fitting and baking. Returns an offset from the authored pose. */
export function fittingOffsetAt(time: number, animated: boolean, out: { x: number; y: number; z: number }): void {
    out.x = animated ? 0.025 * Math.sin(2.2 * time) : 0;
    out.y = 0;
    out.z = animated ? 0.012 * Math.sin(1.1 * time) : 0;
}
