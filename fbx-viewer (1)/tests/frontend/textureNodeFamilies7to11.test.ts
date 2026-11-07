import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PHOTO_NODES, atlasPlace, pickBand, shadingFit } from '../../texturing/graph/nodes/photo';
import { closedCut, seamMasks, seamTile, type Picture } from '../../texturing/graph/seamCut';
import { textureNodeDefinitionByType } from '../../texturing/graph/registry';
import { nearestOn, placementsAlong, quadPlace, resample, segmentsOf, simplify, smoothPath, traceOutlines, windingAt, wrapOffsets, type Point } from '../../texturing/graph/curves';
import { SPLINE_NODES, outlinePaths, scatterRows, strokeAt } from '../../texturing/graph/nodes/splines';
import { addPoint, dragOrbit, dragPoint, removePoint, type PointList } from '../../components/Texturing/view2d';
import { SDF_NODES, primitiveDistance, sdfCombine, sdfHeightAt, sdfScene, viewUniforms } from '../../texturing/graph/nodes/sdf';
import { MEASURED_F0, PBR_CHECK_NODES, albedoFinding, f0AsBaseColour, linearToSrgb, pbrFinding, pbrLimits, srgbToLinear } from '../../texturing/graph/nodes/pbrChecks';
import { WEATHERING_REFERENCES, standInPanels } from '../../texturing/graph/nodes/weathering';
import { coerceParam, defaultNodeParams } from '../../texturing/graph/document';
import { VECTOR_NODES, combineDistances, decodeDistance, encodeDistance, insideByRule, shapeDistance, vectorShapeAt } from '../../texturing/graph/nodes/vector';
import { fitToPicture, parsePathData, parseSvg } from '../../texturing/graph/svgPaths';

/** A smooth random picture that does not tile: a slope across it and lumps of noise. */
const photo = (width: number, height: number, seed = 1): Picture => {
    let state = seed * 9301 + 49297;
    const random = () => { state = (state * 233280 + 49297) % 2147483647; return state / 2147483647; };
    const bumps = Array.from({ length: 12 }, () => [random() * width, random() * height, 4 + random() * 10, random() - 0.5]);
    const data = new Float32Array(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let v = 0.2 + 0.5 * (x / width) + 0.2 * (y / height);
            for (const [bx, by, r, a] of bumps) v += a * Math.exp(-((x - bx) ** 2 + (y - by) ** 2) / (r * r));
            for (let c = 0; c < 3; c++) data[(y * width + x) * 3 + c] = v * (0.8 + 0.1 * c);
        }
    }
    return { data, width, height, channels: 3 };
};

const at = (p: Picture, x: number, y: number, c = 0) => p.data[(((y % p.height) + p.height) % p.height * p.width + (((x % p.width) + p.width) % p.width)) * p.channels + c];

/** The mean step between neighbours across the wrap (left and right edges, top and bottom) and inside. */
const steps = (p: Picture) => {
    let wrap = 0;
    let inside = 0;
    let n = 0;
    for (let y = 0; y < p.height; y++) { wrap += Math.abs(at(p, 0, y) - at(p, p.width - 1, y)); n++; }
    for (let x = 0; x < p.width; x++) { wrap += Math.abs(at(p, x, 0) - at(p, x, p.height - 1)); n++; }
    let m = 0;
    for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width - 1; x++) { inside += Math.abs(at(p, x, y) - at(p, x + 1, y)); m++; }
    return { wrap: wrap / n, inside: inside / m };
};

