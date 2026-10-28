import * as THREE from 'three';
import {
    Detour,
    NavMeshQuery,
    Raw,
    TileCacheMeshProcess,
    exportTileCache,
    getNavMeshPositionsAndIndices,
    importTileCache,
    init,
    statusDetail,
    type NavMesh,
    type Obstacle,
    type TileCache,
} from 'recast-navigation';
import { generateTileCache } from 'recast-navigation/generators';
import type { NavLinkSpec } from './navGeometry';
import type { NavSettings } from './navSettings';

/**
 * THE LEVEL NAVMESH
 *
 * Recast bakes the level's walkable surfaces (runtime/navGeometry.ts) into a tiled navmesh: walls
 * and ledges are kept the agent's radius away, headroom under its height and steps over its climb
 * are not walkable, slopes over its limit are not either. Detour answers the queries agents ask
 * of it: a path (string-pulled into straight legs), a move along the surface that slides along
 * walls and stops at ledges, the nearest walkable point, a random point within reach. Its tile
 * cache lets moving obstacles (the Nav Obstacle component) carve holes that follow them.
 */

export interface NavPoint {
    x: number;
    y?: number;
    z: number;
}

export interface FindPathOptions {
    /** When the target cannot be reached, return a path to the reachable point closest to it instead of null. */
    partial?: boolean;
    /** How far from the navmesh (horizontally) from/to may be and still count as on it (default max(1, 2 agent radii + 0.5)). */
    maxSnapDistance?: number;
}

export interface NavPathResult {
    /** Waypoints from the start position to the end; y is the surface height (the endpoints keep their own y). */
    points: THREE.Vector3[];
    /** False when the path stops at the closest reachable point (partial). */
    reachable: boolean;
}

/** What baking needs; it all crosses to the baking worker. */
export interface NavBakeInput {
    positions: Float32Array;
    indices: Uint32Array;
    links: NavLinkSpec[];
    settings: NavSettings;
}

// Tiles are this many cells a side; Recast's tile cache is built for 32 to 64. A tile cache keeps no
// detail mesh, so heights inside a polygon are flat between its corners: small tiles keep polygons,
// and so that error over curved ground, small.
const TILE_SIZE = 32;
// Above this many cells the cells grow, so a very large level still bakes in reasonable time.
const MAX_CELLS = 2048 * 2048;
const MAX_OBSTACLES = 512;
// Long paths on large levels: polygons a path may cross, and nodes a search may open.
const MAX_PATH_POLYS = 2048;
const MAX_SEARCH_NODES = 8192;
// How far off the navmesh a partial path still looks for somewhere to head toward.
const FAR_SNAP = 25;
const POLY_FLAG_WALK = 1;

let ready: Promise<void> | null = null;
/** Loads Recast's WebAssembly, once. */
export const recastReady = (): Promise<void> => (ready ??= init());

const vector = ([x, y, z]: readonly number[]) => ({ x, y, z });

/** Recast's settings for these agents over this geometry: cells sized to the agent, grown on very large levels. */
export const navBakeConfig = (input: Pick<NavBakeInput, 'positions' | 'settings'>) => {
    const { agentRadius, agentHeight, maxSlopeDegrees, maxStepHeight } = input.settings;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    const { positions } = input;
    for (let i = 0; i + 2 < positions.length; i += 3) {
        if (positions[i] < minX) minX = positions[i];
        if (positions[i] > maxX) maxX = positions[i];
        if (positions[i + 2] < minZ) minZ = positions[i + 2];
        if (positions[i + 2] > maxZ) maxZ = positions[i + 2];
    }
    const area = Number.isFinite(minX) ? (maxX - minX) * (maxZ - minZ) : 0;
    const cs = Math.max(THREE.MathUtils.clamp(agentRadius / 2, 0.05, 0.5), Math.sqrt(area / MAX_CELLS));
    // Fine enough height steps to tell the agent's climb apart (four to a step), never finer than a tile layer allows.
    const ch = THREE.MathUtils.clamp(maxStepHeight > 0 ? maxStepHeight / 4 : cs / 2, 0.05, cs / 2);
    return {
        cs,
        ch,
        tileSize: TILE_SIZE,
        walkableSlopeAngle: maxSlopeDegrees,
        walkableHeight: Math.max(3, Math.ceil(agentHeight / ch)),
        walkableClimb: Math.floor(maxStepHeight / ch + 1e-6),
        walkableRadius: Math.ceil(agentRadius / cs),
        maxSimplificationError: 1.3,
        maxVertsPerPoly: 6,
        detailSampleDist: cs * 6,
        detailSampleMaxError: ch,
        expectedLayersPerTile: 4,
        maxObstacles: MAX_OBSTACLES,
    };
};

