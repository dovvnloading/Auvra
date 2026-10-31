/**
 * THE PROBE GRID
 *
 * Where a level's light is held around the camera: nested grids of probes, each coarser and wider than the one
 * inside it, that scroll with the camera. A probe keeps its world position for as long as it is in range, and
 * its place in the atlas comes from that position alone, wrapping around: so moving the camera only touches the
 * slab of probes that came into range, and the light everywhere else stays exactly as gathered.
 *
 * All of this is pure logic, so that it can be checked without a GPU. The shaders do the same sums (giShaders.ts).
 */

export const GI_CASCADES = 4;
/** Probes along each axis of a cascade: powers of two, so wrapping is a bit mask, in the shader as here. */
export const PROBES_X = 16;
export const PROBES_Y = 8;
export const PROBES_Z = 16;
export const PROBES_PER_CASCADE = PROBES_X * PROBES_Y * PROBES_Z;
/** How much wider each cascade's spacing is than the last. */
export const CASCADE_RATIO = 3;

/**
 * How far up, in spacings, each layer of probes sits from a multiple of the spacing. Floors and ceilings tend to
 * lie on round numbers: without this, whole layers of probes would be buried in them.
 */
export const GRID_LIFT = 0.37;

/** Texels of a probe's irradiance and visibility maps, plus one around each so filtering stays inside it. */
export const IRRADIANCE_TEXELS = 6;
export const VISIBILITY_TEXELS = 14;
export const IRRADIANCE_CELL = IRRADIANCE_TEXELS + 2;
export const VISIBILITY_CELL = VISIBILITY_TEXELS + 2;

/** Each cascade's probes laid out flat: four layers across, two down. */
export const ATLAS_COLUMNS = PROBES_X * 4;
export const ATLAS_ROWS = PROBES_Z * 2;
export const ATLAS_IRRADIANCE_WIDTH = ATLAS_COLUMNS * IRRADIANCE_CELL;
export const ATLAS_WIDTH = ATLAS_IRRADIANCE_WIDTH + ATLAS_COLUMNS * VISIBILITY_CELL;
export const ATLAS_HEIGHT = GI_CASCADES * ATLAS_ROWS * VISIBILITY_CELL;
/** Under the irradiance maps: one texel per probe, holding how far it has moved out of the way of geometry. */
export const ATLAS_OFFSET_Y = GI_CASCADES * ATLAS_ROWS * IRRADIANCE_CELL;

/** Probes traced in one frame at most: a limit on the tables the passes use, not on anything a level sets. */
export const MAX_PROBES_PER_FRAME = 256;
/** Rays from one probe at most. */
export const MAX_RAYS_PER_PROBE = 96;

export type GiQuality = 'low' | 'medium' | 'high';

export interface GiQualityPlan {
    /** Rays from each probe updated. */
    rays: number;
    /** Probes updated per frame in each cascade, finest first. */
    probes: readonly [number, number, number, number];
}

export const GI_QUALITY: Record<GiQuality, GiQualityPlan> = {
    low: { rays: 32, probes: [48, 16, 8, 4] },
    medium: { rays: 48, probes: [96, 40, 16, 8] },
    high: { rays: 64, probes: [128, 64, 32, 16] },
};

/** Positive remainder for the grid's power-of-two sizes. */
const wrap = (value: number, size: number): number => value & (size - 1);

/** A probe's place among a cascade's PROBES_PER_CASCADE, from its world index along each axis. */
export const cellIndex = (x: number, y: number, z: number): number =>
    wrap(x, PROBES_X) + PROBES_X * (wrap(z, PROBES_Z) + PROBES_Z * wrap(y, PROBES_Y));

/** The column and row of a cell in its cascade's part of the atlas. */
export const cellPlace = (cell: number): { column: number; row: number } => {
    const x = cell % PROBES_X;
    const z = Math.floor(cell / PROBES_X) % PROBES_Z;
    const y = Math.floor(cell / (PROBES_X * PROBES_Z));
    return { column: x + PROBES_X * (y & 3), row: z + PROBES_Z * (y >> 2) };
};