describe('photo and scan processing', () => {
    it('finds the cheapest cut down a band, closing up top to bottom', () => {
        const height = 40;
        const groove = (y: number) => 10 + Math.round(4 * Math.sin((y / height) * Math.PI * 2));
        const path = closedCut((x, y) => (x === groove(y) ? 0 : 1), 3, 20, height);
        for (let y = 0; y < height; y++) expect(path[y]).toBe(groove(y));
        // With nothing to follow it still stays in its band and its ends meet.
        const flat = closedCut((x, y) => ((x * 7 + y * 13) % 5) / 5, 5, 15, height);
        expect(Math.abs(flat[0] - flat[height - 1])).toBeLessThanOrEqual(1);
        for (let y = 0; y < height; y++) { expect(flat[y]).toBeGreaterThanOrEqual(5); expect(flat[y]).toBeLessThan(15); }
        for (let y = 1; y < height; y++) expect(Math.abs(flat[y] - flat[y - 1])).toBeLessThanOrEqual(1);
    });

    it('makes a photo tile by cutting, every pixel its own, with no seam where it repeats', () => {
        const input = photo(64, 64);
        const before = steps(input);
        expect(before.wrap).toBeGreaterThan(before.inside * 5);
        const masks = seamMasks(input, 12);
        const tiled = seamTile(input, masks);
        const after = steps(tiled);
        expect(after.wrap).toBeLessThan(after.inside * 2.5);
        // No ghosting: each pixel is one of the four pixels of the photo it may come from, never a mix.
        for (let y = 0; y < 64; y++) {
            for (let x = 0; x < 64; x++) {
                const value = at(tiled, x, y);
                const sources = [at(input, x, y), at(input, x - 32, y), at(input, x, y + 32), at(input, x - 32, y + 32)];
                expect(sources.some((source) => Math.abs(source - value) < 1e-6), `${x},${y}`).toBe(true);
            }
        }
        // The middle of the photo is left as it was.
        for (let y = 28; y < 36; y++) for (let x = 28; x < 36; x++) expect(at(tiled, x, y)).toBeCloseTo(at(input, x, y), 6);
    });

    it('chooses the narrowest band that hides its joins about as well as the best', () => {
        expect(pickBand([1, 0.5, 0.45, 0.44])).toBe(1);
        expect(pickBand([0.3, 0.29, 0.28, 0.2])).toBe(3);
        expect(pickBand([0.1, 0.1, 0.1, 0.1])).toBe(0);
    });

    it('finds the direction of baked-in light from slopes and brightness', () => {
        let state = 7;
        const random = () => { state = (state * 16807) % 2147483647; return state / 2147483647; };
        const sums = { nx: 0, ny: 0, l: 0, nxx: 0, nyy: 0, nxy: 0, lnx: 0, lny: 0 };
        const n = 4000;
        for (let i = 0; i < n; i++) {
            const nx = (random() - 0.5) * 0.6;
            const ny = (random() - 0.5) * 0.6;
            const l = 0.5 + 0.2 * nx - 0.1 * ny;
            sums.nx += nx / n; sums.ny += ny / n; sums.l += l / n;
            sums.nxx += (nx * nx) / n; sums.nyy += (ny * ny) / n; sums.nxy += (nx * ny) / n; sums.lnx += (l * nx) / n; sums.lny += (l * ny) / n;
        }
        const fit = shadingFit(sums);
        expect(fit.a).toBeCloseTo(0.2, 4);
        expect(fit.b).toBeCloseTo(-0.1, 4);
        expect(fit.mean).toBeCloseTo(0.5, 2);
        // Flat (no slopes at all): nothing to fit, nothing taken out.
        expect(shadingFit({ nx: 0, ny: 0, l: 0.4, nxx: 0, nyy: 0, nxy: 0, lnx: 0, lny: 0 })).toMatchObject({ a: 0, b: 0 });
    });

    it('takes atlas pieces counted from the top left', () => {
        expect(atlasPlace(0, 0, 4, 4, 1)).toEqual([0, 0.75]);
        expect(atlasPlace(0, 0, 4, 4, 6)).toEqual([0.25, 0.5]);
        expect(atlasPlace(1, 1, 4, 4, 16)).toEqual([1, 0.25]);
        const [u, v] = atlasPlace(0, 0, 2, 2, 1, 0.1);
        expect(u).toBeCloseTo(0.05, 9);
        expect(v).toBeCloseTo(0.55, 9);
    });

    it('every node says what it does, in its own group', () => {
        for (const definition of PHOTO_NODES) {
            expect(definition.category, definition.type).toBe('Photo and scans');
            expect(definition.description.length, definition.type).toBeGreaterThan(40);
            expect(textureNodeDefinitionByType(definition.type), definition.type).toBe(definition);
        }
        expect(textureNodeDefinitionByType('makeTile')?.params.find((param) => param.key === 'method')?.default).toBe('seams');
    });
});