/** Every polygon walkable, and the level's links added to the tile they start in, whenever a tile is built. */
const meshProcess = (links: readonly NavLinkSpec[]) => new TileCacheMeshProcess((params, areas, flags) => {
    for (let i = 0; i < params.polyCount(); i++) {
        areas.set(i, 0);
        flags.set(i, POLY_FLAG_WALK);
    }
    if (links.length > 0) {
        params.setOffMeshConnections(links.map(link => ({
            startPosition: vector(link.start),
            endPosition: vector(link.end),
            radius: link.radius,
            bidirectional: link.bidirectional,
            area: 0,
            flags: POLY_FLAG_WALK,
        })));
    }
});

/** Bakes a navmesh and returns it serialised (LevelNavMesh.fromData reads it). Needs recastReady first. */
export const bakeNavMeshData = (input: NavBakeInput): Uint8Array => {
    const result = generateTileCache(input.positions, input.indices, { ...navBakeConfig(input), tileCacheMeshProcess: meshProcess(input.links) });
    if (!result.success) throw new Error(`The navmesh could not be baked: ${result.error}`);
    try {
        return exportTileCache(result.navMesh, result.tileCache);
    } finally {
        result.tileCache.destroy();
        result.navMesh.destroy();
    }
};

/** A moving obstacle's carve-out. */
export interface NavObstacleHandle {
    obstacle: Obstacle | null;
}

const destroyRaw = (object: unknown) => {
    try {
        (Raw.Module as unknown as { destroy(object: unknown): void }).destroy(object);
    } catch { /* already gone */ }
};

export class LevelNavMesh {
    /**
     * Bumps whenever the walkable area changes after baking (an obstacle moved), so agents re-plan.
     * Polygon references from before may no longer be valid.
     */
    version = 0;

    private readonly query: NavMeshQuery;
    private readonly obstacles = new Set<NavObstacleHandle>();
    private dirty = false;
    private disposed = false;

    private constructor(
        private readonly navMesh: NavMesh,
        private readonly tileCache: TileCache,
        private readonly owned: unknown[],
        readonly settings: NavSettings,
        readonly links: readonly NavLinkSpec[],
        private readonly groundHeight: (x: number, z: number) => number,
        /** Polygons lie a cell height above the surface they were baked from; heights given out are taken back down by it. */
        private readonly rise: number,
    ) {
        this.query = new NavMeshQuery(navMesh, { maxNodes: MAX_SEARCH_NODES });
    }

    /** The navmesh bakeNavMeshData made from `positions`, ready to query. Needs recastReady first. */
    static fromData(data: Uint8Array, input: Pick<NavBakeInput, 'positions' | 'settings' | 'links'>, groundHeight: (x: number, z: number) => number): LevelNavMesh {
        const imported = importTileCache(data, meshProcess(input.links));
        const { ch } = navBakeConfig(input);
        return new LevelNavMesh(imported.navMesh, imported.tileCache, [imported.allocator, imported.compressor], input.settings, input.links, groundHeight, ch);
    }

    /** Bakes in this thread (tests, and where workers are unavailable). Needs recastReady first. */
    static bake(input: NavBakeInput, groundHeight: (x: number, z: number) => number): LevelNavMesh {
        return LevelNavMesh.fromData(bakeNavMeshData(input), input, groundHeight);
    }

    private defaultSnap(): number {
        return Math.max(1, this.settings.agentRadius * 2 + 0.5);
    }

    /** A polygon height as the surface's. */
    private surface(x: number, y: number, z: number): THREE.Vector3 {
        return new THREE.Vector3(x, y - this.rise, z);
    }

