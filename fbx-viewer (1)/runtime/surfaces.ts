/**
 * What the ground is made of, as tyres (and anything else that rolls, slides or steps on it) feel
 * it: grip, rolling resistance, what a sliding tyre throws up, and the marks it leaves. A collider's
 * surface is tagged on it (userData `surface`): one kind for the whole collider, one per triangle
 * of a mesh collider (from its render materials' names), or a function of the point (a terrain's
 * painted layers).
 */

export type SurfaceKind =
    | 'default' | 'asphalt' | 'concrete' | 'metal' | 'wood'
    | 'dirt' | 'gravel' | 'grass' | 'sand' | 'mud' | 'snow' | 'ice' | 'water';

export const SURFACE_KINDS: readonly SurfaceKind[] = [
    'default', 'asphalt', 'concrete', 'metal', 'wood', 'dirt', 'gravel', 'grass', 'sand', 'mud', 'snow', 'ice', 'water',
];

/** What a sliding or spinning tyre throws up. */
export type SurfaceKick = 'smoke' | 'dust' | 'spray' | 'none';

export interface SurfaceSpec {
    label: string;
    /** Tyre grip as a share of a dry road's. */
    grip: number;
    /** Rolling resistance: drag force per unit of load. */
    rolling: number;
    kick: SurfaceKick;
    /** Colour of what it throws up. */
    kickColor: string;
    /** Colour of the marks tyres leave, or null for none. */
    markColor: string | null;
    /** Loose ground keeps a rut wherever a tyre rolls, not only where it slides. */
    loose: boolean;
}

export const SURFACES: Record<SurfaceKind, SurfaceSpec> = {
    default: { label: 'Default (road)', grip: 1, rolling: 0.015, kick: 'smoke', kickColor: '#cfcfcf', markColor: '#121212', loose: false },
    asphalt: { label: 'Asphalt', grip: 1, rolling: 0.015, kick: 'smoke', kickColor: '#cfcfcf', markColor: '#121212', loose: false },
    concrete: { label: 'Concrete', grip: 0.95, rolling: 0.013, kick: 'smoke', kickColor: '#d4d4d4', markColor: '#1a1a1a', loose: false },
    metal: { label: 'Metal', grip: 0.75, rolling: 0.012, kick: 'smoke', kickColor: '#cfcfcf', markColor: '#161616', loose: false },
    wood: { label: 'Wood', grip: 0.8, rolling: 0.02, kick: 'dust', kickColor: '#a08a6a', markColor: '#2e2318', loose: false },
    dirt: { label: 'Dirt', grip: 0.68, rolling: 0.045, kick: 'dust', kickColor: '#8f7656', markColor: '#3a2d20', loose: true },
    gravel: { label: 'Gravel', grip: 0.6, rolling: 0.05, kick: 'dust', kickColor: '#a29a8e', markColor: '#4d473f', loose: true },
    grass: { label: 'Grass', grip: 0.55, rolling: 0.06, kick: 'dust', kickColor: '#77713f', markColor: '#2c3519', loose: true },
    sand: { label: 'Sand', grip: 0.5, rolling: 0.15, kick: 'dust', kickColor: '#d8c290', markColor: '#9c8558', loose: true },
    mud: { label: 'Mud', grip: 0.4, rolling: 0.2, kick: 'spray', kickColor: '#4b3a29', markColor: '#261c13', loose: true },
    snow: { label: 'Snow', grip: 0.3, rolling: 0.06, kick: 'spray', kickColor: '#f2f6fa', markColor: '#aeb9c4', loose: true },
    ice: { label: 'Ice', grip: 0.1, rolling: 0.01, kick: 'none', kickColor: '#e8f2fa', markColor: '#c4d4e0', loose: false },
    water: { label: 'Water', grip: 0.5, rolling: 0.08, kick: 'spray', kickColor: '#d4e6f2', markColor: null, loose: false },
};