describe('splines and paths', () => {
    const edgeGap = (picture: (u: number, v: number) => number): number => {
        let gap = 0;
        for (let i = 0; i <= 60; i++) {
            const t = (i + 0.37) / 61;
            gap = Math.max(gap, Math.abs(picture(0, t) - picture(1, t)), Math.abs(picture(t, 0) - picture(t, 1)));
        }
        return gap;
    };

    it('runs a smooth curve through its points, from straight to smooth', () => {
        const points: Point[] = [[0.1, 0.1], [0.5, 0.8], [0.9, 0.2]];
        const smooth = smoothPath(points, false, 1, 8);
        expect(smooth[0]).toEqual([0.1, 0.1]);
        expect(smooth[8][0]).toBeCloseTo(0.5, 9);
        expect(smooth[8][1]).toBeCloseTo(0.8, 9);
        expect(smooth[smooth.length - 1]).toEqual([0.9, 0.2]);
        expect(smoothPath(points, false, 0)).toEqual(points);
        const loop = smoothPath(points, true, 1, 4);
        expect(loop[loop.length - 1]).toEqual(loop[0]);
    });

    it('finds the nearest place on a path, which side, and how far along', () => {
        const segments = segmentsOf([[[0, 0.5], [0.5, 0.5], [1, 0.5]]]);
        const hit = nearestOn([0.7, 0.6], segments);
        expect(hit.distance).toBeCloseTo(0.1, 9);
        expect(hit.along).toBeCloseTo(0.7, 9);
        expect(hit.side).toBe(1);
        expect(nearestOn([0.7, 0.4], segments).side).toBe(-1);
        const square = segmentsOf([[[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8], [0.2, 0.2]]]);
        expect(Math.abs(windingAt([0.5, 0.5], square))).toBe(1);
        expect(windingAt([0.9, 0.5], square)).toBe(0);
    });

    it('keeps a curve over the edge tiling: it comes back on the other side', () => {
        const params = { points: [[0.6, 0.3], [0.95, 0.5], [1.25, 0.55]], closed: false, smoothness: 1, width: 0.08, softness: 0.3, taper: 0 };
        const tiled = (u: number, v: number) => strokeAt(params, u, v, [true, true]);
        expect(tiled(0.1, 0.55)).toBeGreaterThan(0.5);
        expect(edgeGap(tiled)).toBeLessThan(1e-9);
        // Not tiling, it stops at the edge.
        expect(edgeGap((u, v) => strokeAt(params, u, v, [false, false]))).toBeGreaterThan(0.5);
        expect(wrapOffsets(segmentsOf([[[0.9, 0.5], [1.1, 0.5]]]), 0.01, [true, true]).map((o) => o.join(','))).toEqual(expect.arrayContaining(['0,0', '1,0']));
    });

    it('finds a place inside a quad between two curves again', () => {
        const a: Point = [0.1, 0.2]; const b: Point = [0.6, 0.1]; const c: Point = [0.2, 0.7]; const d: Point = [0.7, 0.9];
        const mapped = (s: number, t: number): Point => [0, 1].map((k) => a[k] * (1 - s) * (1 - t) + b[k] * s * (1 - t) + c[k] * (1 - s) * t + d[k] * s * t) as Point;
        for (const [s, t] of [[0.3, 0.6], [0.9, 0.1], [0.5, 0.5]]) {
            const found = quadPlace(mapped(s, t), a, b, c, d)!;
            expect(found[0]).toBeCloseTo(s, 6);
            expect(found[1]).toBeCloseTo(t, 6);
        }
        expect(quadPlace([0.95, 0.05], a, b, c, d)).toBeNull();
    });

    it('spaces copies evenly along a curve, round a closed one meeting up', () => {
        const circle = Array.from({ length: 401 }, (_, i): Point => [0.5 + Math.cos((i / 400) * Math.PI * 2) / (2 * Math.PI), 0.5 + Math.sin((i / 400) * Math.PI * 2) / (2 * Math.PI)]);
        const placed = placementsAlong(circle, 0.1, true);
        expect(placed.length).toBe(10);
        for (let i = 1; i < placed.length; i++) expect(placed[i].along - placed[i - 1].along).toBeCloseTo(0.1, 3);
        expect(resample([[0, 0], [1, 0]], 5).map((p) => p[0])).toEqual([0, 0.25, 0.5, 0.75, 1]);
    });

    it('traces a mask\'s outlines into closed paths, and runs a band\'s round the repeating picture', () => {
        const n = 32;
        const disc = new Float32Array(n * n);
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) disc[y * n + x] = Math.hypot((x + 0.5) / n - 0.5, (y + 0.5) / n - 0.5) < 0.25 ? 1 : 0;
        const outlines = traceOutlines(disc, n, n, 0.5);
        expect(outlines.length).toBe(1);
        const loop = outlines[0];
        expect(loop[loop.length - 1]).toEqual(loop[0]);
        for (const [u, v] of loop) expect(Math.abs(Math.hypot(u - 0.5, v - 0.5) - 0.25)).toBeLessThan(0.04);
        const band = new Float32Array(n * n);
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) band[y * n + x] = y >= 10 && y < 20 ? 1 : 0;
        const edges = traceOutlines(band, n, n, 0.5);
        expect(edges.length).toBe(2);
        for (const path of edges) expect(Math.abs(path[path.length - 1][0] - path[0][0])).toBeCloseTo(1, 6);
        expect(simplify([[0, 0], [0.25, 0], [0.5, 1e-5], [1, 0]], 1e-3)).toEqual([[0, 0], [1, 0]]);
        expect(outlinePaths(disc, n, n, 0.5, 0.002, 0.5).length).toBe(1);
    });

    it('adds, moves and takes away points from the 2D view', () => {
        const lists: PointList[] = [{ key: 'points', points: [[0.1, 0.5], [0.5, 0.5], [0.9, 0.5]], path: [[0.1, 0.5], [0.9, 0.5]], closed: false, least: 2 }];
        // Near a span: into it.
        expect(addPoint(lists, [0.3, 0.51], 0.05)).toEqual({ points: [[0.1, 0.5], [0.3, 0.51], [0.5, 0.5], [0.9, 0.5]] });
        // Away from it: at the nearer end.
        expect(addPoint(lists, [0.0, 0.9], 0.05)).toEqual({ points: [[0, 0.9], [0.1, 0.5], [0.5, 0.5], [0.9, 0.5]] });
        expect(addPoint(lists, [1.0, 0.9], 0.05)?.points.at(-1)).toEqual([1, 0.9]);
        expect(dragPoint(lists, 'points:1', [0.4, 0.2])).toEqual({ points: [[0.1, 0.5], [0.4, 0.2], [0.9, 0.5]] });
        expect(removePoint(lists, 'points:0')).toEqual({ points: [[0.5, 0.5], [0.9, 0.5]] });
        expect(removePoint([{ ...lists[0], points: [[0, 0], [1, 1]] }], 'points:0')).toBeNull();
        // Two curves: the click goes to the nearer.
        const two: PointList[] = [lists[0], { key: 'curveB', points: [[0.1, 0.9], [0.9, 0.9]], path: [], closed: false, least: 2 }];
        expect(Object.keys(addPoint(two, [0.5, 0.88], 0.05) ?? {})).toEqual(['curveB']);
        // Settings read back clean.
        expect(coerceParam(textureNodeDefinitionByType('curve')!.params.find((param) => param.key === 'points')!, [[0.2, 'x'], 'no', [0.3, 0.4]])).toEqual([[0.2, 0.5], [0.3, 0.4]]);
    });

    it('every node says what it does, in its own group, and the copies follow their seed', () => {
        for (const definition of SPLINE_NODES) {
            expect(definition.category, definition.type).toBe('Splines and paths');
            expect(definition.description.length, definition.type).toBeGreaterThan(40);
            expect(definition.params.some((param) => param.kind === 'points') || definition.type === 'maskToPaths', definition.type).toBe(true);
        }
        const params = { points: [[0.1, 0.5], [0.9, 0.5]], spacing: 0.1, size: 0.05, sizeRandom: 0.5, turnRandom: 30, shiftRandom: 0.02 };
        expect(scatterRows(params, 3)).toEqual(scatterRows(params, 3));
        expect(scatterRows(params, 3)).not.toEqual(scatterRows(params, 4));
        expect(scatterRows(params, 3).length).toBe(8);
    });
});