    /**
     * The nearest walkable point to `point` within `horizontal` metres, searching from a little under
     * its feet to `vertical` metres either side (by default an agent's height, at least 3 m, so a
     * point in mid-jump finds the ground below it, and a polygon over curved ground, whose height is
     * only flat between its corners, is still found). A point without y is taken to be on the ground.
     */
    private nearest(point: NavPoint, horizontal: number, vertical = Math.max(this.settings.agentHeight, 3)): { ref: number; raw: THREE.Vector3; point: THREE.Vector3 } | null {
        const y = point.y ?? this.groundHeight(point.x, point.z);
        const found = this.query.findNearestPoly({ x: point.x, y: y + this.rise - 0.1, z: point.z }, { halfExtents: { x: horizontal, y: vertical, z: horizontal } });
        if (!found.success || !found.nearestRef) return null;
        const { x, y: height, z } = found.nearestPoint;
        return { ref: found.nearestRef, raw: new THREE.Vector3(x, height, z), point: this.surface(x, height, z) };
    }

    /** The walkable point closest to `point` within `maxDistance` metres (horizontally), or null. */
    closestPoint(point: NavPoint, maxDistance = this.defaultSnap()): THREE.Vector3 | null {
        return this.nearest(point, maxDistance)?.point ?? null;
    }

    /** True when (x, z) at about height y lies on the navmesh. */
    isWalkable(point: NavPoint): boolean {
        const found = this.nearest(point, 0.05, Math.max(this.settings.maxStepHeight, 0.25));
        return !!found && Math.hypot(found.point.x - point.x, found.point.z - point.z) < 0.05;
    }

    /**
     * Plans a path and reports whether it reaches the target. With `partial`, an unreachable target
     * gives a path to the reachable point closest to it; null only when the start is off the navmesh.
     */
    planPath(from: NavPoint, to: NavPoint, options: FindPathOptions = {}): NavPathResult | null {
        const snap = options.maxSnapDistance ?? this.defaultSnap();
        const start = this.nearest(from, snap);
        if (!start) return null;
        let goal = this.nearest(to, snap);
        let reachable = goal !== null;
        if (!goal) {
            if (!options.partial) return null;
            goal = this.nearest(to, FAR_SNAP, FAR_SNAP) ?? start;
        }
        const corridor = this.query.findPath(start.ref, goal.ref, start.raw, goal.raw, { maxPathPolys: MAX_PATH_POLYS });
        const polys: number[] = [];
        for (let i = 0; i < corridor.polys.size; i++) polys.push(corridor.polys.get(i));
        corridor.polys.destroy();
        if (!corridor.success || polys.length === 0) return null;
        if (statusDetail(corridor.status, Detour.DT_PARTIAL_RESULT) || polys[polys.length - 1] !== goal.ref) reachable = false;
        if (!reachable && !options.partial) return null;
        const end = reachable
            ? goal.raw
            : (() => {
                const closest = this.query.closestPointOnPoly(polys[polys.length - 1], { x: to.x, y: (to.y ?? goal.point.y) + this.rise, z: to.z }).closestPoint;
                return new THREE.Vector3(closest.x, closest.y, closest.z);
            })();
        const straight = this.query.findStraightPath(start.raw, end, polys, { maxStraightPathPoints: 256 });
        const points: THREE.Vector3[] = [];
        for (let i = 0; i < straight.straightPathCount; i++) {
            points.push(this.surface(straight.straightPath.get(i * 3), straight.straightPath.get(i * 3 + 1), straight.straightPath.get(i * 3 + 2)));
        }
        straight.straightPath.destroy();
        straight.straightPathFlags.destroy();
        straight.straightPathRefs.destroy();
        if (points.length === 0) return null;
        // The path starts where the agent stands (walking onto the navmesh first if it is off it) ...
        const origin = new THREE.Vector3(from.x, from.y ?? start.point.y, from.z);
        if (Math.hypot(origin.x - points[0].x, origin.z - points[0].z) > 0.05) points.unshift(origin);
        else points[0] = origin;
        // ... and ends on the target itself when the navmesh reaches it.
        if (reachable && Math.hypot(to.x - goal.point.x, to.z - goal.point.z) <= this.settings.agentRadius + 0.05) {
            points[points.length - 1] = new THREE.Vector3(to.x, to.y ?? goal.point.y, to.z);
        }
        if (points.length === 1) points.push(points[0].clone());
        return { points, reachable };
    }

