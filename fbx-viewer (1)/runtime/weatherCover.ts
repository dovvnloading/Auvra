/**
 * WEATHER COVER
 *
 * What is overhead around the camera: a grid of the highest fixed surface in each cell, sampled by
 * rays straight down and kept centred on the camera as it moves. Rain and snow die where they reach
 * it, so none falls under a roof; surfaces below it stay dry and free of snow; a car parked under
 * it keeps its dry-road grip. A cell with nothing under it is open sky all the way down.
 */

/** Cells across, and their size, m: 64 m round the camera. */
export const COVER_CELLS = 64;
export const COVER_CELL_SIZE = 1;
/** Cells sampled per frame. */
export const COVER_SAMPLES_PER_FRAME = 256;
/** How far below a cell's top a point must be to count as under it, m. */
export const COVER_MARGIN = 0.3;
/** A cell with nothing in it. */
export const OPEN_SKY = -1e4;

/** The top of whatever is at (x, z): its height, or null for nothing. */
export type CoverSampler = (x: number, z: number) => number | null;

export class WeatherCover {
    readonly cells: number;
    readonly cellSize: number;
    /** Heights by cell, row by row along +Z then +X within a row; NaN where not sampled yet. */
    readonly heights: Float32Array;
    /** The world x and z of cell (0, 0)'s corner. */
    originX = 0;
    originZ = 0;
    /** Bumps whenever a height changes (or the grid moves), so a texture of it can be refreshed. */
    version = 0;
    private cursor = 0;
    private placed = false;

    constructor(cells = COVER_CELLS, cellSize = COVER_CELL_SIZE) {
        this.cells = Math.max(2, Math.floor(cells));
        this.cellSize = cellSize;
        this.heights = new Float32Array(this.cells * this.cells).fill(Number.NaN);
    }

    /** The grid's width, m. */
    get span(): number {
        return this.cells * this.cellSize;
    }

    /** Centres the grid on (x, z), in whole cells; heights still under it are kept, new cells start unsampled. */
    centre(x: number, z: number): void {
        const n = this.cells;
        const ox = Math.floor(x / this.cellSize - n / 2) * this.cellSize;
        const oz = Math.floor(z / this.cellSize - n / 2) * this.cellSize;
        if (this.placed && ox === this.originX && oz === this.originZ) return;
        if (this.placed) {
            const dx = Math.round((ox - this.originX) / this.cellSize);
            const dz = Math.round((oz - this.originZ) / this.cellSize);
            const old = this.heights.slice();
            for (let row = 0; row < n; row++) {
                for (let col = 0; col < n; col++) {
                    const fromRow = row + dz, fromCol = col + dx;
                    this.heights[row * n + col] = fromRow >= 0 && fromRow < n && fromCol >= 0 && fromCol < n ? old[fromRow * n + fromCol] : Number.NaN;
                }
            }
        }
        this.originX = ox;
        this.originZ = oz;
        this.placed = true;
        this.version++;
    }

    /** Forgets every height (the level changed). */
    clear(): void {
        this.heights.fill(Number.NaN);
        this.version++;
    }

    /** Samples up to `budget` cells: unsampled ones first, then the rest in turn. Returns how many. */
    refresh(budget: number, sample: CoverSampler): number {
        const n = this.cells;
        const total = n * n;
        let done = 0;
        let changed = false;
        for (let i = 0; i < total && done < budget; i++) {
            if (Number.isNaN(this.heights[i])) {
                changed = this.sampleCell(i, sample) || changed;
                done++;
            }
        }
        for (let k = 0; k < total && done < budget; k++) {
            changed = this.sampleCell(this.cursor, sample) || changed;
            this.cursor = (this.cursor + 1) % total;
            done++;
        }
        if (changed) this.version++;
        return done;
    }

    /** The top of what is over (x, z); OPEN_SKY outside the grid or where not sampled yet. */
    heightAt(x: number, z: number): number {
        const col = Math.floor((x - this.originX) / this.cellSize);
        const row = Math.floor((z - this.originZ) / this.cellSize);
        if (col < 0 || row < 0 || col >= this.cells || row >= this.cells) return OPEN_SKY;
        const height = this.heights[row * this.cells + col];
        return Number.isNaN(height) ? OPEN_SKY : height;
    }

    /** Whether (x, y, z) is under something. */
    sheltered(x: number, y: number, z: number): boolean {
        return y < this.heightAt(x, z) - COVER_MARGIN;
    }

    /** Samples one cell; true when its height changed. */
    private sampleCell(index: number, sample: CoverSampler): boolean {
        const row = Math.floor(index / this.cells), col = index % this.cells;
        const top = sample(this.originX + (col + 0.5) * this.cellSize, this.originZ + (row + 0.5) * this.cellSize);
        const height = top === null || !Number.isFinite(top) ? OPEN_SKY : Math.fround(top);
        if (this.heights[index] === height) return false;
        this.heights[index] = height;
        return true;
    }
}

/** The cover round the camera this session; the sky keeps it, what reacts to shelter reads it. */
export const weatherCover = new WeatherCover();