describe('vector shapes', () => {
    it('measures exact distances to polygons, stars, rounded boxes and ellipses', () => {
        // A hexagon with a corner at the top: the corner is on the edge, the middle an apothem inside.
        expect(shapeDistance([0, 1], 'polygon', 6, 0.5, 0)).toBeCloseTo(0, 9);
        expect(shapeDistance([0, 0], 'polygon', 6, 0.5, 0)).toBeCloseTo(-Math.cos(Math.PI / 6), 9);
        expect(shapeDistance([0, 2], 'polygon', 6, 0.5, 0)).toBeCloseTo(1, 9);
        // A five-pointed star: a tip and a valley on the edge, the middle inside.
        expect(shapeDistance([0, 1], 'star', 5, 0.4, 0)).toBeCloseTo(0, 9);
        expect(shapeDistance([0.4 * Math.sin(Math.PI / 5), 0.4 * Math.cos(Math.PI / 5)], 'star', 5, 0.4, 0)).toBeCloseTo(0, 9);
        expect(shapeDistance([0, 0], 'star', 5, 0.4, 0)).toBeLessThan(0);
        expect(shapeDistance([0, 0.7], 'star', 5, 0.4, 0)).toBeLessThan(0);
        expect(shapeDistance([0.5, 0.7], 'star', 5, 0.4, 0)).toBeGreaterThan(0);
        // A box, then with its corners rounded.
        expect(shapeDistance([2, 0], 'box', 4, 0.5, 0)).toBeCloseTo(1, 9);
        expect(shapeDistance([0, 0], 'box', 4, 0.5, 0)).toBeCloseTo(-1, 9);
        expect(shapeDistance([1, 1], 'box', 4, 0.5, 0.5)).toBeCloseTo(Math.SQRT2 * 0.5 - 0.5, 9);
        expect(shapeDistance([0.3, 0.4], 'ellipse', 4, 0.5, 0)).toBeCloseTo(-0.5, 9);
    });

    it('keeps repeated shapes tiling, and turns distances into a picture and back', () => {
        const params = { shape: 'star', sides: 5, inner: 0.45, rounding: 0.1, centre: [0.37, 0.61], size: 1.1, stretch: [1, 0.8], rotation: 17, tiling: 3, outline: 0 };
        const edgeGap = (picture: (u: number, v: number) => number) => {
            let gap = 0;
            for (let i = 0; i <= 50; i++) { const t = (i + 0.29) / 51; gap = Math.max(gap, Math.abs(picture(0, t) - picture(1, t)), Math.abs(picture(t, 0) - picture(t, 1))); }
            return gap;
        };
        expect(edgeGap((u, v) => vectorShapeAt(params, u, v))).toBeLessThan(1e-9);
        expect(vectorShapeAt({ shape: 'ellipse', centre: [0.5, 0.5], size: 0.8, tiling: 1 }, 0.5, 0.5)).toBeCloseTo(-0.4, 9);
        expect(decodeDistance(encodeDistance(-0.123))).toBeCloseTo(-0.123, 12);
        expect(encodeDistance(0)).toBe(0.5);
    });

    it('combines shapes: joined, cut, overlapped or not, hard or smooth', () => {
        expect(combineDistances(-0.1, 0.2, 'union', 0)).toBe(-0.1);
        expect(combineDistances(-0.1, -0.05, 'subtract', 0)).toBeCloseTo(0.05, 12);
        expect(combineDistances(-0.1, 0.2, 'intersect', 0)).toBe(0.2);
        expect(combineDistances(-0.1, -0.2, 'exclude', 0)).toBeCloseTo(0.1, 12);
        expect(combineDistances(-0.1, 0.3, 'exclude', 0)).toBeCloseTo(-0.1, 12);
        // Smooth joins fill in where two shapes meet.
        expect(combineDistances(0.01, 0.01, 'union', 0.05)).toBeLessThan(0.01);
        expect(combineDistances(0.3, -0.2, 'union', 0.05)).toBe(-0.2);
    });

    it('reads SVG path data, shapes and transforms, and fits them into the picture', () => {
        const square = parsePathData('M0 0 L10 0 L10 10 L0 10 Z');
        expect(square).toEqual([{ points: [[0, 0], [10, 0], [10, 10], [0, 10]], closed: true }]);
        expect(parsePathData('m 5 5 h 10 v 10 h -10 z')[0].points).toEqual([[5, 5], [15, 5], [15, 15], [5, 15]]);
        expect(parsePathData('M0,0 10,0 10-5')[0].points).toEqual([[0, 0], [10, 0], [10, -5]]);
        const curve = parsePathData('M 0 0 C 0 10 10 10 10 0')[0].points;
        expect(curve[curve.length - 1]).toEqual([10, 0]);
        const arc = parsePathData('M 0 0 A 50 50 0 0 1 100 0')[0].points;
        for (const [x, y] of arc) expect(Math.hypot(x - 50, y)).toBeCloseTo(50, 6);
        expect(arc.some(([x, y]) => Math.abs(x - 50) < 5 && Math.abs(y + 50) < 1)).toBe(true);
        const drawing = parseSvg('<svg xmlns="http://www.w3.org/2000/svg"><g transform="translate(10 0)"><rect x="0" y="0" width="10" height="5"/></g><circle cx="5" cy="5" r="2"/><defs><path d="M0 0 L1 1"/></defs></svg>');
        expect(drawing.length).toBe(2);
        expect(drawing[0].points).toEqual([[10, 0], [20, 0], [20, 5], [10, 5]]);
        expect(drawing[1].points.length).toBe(64);
        const fitted = fitToPicture(square, 0.1);
        const us = fitted[0].points.map((p) => p[0]);
        const vs = fitted[0].points.map((p) => p[1]);
        expect(Math.min(...us)).toBeCloseTo(0.1, 9);
        expect(Math.max(...us)).toBeCloseTo(0.9, 9);
        // SVG's y runs down: its first point (top left) lands at the top of the picture.
        expect(fitted[0].points[0][1]).toBeCloseTo(0.9, 9);
        expect(Math.min(...vs)).toBeCloseTo(0.1, 9);
        expect(insideByRule(2, 'evenodd')).toBe(false);
        expect(insideByRule(2, 'nonzero')).toBe(true);
    });

    it('every node says what it does', () => {
        for (const definition of VECTOR_NODES) expect(definition.description.length, definition.type).toBeGreaterThan(40);
    });
});