    /**
     * Whether a point planPath cannot reach is shut off at ground level (a closed pen), rather than
     * out of reach in a way it may stop being: a point in the air or off the navmesh, or on a raised
     * top (a platform with no walkable way up), may still be reached by jumping or climbing. A point
     * without y is taken to be on the ground.
     */
    isWalledOff(point: NavPoint): boolean {
        if (point.y === undefined) return true;
        const standing = this.nearest(point, this.settings.agentRadius + 0.5, this.settings.maxStepHeight + 0.25);
        if (!standing) return false;
        return standing.point.y - this.groundHeight(point.x, point.z) <= this.settings.maxStepHeight + 0.1;
    }

    /**
     * Moves an agent from `from` toward `to` over the navmesh: it slides along walls and stops at
     * ledges. The height is the navmesh's, exact on flat surfaces and ramps but only flat between a
     * polygon's corners over curved ground, so agents in a physics world take theirs from it.
     * Null when `from` is off the navmesh.
     */
    moveAlongSurface(from: NavPoint, to: NavPoint): THREE.Vector3 | null {
        const start = this.nearest(from, this.settings.agentRadius + 0.5);
        if (!start) return null;
        const moved = this.query.moveAlongSurface(start.ref, start.raw, { x: to.x, y: start.raw.y, z: to.z });
        if (!moved.success) return null;
        const { x, z } = moved.resultPosition;
        const polygon = moved.visited.length > 0 ? moved.visited[moved.visited.length - 1] : start.ref;
        const height = this.query.getPolyHeight(polygon, moved.resultPosition);
        return this.surface(x, height.success ? height.height : moved.resultPosition.y, z);
    }

    /** True when an agent at `from` can walk straight to `to` (in plan view) without leaving the navmesh. */
    walkableLine(from: NavPoint, to: NavPoint): boolean {
        const start = this.nearest(from, this.settings.agentRadius + 0.5);
        if (!start) return false;
        const hit = this.query.raycast(start.ref, start.raw, { x: to.x, y: start.raw.y, z: to.z });
        // The hit fraction is huge when the ray reaches its end without meeting an edge.
        return hit.success && hit.t >= 1;
    }

    /** A random walkable point the agent at `center` can reach, about `radius` metres away at most; null off the navmesh. */
    randomPointAround(center: NavPoint, radius: number): THREE.Vector3 | null {
        const start = this.nearest(center, this.defaultSnap());
        if (!start) return null;
        const found = this.query.findRandomPointAroundCircle(start.raw, radius, { startRef: start.ref });
        if (!found.success) return null;
        const { x, y, z } = found.randomPoint;
        return this.surface(x, y, z);
    }

    /** Carves an upright cylinder (centre of its base, radius, height) out of the navmesh until removed. */
    addCylinderObstacle(base: NavPoint, radius: number, height: number): NavObstacleHandle {
        const handle: NavObstacleHandle = { obstacle: null };
        const added = this.tileCache.addCylinderObstacle({ x: base.x, y: (base.y ?? this.groundHeight(base.x, base.z)) + this.rise, z: base.z }, radius, height);
        if (added.success) {
            handle.obstacle = added.obstacle;
            this.obstacles.add(handle);
            this.dirty = true;
        }
        return handle;
    }

    removeObstacle(handle: NavObstacleHandle): void {
        if (!handle.obstacle || this.disposed) return;
        this.tileCache.removeObstacle(handle.obstacle);
        handle.obstacle = null;
        this.obstacles.delete(handle);
        this.dirty = true;
    }

    /** Rebuilds tiles obstacles touched; call once a frame. True when the walkable area changed. */
    update(): boolean {
        if (!this.dirty || this.disposed) return false;
        const result = this.tileCache.update(this.navMesh);
        if (!result.upToDate) return false;
        this.dirty = false;
        this.version++;
        return true;
    }

