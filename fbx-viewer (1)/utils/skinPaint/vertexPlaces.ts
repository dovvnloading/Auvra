/**
 * Vertices by where they are, for telling which are one point of a surface: a mesh splits a point into
 * several vertices along its texture seams and where its materials meet. Places closer than the
 * tolerance count as one, whichever side of a rounding boundary they fall on.
 */

/** Cells are this many tolerances across, so most searches look in only one or two. */
const CELL_TOLERANCES = 8;

/** Three cell coordinates into one number that a double holds exactly. */
const cellKey = (x: number, y: number, z: number): number => (x & 0x1ffff) * 17179869184 + (y & 0x1ffff) * 131072 + (z & 0x1ffff);

export class VertexPlaces {
  private readonly cell: number;
  /** The newest place in each cell, and from each place the one before it in its cell. */
  private readonly newest = new Map<number, number>();
  private readonly older: number[] = [];
  private readonly coordinates: number[] = [];

  constructor(private readonly tolerance: number) {
    this.cell = tolerance * CELL_TOLERANCES;
  }

  get count(): number {
    return this.older.length;
  }

  /** The number of the place within the tolerance of a point, or -1. */
  find(x: number, y: number, z: number): number {
    const { cell, tolerance, coordinates } = this;
    const lastX = Math.floor((x + tolerance) / cell);
    const lastY = Math.floor((y + tolerance) / cell);
    const lastZ = Math.floor((z + tolerance) / cell);
    const firstY = Math.floor((y - tolerance) / cell);
    const firstZ = Math.floor((z - tolerance) / cell);
    const reach = tolerance * tolerance;
    for (let cx = Math.floor((x - tolerance) / cell); cx <= lastX; cx += 1) {
      for (let cy = firstY; cy <= lastY; cy += 1) {
        for (let cz = firstZ; cz <= lastZ; cz += 1) {
          for (let place = this.newest.get(cellKey(cx, cy, cz)) ?? -1; place >= 0; place = this.older[place]) {
            const dx = coordinates[place * 3] - x;
            const dy = coordinates[place * 3 + 1] - y;
            const dz = coordinates[place * 3 + 2] - z;
            if (dx * dx + dy * dy + dz * dz <= reach) return place;
          }
        }
      }
    }
    return -1;
  }

  /** Adds a place, and gives its number. */
  add(x: number, y: number, z: number): number {
    const key = cellKey(Math.floor(x / this.cell), Math.floor(y / this.cell), Math.floor(z / this.cell));
    const place = this.older.length;
    this.older.push(this.newest.get(key) ?? -1);
    this.newest.set(key, place);
    this.coordinates.push(x, y, z);
    return place;
  }
}