describe('SDF shapes', () => {
    const base = { aKind: 'sphere', aAt: [0, 0], aRaise: 0, aSize: 0.3, aStretch: [1, 1], aTall: 1, aTurn: 0, aTilt: 0, aThickness: 0.05, bOp: 'none', cOp: 'none', repeat: 1, range: 0.5, twist: 0, bend: 0 };

    it('measures each primitive exactly', () => {
        expect(primitiveDistance('sphere', [0.3, 0, 0], 0.3, [1, 1], 1, 0)).toBeCloseTo(0, 9);
        expect(primitiveDistance('box', [0.5, 0, 0], 0.22, [1, 1], 1, 0)).toBeCloseTo(0.28, 9);
        expect(primitiveDistance('box', [0, 0, 0], 0.22, [2, 1], 1, 0)).toBeCloseTo(-0.22, 9);
        expect(primitiveDistance('torus', [0.2, 0, 0], 0.2, [1, 1], 1, 0.05)).toBeCloseTo(-0.05, 9);
        expect(primitiveDistance('torus', [0, 0, 0], 0.2, [1, 1], 1, 0.05)).toBeCloseTo(0.15, 9);
        expect(primitiveDistance('capsule', [0.3, 0, 0], 0.25, [1, 1], 1, 0.05)).toBeCloseTo(0, 9);
        expect(primitiveDistance('cylinder', [0, 0, 0.2], 0.2, [1, 1], 1, 0)).toBeCloseTo(0, 9);
        expect(primitiveDistance('cylinder', [0.3, 0, 0], 0.2, [1, 1], 1, 0)).toBeCloseTo(0.1, 9);
        expect(sdfCombine(-0.1, 0.2, 'union', 0)).toBe(-0.1);
        expect(sdfCombine(-0.1, -0.05, 'subtract', 0)).toBeCloseTo(0.05, 12);
        expect(sdfCombine(-0.1, 0.2, 'intersect', 0)).toBe(0.2);
    });

    it('draws the height looking down, and cuts lower it', () => {
        expect(sdfHeightAt(base, 0.5, 0.5)).toBeCloseTo(0.6, 2);
        expect(sdfHeightAt(base, 0.02, 0.02)).toBe(0);
        const cut = { ...base, bOp: 'subtract', bKind: 'sphere', bAt: [0, 0], bRaise: 0.3, bSize: 0.15, bStretch: [1, 1], bTall: 1, bTurn: 0, bTilt: 0, bThickness: 0, bSmooth: 0 };
        expect(sdfHeightAt(cut, 0.5, 0.5)).toBeLessThan(sdfHeightAt(base, 0.5, 0.5) - 0.2);
        expect(sdfScene(base, [1, 0, 0.1])).toBeCloseTo(sdfScene(base, [0, 0, 0.1]), 9);
    });

    it('keeps repeats tiling, a shape over the edge coming round', () => {
        const over = { ...base, aKind: 'box', aAt: [0.42, -0.3], aSize: 0.18, aStretch: [1.4, 0.8], aTurn: 25, aThickness: 0.03, repeat: 2, twist: 40 };
        let gap = 0;
        for (let i = 0; i <= 24; i++) {
            const t = (i + 0.41) / 25;
            gap = Math.max(gap, Math.abs(sdfHeightAt(over, 0, t) - sdfHeightAt(over, 1, t)), Math.abs(sdfHeightAt(over, t, 0) - sdfHeightAt(over, t, 1)));
        }
        expect(gap).toBeLessThan(1e-6);
        // The box reaches over the right edge, so it shows at the left.
        expect(sdfHeightAt(over, 0.02, 0.1)).toBeGreaterThan(0);
    });

    it('stands the 3D view\'s camera round the scene, and says what it does', () => {
        const { uEye, uTarget } = viewUniforms({ yaw: 90, pitch: 30, zoom: 2, range: 0.5 });
        expect(uEye.distanceTo(uTarget)).toBeCloseTo(1.2, 9);
        expect(uEye.x - uTarget.x).toBeCloseTo(0, 9);
        expect(uEye.z).toBeGreaterThan(uTarget.z);
        for (const definition of SDF_NODES) expect(definition.description.length).toBeGreaterThan(40);
        expect(dragOrbit([0.75, 0.5])).toEqual({ yaw: 90, pitch: 45 });
    });
});