    /**
     * The walkable polygons as triangles, for drawing. A polygon is flat between its corners, which
     * lie on the surface, so over curved ground it dips under hills: triangles whose corners are on
     * the ground are cut into pieces about `maxEdge` long and laid onto it. Raised tops keep their shape.
     * `edges` holds the triangles' edges as pairs of points, laid on the ground the same way.
     */
    debugGeometry(maxEdge = 1): { positions: Float32Array; indices: Uint32Array; edges: Float32Array } {
        const [raw, rawIndices] = getNavMeshPositionsAndIndices(this.navMesh, POLY_FLAG_WALK);
        const positions: number[] = [];
        const indices: number[] = [];
        const edges: number[] = [];
        const drawnEdges = new Set<string>();
        const corner = (i: number) => new THREE.Vector3(raw[i * 3], raw[i * 3 + 1] - this.rise, raw[i * 3 + 2]);
        const onGround = (point: THREE.Vector3) => Math.abs(point.y - this.groundHeight(point.x, point.z)) <= this.settings.maxStepHeight + this.rise;
        const point = new THREE.Vector3();
        for (let t = 0; t + 2 < rawIndices.length; t += 3) {
            const [a, b, c] = [corner(rawIndices[t]), corner(rawIndices[t + 1]), corner(rawIndices[t + 2])];
            const draped = onGround(a) && onGround(b) && onGround(c);
            const longest = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
            const n = draped ? Math.min(32, Math.max(1, Math.ceil(longest / maxEdge))) : 1;
            // Corners (i, j) of the subdivided triangle, a + (b - a) i / n + (c - a) j / n, i + j <= n.
            const base = positions.length / 3;
            const at = (i: number, j: number) => base + (i * (2 * n + 3 - i)) / 2 + j;
            for (let i = 0; i <= n; i++) {
                for (let j = 0; j <= n - i; j++) {
                    point.copy(a).addScaledVector(b.clone().sub(a), i / n).addScaledVector(c.clone().sub(a), j / n);
                    positions.push(point.x, draped ? this.groundHeight(point.x, point.z) : point.y, point.z);
                }
            }
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n - i; j++) {
                    indices.push(at(i, j), at(i + 1, j), at(i, j + 1));
                    if (j + 1 < n - i) indices.push(at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
                }
            }
            const ends = [rawIndices[t], rawIndices[t + 1], rawIndices[t + 2]];
            [[a, b, 0, 1], [b, c, 1, 2], [c, a, 2, 0]].forEach(([from, to, i, j]) => {
                const start = from as THREE.Vector3;
                const end = to as THREE.Vector3;
                const key = [ends[i as number], ends[j as number]].sort((x, y) => x - y).join(':');
                if (drawnEdges.has(key)) return;
                drawnEdges.add(key);
                const pieces = draped ? Math.min(64, Math.max(1, Math.ceil(start.distanceTo(end) / maxEdge))) : 1;
                for (let k = 0; k < pieces; k++) {
                    for (const s of [k / pieces, (k + 1) / pieces]) {
                        point.copy(start).lerp(end, s);
                        edges.push(point.x, draped ? this.groundHeight(point.x, point.z) : point.y, point.z);
                    }
                }
            });
        }
        return { positions: new Float32Array(positions), indices: new Uint32Array(indices), edges: new Float32Array(edges) };
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.query.destroy();
        this.tileCache.destroy();
        this.navMesh.destroy();
        this.owned.forEach(destroyRaw);
    }
}

/** Index of the waypoint an agent at `position` should steer toward, skipping those within reachRadius (XZ). */
export function advanceWaypoint(path: readonly NavPoint[], index: number, position: NavPoint, reachRadius: number): number {
    if (path.length === 0) return 0;
    let current = Math.min(Math.max(1, index), path.length - 1);
    const reach = reachRadius * reachRadius;
    while (current < path.length - 1) {
        const dx = path[current].x - position.x;
        const dz = path[current].z - position.z;
        if (dx * dx + dz * dz > reach) break;
        current++;
    }
    return current;
}