/** Words in a material or object name that say what surface it is, most specific first. */
const NAME_RULES: [RegExp, SurfaceKind][] = [
    [/asphalt|tarmac|blacktop|bitumen|road|street|highway|motorway|race ?track|runway/, 'asphalt'],
    [/concrete|cement|pavement|paving|sidewalk|kerb|curb|cobble|brick|tile/, 'concrete'],
    [/gravel|pebble|shingle|ballast|rubble/, 'gravel'],
    [/mud|swamp|bog/, 'mud'],
    [/snow/, 'snow'],
    [/\bice\b|icy|frozen/, 'ice'],
    [/sand|beach|desert|dune/, 'sand'],
    [/grass|lawn|turf|meadow|moss/, 'grass'],
    [/dirt|soil|earth|clay|offroad|off road/, 'dirt'],
    [/water|puddle|river|lake/, 'water'],
    [/metal|steel|iron|alumin|chrome/, 'metal'],
    [/wood|plank|timber|deck/, 'wood'],
];

/** The surface a material or object name says it is, or null when it says nothing. */
export const surfaceFromName = (name: string | undefined | null): SurfaceKind | null => {
    if (!name) return null;
    const text = name.toLowerCase().replace(/[_.\-]+/g, ' ');
    for (const [pattern, kind] of NAME_RULES) if (pattern.test(text)) return kind;
    return null;
};

export const isSurfaceKind = (value: unknown): value is SurfaceKind =>
    typeof value === 'string' && (SURFACE_KINDS as readonly string[]).includes(value);

/** A collider's surface, as tagged on its userData. */
export interface SurfaceTag {
    /** The whole collider. */
    kind?: SurfaceKind;
    /** A mesh collider: each triangle's index into `kinds`. */
    triangles?: Uint8Array;
    kinds?: readonly SurfaceKind[];
    /** A surface that varies over the collider (a terrain's painted layers), by world point. */
    at?: (x: number, z: number) => SurfaceKind;
}

export const SURFACE_USER_DATA_KEY = 'surface';

/** Tags a collider (anything with a userData slot) with its surface, keeping what else its userData holds. */
export const tagSurface = (collider: { userData?: unknown }, tag: SurfaceTag | null): void => {
    const current = collider.userData && typeof collider.userData === 'object' ? collider.userData as Record<string, unknown> : {};
    if (!tag) {
        if (SURFACE_USER_DATA_KEY in current) {
            const rest = { ...current };
            delete rest[SURFACE_USER_DATA_KEY];
            collider.userData = rest;
        }
        return;
    }
    collider.userData = { ...current, [SURFACE_USER_DATA_KEY]: tag };
};

/**
 * The surface under a hit: the tag on the collider hit, the triangle (`feature`, the shape's
 * feature id) of a mesh collider, or the point on a varying one; 'default' when untagged.
 */
export const surfaceOfHit = (collider: object | null | undefined, feature: number | undefined, x: number, z: number): SurfaceKind => {
    const data = (collider as { userData?: unknown } | null | undefined)?.userData as Record<string, unknown> | undefined;
    const tag = data?.[SURFACE_USER_DATA_KEY] as SurfaceTag | undefined;
    if (!tag) return 'default';
    if (tag.triangles && tag.kinds && typeof feature === 'number' && feature >= 0) {
        // A mesh hit from behind reports its triangle offset by the triangle count.
        const kind = tag.kinds[tag.triangles[feature % tag.triangles.length]];
        if (kind) return kind;
    }
    if (tag.at) return tag.at(x, z);
    return tag.kind ?? 'default';
};

/**
 * Per-triangle surfaces for a triangle soup built from meshes: `ranges` lists, in triangle order,
 * how many triangles each material run has and the material's name. Null when no name says a
 * surface (the collider then stays 'default', or takes its explicit setting).
 */
export const triangleSurfaces = (ranges: readonly { count: number; name: string | undefined }[]): Pick<SurfaceTag, 'triangles' | 'kinds'> | null => {
    const kinds: SurfaceKind[] = ['default'];
    const index = new Map<SurfaceKind, number>([['default', 0]]);
    let total = 0;
    let named = false;
    const runs = ranges.map(range => {
        const kind = surfaceFromName(range.name) ?? 'default';
        if (kind !== 'default') named = true;
        if (!index.has(kind)) {
            index.set(kind, kinds.length);
            kinds.push(kind);
        }
        total += range.count;
        return { count: range.count, slot: index.get(kind)! };
    });
    if (!named) return null;
    const triangles = new Uint8Array(total);
    let at = 0;
    for (const run of runs) {
        triangles.fill(run.slot, at, at + run.count);
        at += run.count;
    }
    return { triangles, kinds };
};