describe('PBR checks', () => {
    it('finds base colours outside the range real non-metals have', () => {
        expect(albedoFinding([20 / 255, 20 / 255, 20 / 255], 30, 240)).toBe(-1);
        expect(albedoFinding([0.5, 0.5, 0.5], 30, 240)).toBe(0);
        expect(albedoFinding([250 / 255, 250 / 255, 250 / 255], 30, 240)).toBe(1);
        expect(linearToSrgb(srgbToLinear(0.37))).toBeCloseTo(0.37, 9);
    });

    it('finds half-metal, metal too dark and mirror-smooth surfaces', () => {
        const limits = pbrLimits({});
        expect(pbrFinding([0.8, 0.8, 0.8], 0.5, 0.4, limits)).toBe('half');
        expect(pbrFinding([0.3, 0.3, 0.3], 1, 0.4, limits)).toBe('darkMetal');
        expect(pbrFinding([0.5, 0.5, 0.5], 0, 0.01, limits)).toBe('mirror');
        expect(pbrFinding([0.5, 0.5, 0.5], 0, 0.5, limits)).toBeNull();
        // Every measured metal passes as a metal; every other material reflects little.
        for (const entry of MEASURED_F0) {
            if (entry.metal) expect(pbrFinding(f0AsBaseColour(entry.key), 1, 0.4, limits), entry.key).toBeNull();
            else expect(Math.max(...entry.f0), entry.key).toBeLessThan(0.2);
        }
        const gold = f0AsBaseColour('gold').map((value) => Math.round(value * 255));
        expect(gold[0]).toBe(255);
        expect(gold[2]).toBeLessThan(gold[1]);
        for (const definition of PBR_CHECK_NODES) {
            expect(definition.category).toBe('Checks');
            expect(definition.description.length).toBeGreaterThan(40);
        }
    });
});