/** Bottom-left texel of a probe's irradiance map in the atlas. */
export const irradianceOrigin = (cascade: number, column: number, row: number): [number, number] =>
    [column * IRRADIANCE_CELL, (cascade * ATLAS_ROWS + row) * IRRADIANCE_CELL];

/** Bottom-left texel of a probe's visibility map in the atlas. */
export const visibilityOrigin = (cascade: number, column: number, row: number): [number, number] =>
    [ATLAS_IRRADIANCE_WIDTH + column * VISIBILITY_CELL, (cascade * ATLAS_ROWS + row) * VISIBILITY_CELL];

/** The texel holding how far a probe has moved from its place in the grid. */
export const offsetTexel = (cascade: number, column: number, row: number): [number, number] =>
    [column, ATLAS_OFFSET_Y + cascade * ATLAS_ROWS + row];

/** A probe chosen to be traced this frame. */
export interface ScheduledProbe {
    cascade: number;
    cell: number;
    x: number;
    y: number;
    z: number;
}

/** A step through the cells that visits them all and scatters each frame's across the grid: odd, so coprime with their count. */
const SWEEP_STRIDE = 797;

export class ProbeCascade {
    /** World index of the grid's lowest corner, along each axis. */
    readonly low: [number, number, number] = [0, 0, 0];
    private placed = false;
    /** Cells waiting for their first rays. */
    private readonly fresh = new Uint8Array(PROBES_PER_CASCADE);
    private readonly freshQueue: number[] = [];
    private sweep = 0;

    constructor(readonly index: number, readonly spacing: number) {}

    /** World position of the grid's lowest corner. */
    corner(out: [number, number, number] = [0, 0, 0]): [number, number, number] {
        out[0] = this.low[0] * this.spacing;
        out[1] = (this.low[1] + GRID_LIFT) * this.spacing;
        out[2] = this.low[2] * this.spacing;
        return out;
    }

    /** How many cells still wait for their first rays. */
    get pending(): number {
        return this.freshQueue.length;
    }

    /**
     * Centres the grid on a point. Returns the cells that came into range, which hold what the probes that left
     * them saw: they must be cleared before anything reads them.
     */
    recentre(x: number, y: number, z: number): number[] {
        const nextX = Math.floor(x / this.spacing) - PROBES_X / 2 + 1;
        const nextY = Math.floor(y / this.spacing - GRID_LIFT) - PROBES_Y / 2 + 1;
        const nextZ = Math.floor(z / this.spacing) - PROBES_Z / 2 + 1;
        const entered: number[] = [];
        if (!this.placed) {
            this.placed = true;
            this.low[0] = nextX;
            this.low[1] = nextY;
            this.low[2] = nextZ;
            for (let cell = 0; cell < PROBES_PER_CASCADE; cell++) this.markFresh(cell);
            for (let cell = 0; cell < PROBES_PER_CASCADE; cell++) entered.push(cell);
            return entered;
        }
        const [lowX, lowY, lowZ] = this.low;
        if (nextX === lowX && nextY === lowY && nextZ === lowZ) return entered;
        const inRange = (value: number, low: number, size: number) => value >= low && value < low + size;
        for (let ix = nextX; ix < nextX + PROBES_X; ix++) {
            const keepX = inRange(ix, lowX, PROBES_X);
            for (let iy = nextY; iy < nextY + PROBES_Y; iy++) {
                const keepY = inRange(iy, lowY, PROBES_Y);
                for (let iz = nextZ; iz < nextZ + PROBES_Z; iz++) {
                    if (keepX && keepY && inRange(iz, lowZ, PROBES_Z)) continue;
                    const cell = cellIndex(ix, iy, iz);
                    entered.push(cell);
                    this.markFresh(cell);
                }
            }
        }
        this.low[0] = nextX;
        this.low[1] = nextY;
        this.low[2] = nextZ;
        return entered;
    }

    private markFresh(cell: number): void {
        if (this.fresh[cell]) return;
        this.fresh[cell] = 1;
        this.freshQueue.push(cell);
    }