describe('weathering on stand-ins', () => {
    const SEED = 77.5;
    const edgeGap = (picture: (u: number, v: number) => number) => {
        let gap = 0;
        for (let i = 0; i <= 50; i++) { const t = (i + 0.29) / 51; gap = Math.max(gap, Math.abs(picture(0, t) - picture(1, t)), Math.abs(picture(t, 0) - picture(t, 1))); }
        return gap;
    };

    it('gives edge-based wear stand-in panel edges to wear, still tiling', () => {
        const params = defaultNodeParams(textureNodeDefinitionByType('edgeWear')!);
        const wear = (u: number, v: number) => WEATHERING_REFERENCES.edgeWear(u, v, standInPanels(u, v), params, SEED);
        let sum = 0;
        for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) sum += wear((x + 0.5) / 48, (y + 0.5) / 48);
        expect(sum / 2304).toBeGreaterThan(0.03);
        expect(edgeGap(wear)).toBeLessThan(1e-9);
        // The middle of a panel is flat: nothing to wear there.
        expect(wear(0.5, 0.5)).toBe(0);
    });

    it('says so on the node when there is no curvature map, and not when one is wired', async () => {
        const definition = textureNodeDefinitionByType('edgeWear')!;
        const run = async (wired: boolean) => {
            const notes: string[] = [];
            const context = {
                params: defaultNodeParams(definition), tiling: [true, true], seed: 1,
                input: (key: string) => (wired && key === 'curvature' ? { kind: 'gray', width: 4, height: 4 } : null),
                external: () => null,
                gpu: { constant: () => ({}) },
                image: () => ({}),
                pass: async () => undefined,
                note: (text: string) => notes.push(text),
            };
            await definition.run(context as never);
            return notes;
        };
        expect((await run(false))[0]).toMatch(/^No curvature map: /);
        expect(await run(true)).toEqual([]);
    });
});

describe('shaders', () => {
    /** Names every pass already declares (its prelude and the kit): a node declaring one again does not compile. */
    const TAKEN = ['uSize', 'vUv', 'outColor', 'uSeed', 'uTiles', 'uWorld', 'uIteration', 'uIterations', 'uTime', 'uPhase'];
    it('never declare a name the pass already has', () => {
        const folder = resolve(__dirname, '../../texturing/graph/nodes');
        for (const file of readdirSync(folder).filter((name) => name.endsWith('.ts'))) {
            const source = readFileSync(resolve(folder, file), 'utf8');
            for (const name of TAKEN) {
                // Raw passes that set uWorld themselves (curvature) declare it: only kit passes may not.
                if (name === 'uWorld' && file === 'distance.ts') continue;
                if (name === 'uSeed' && file === 'scatter.ts') continue;
                expect(source, `${file} declares ${name}`).not.toMatch(new RegExp(`uniform\\s+\\w+\\s+${name}\\b`));
            }
        }
    });

    it('outside the nodes, no pass declares the size every pass already has', () => {
        // The UDIM atlas pass once declared uSize again and failed to compile. The two files that write a
        // pass's prelude declare it on purpose.
        const root = resolve(__dirname, '../../texturing');
        const preludes = new Set(['gpu/textureGpu.ts', 'bake/uvRaster.ts']);
        const files = (readdirSync(root, { recursive: true }) as string[])
            .map((name) => name.split('\\').join('/'))
            .filter((name) => name.endsWith('.ts') && !name.startsWith('graph/nodes/') && !preludes.has(name));
        expect(files.length).toBeGreaterThan(20);
        for (const file of files) {
            const source = readFileSync(resolve(root, file), 'utf8');
            expect(source, `${file} declares uSize`).not.toMatch(/uniform\s+\w+\s+uSize\b/);
        }
    });
});