    /** World index of the probe now in `cell`, along each axis. */
    private worldIndex(cell: number): [number, number, number] {
        const cellX = cell % PROBES_X;
        const cellZ = Math.floor(cell / PROBES_X) % PROBES_Z;
        const cellY = Math.floor(cell / (PROBES_X * PROBES_Z));
        return [
            this.low[0] + wrap(cellX - this.low[0], PROBES_X),
            this.low[1] + wrap(cellY - this.low[1], PROBES_Y),
            this.low[2] + wrap(cellZ - this.low[2], PROBES_Z),
        ];
    }

    /** Adds up to `budget` probes to `into`: those waiting for their first rays, the nearest first, then the sweep. */
    take(budget: number, into: ScheduledProbe[]): void {
        let left = budget;
        if (this.freshQueue.length) {
            const centre = [this.low[0] + PROBES_X / 2, this.low[1] + PROBES_Y / 2, this.low[2] + PROBES_Z / 2];
            const distance = (cell: number) => {
                const at = this.worldIndex(cell);
                return Math.abs(at[0] - centre[0]) + Math.abs(at[1] - centre[1]) + Math.abs(at[2] - centre[2]);
            };
            this.freshQueue.sort((a, b) => distance(b) - distance(a));
        }
        while (left > 0 && this.freshQueue.length) {
            const cell = this.freshQueue.pop()!;
            this.fresh[cell] = 0;
            this.push(cell, into);
            left--;
        }
        while (left > 0) {
            this.sweep = (this.sweep + SWEEP_STRIDE) % PROBES_PER_CASCADE;
            this.push(this.sweep, into);
            left--;
        }
    }

    private push(cell: number, into: ScheduledProbe[]): void {
        const [x, y, z] = this.worldIndex(cell);
        into.push({ cascade: this.index, cell, x: x * this.spacing, y: (y + GRID_LIFT) * this.spacing, z: z * this.spacing });
    }
}

/** Evenly spread directions over the sphere (a spherical Fibonacci set), flat as x, y, z. */
export const sphericalFibonacci = (count: number): Float32Array => {
    const directions = new Float32Array(count * 3);
    const golden = (1 + Math.sqrt(5)) / 2;
    for (let index = 0; index < count; index++) {
        const phi = 2 * Math.PI * ((index / golden) % 1);
        const cosTheta = 1 - (2 * index + 1) / count;
        const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
        directions[index * 3] = Math.cos(phi) * sinTheta;
        directions[index * 3 + 1] = Math.sin(phi) * sinTheta;
        directions[index * 3 + 2] = cosTheta;
    }
    return directions;
};

/** Settings as a level stores them. */
export interface DynamicGiSettings {
    quality: GiQuality;
    /** Metres between the finest probes; each cascade out is CASCADE_RATIO times that. */
    spacing: number;
    /** Scales all the indirect light. */
    intensity: number;
    /** How much light carries on after its first bounce. */
    bounce: number;
    view: 'lit' | 'probes' | 'rays' | 'lighting';
}

export const DEFAULT_DYNAMIC_GI_SETTINGS: DynamicGiSettings = { quality: 'medium', spacing: 1, intensity: 1, bounce: 1, view: 'lit' };

const QUALITIES: readonly GiQuality[] = ['low', 'medium', 'high'];
const VIEWS: readonly DynamicGiSettings['view'][] = ['lit', 'probes', 'rays', 'lighting'];

const finite = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

export const resolveDynamicGiSettings = (props: Record<string, unknown> | null | undefined): DynamicGiSettings => {
    const defaults = DEFAULT_DYNAMIC_GI_SETTINGS;
    return {
        quality: QUALITIES.includes(props?.quality as GiQuality) ? props!.quality as GiQuality : defaults.quality,
        spacing: finite(props?.spacing, defaults.spacing, 0.5, 8),
        intensity: finite(props?.intensity, defaults.intensity, 0, 8),
        bounce: finite(props?.bounce, defaults.bounce, 0, 1),
        view: VIEWS.includes(props?.view as DynamicGiSettings['view']) ? props!.view as DynamicGiSettings['view'] : defaults.view,
    };
};
