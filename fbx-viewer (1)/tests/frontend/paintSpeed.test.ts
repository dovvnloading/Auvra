import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DirtyRegion, alignRect, clampRect, expandRect, rect, rectArea, rectOfUvBox, rectsOverlap, unionRect } from '../../texturing/paint/regions';
import { PAGE_SIZE, SparsePicture, pageSizeFor, pagesIn, type PageGpu } from '../../texturing/paint/sparsePicture';
import { channelsReadAnywhere, dependentChannels, stackReach } from '../../texturing/paint/paintStack';
import { mirrorsOf, uvFootprint } from '../../texturing/paint/strokes';
import { createPaintDocument, newFillLayer, newFilterLayer, newFolder, type PaintLayer } from '../../texturing/paint/paintTypes';
import type { GpuImage } from '../../texturing/gpu/textureGpu';

/** Records what a sparse picture asks of the GPU, without one. */
const fakeGpu = () => {
    const made: GpuImage[] = [];
    const released: GpuImage[] = [];
    const passes: Array<{ target: unknown; fragment: string; scissor?: { x: number; y: number; width: number; height: number } }> = [];
    const gpu: PageGpu = {
        image: (width, height, kind, precision = 8) => {
            const image = { width, height, kind, precision, refs: 1, target: {} } as unknown as GpuImage;
            made.push(image);
            return image;
        },
        release: (image) => { if (image) released.push(image); },
        passNow: (target, options) => { passes.push({ target, fragment: options.fragment, scissor: options.scissor }); },
    };
    return { gpu, made, released, passes };
};

describe('changed areas', () => {
    it('measures, joins, grows and clamps rectangles', () => {
        expect(rectArea(rect(2, 3, 6, 5))).toBe(8);
        expect(rectArea(rect(5, 5, 4, 9))).toBe(0);
        expect(unionRect(rect(0, 0, 2, 2), rect(5, 6, 7, 8))).toEqual(rect(0, 0, 7, 8));
        expect(rectsOverlap(rect(0, 0, 4, 4), rect(4, 0, 8, 4))).toBe(false);
        expect(rectsOverlap(rect(0, 0, 4, 4), rect(3, 3, 8, 8))).toBe(true);
        expect(expandRect(rect(10, 10, 20, 20), 3)).toEqual(rect(7, 7, 23, 23));
        expect(clampRect(rect(-5.5, 2.2, 300.1, 40.6), 256)).toEqual(rect(0, 2, 256, 41));
    });

    it('finds the texels a box of texture coordinates covers, with a margin, inside the picture', () => {
        expect(rectOfUvBox(0.25, 0.5, 0.5, 0.75, 1024, 2)).toEqual(rect(254, 510, 514, 770));
        expect(rectOfUvBox(-0.1, 0.9, 0.05, 1.2, 100, 1)).toEqual(rect(0, 89, 6, 100));
    });

    it('aligns work areas to whole steps so pictures of few sizes are made', () => {
        expect(alignRect(rect(10, 20, 40, 30), 1024)).toEqual(rect(10, 20, 74, 84));
        // Moved back inside where it would stick out past the edge.
        expect(alignRect(rect(1000, 1000, 1024, 1024), 1024)).toEqual(rect(960, 960, 1024, 1024));
        // Never larger than the picture.
        expect(alignRect(rect(0, 0, 500, 500), 256)).toEqual(rect(0, 0, 256, 256));
    });

    it('keeps far-apart changes apart and joins overlapping or nearby ones', () => {
        const region = new DirtyRegion(4096);
        region.add(rect(100, 100, 200, 200));
        // Far away (the other side of a UV seam): a rectangle of its own.
        region.add(rect(3000, 3000, 3100, 3100));
        expect(region.rects).toHaveLength(2);
        // Overlapping the first: joined with it.
        region.add(rect(150, 150, 260, 230));
        expect(region.rects).toHaveLength(2);
        expect(region.rects).toContainEqual(rect(100, 100, 260, 230));
        // Right beside the far one, so joining costs little extra area: joined.
        region.add(rect(3100, 3000, 3200, 3100));
        expect(region.rects).toHaveLength(2);
        expect(region.rects).toContainEqual(rect(3000, 3000, 3200, 3100));
        expect(region.area).toBe(160 * 130 + 200 * 100);
    });

    it('joins the cheapest pair once it holds too many rectangles, and turns whole when most is changed', () => {
        const region = new DirtyRegion(1024, 3);
        for (let i = 0; i < 6; i++) region.add(rect(i * 160, 0, i * 160 + 10, 10));
        expect(region.rects.length).toBeLessThanOrEqual(3);
        // Every texel added is still covered.
        for (let i = 0; i < 6; i++) expect(region.rects.some((r) => r.x0 <= i * 160 && r.x1 >= i * 160 + 10)).toBe(true);
        const most = new DirtyRegion(100);
        most.add(rect(0, 0, 80, 80));
        expect(most.full).toBe(true);
        expect(most.rects).toEqual([rect(0, 0, 100, 100)]);
        expect(most.take()).toEqual([rect(0, 0, 100, 100)]);
        expect(most.empty).toBe(true);
    });

    it('merges another region, whole or in parts', () => {
        const a = new DirtyRegion(512);
        a.add(rect(0, 0, 10, 10));
        const b = new DirtyRegion(512);
        b.add(rect(400, 400, 420, 420));
        a.merge(b);
        expect(a.rects).toHaveLength(2);
        const whole = new DirtyRegion(512);
        whole.markFull();
        a.merge(whole);
        expect(a.full).toBe(true);
    });
});

describe('painted pictures kept only where painted', () => {
    it('cuts pictures into pages and finds the pages an area reaches', () => {
        expect(pageSizeFor(4096)).toBe(PAGE_SIZE);
        expect(pageSizeFor(128)).toBe(128);
        expect(pagesIn(rect(0, 0, 256, 256), 1024)).toEqual([[0, 0]]);
        expect(pagesIn(rect(250, 10, 260, 20), 1024)).toEqual([[0, 0], [1, 0]]);
        expect(pagesIn(rect(1000, 1000, 1100, 1100), 1024)).toEqual([[3, 3]]);
        expect(pagesIn(rect(5, 5, 5, 9), 1024)).toEqual([]);
    });

    it('makes a page only where something is painted, once', () => {
        const { gpu, made } = fakeGpu();
        const picture = new SparsePicture(gpu, 4096, 8, [0, 0, 0, 0]);
        expect(picture.pageCount).toBe(0);
        expect(picture.reaches(rect(0, 0, 4096, 4096))).toBe(false);
        // A stroke reaching four pages near the middle.
        const pages = picture.pagesIn(rect(2000, 2000, 2100, 2100), true);
        expect(pages.map(({ px, py }) => [px, py])).toEqual([[7, 7], [8, 7], [7, 8], [8, 8]]);
        expect(picture.pageCount).toBe(4);
        expect(made).toHaveLength(4);
        expect(made.every((image) => image.width === 256 && image.height === 256)).toBe(true);
        // The same pages again: nothing new.
        picture.pagesIn(rect(2050, 2050, 2060, 2060), true);
        expect(picture.pageCount).toBe(4);
        expect(picture.bytes).toBe(4 * 256 * 256 * 4);
        expect(picture.reaches(rect(0, 0, 100, 100))).toBe(false);
        expect(picture.reaches(rect(1900, 1900, 2000, 2000))).toBe(true);
        // Asked without making: only kept pages.
        expect(picture.pagesIn(rect(0, 0, 4096, 4096))).toHaveLength(4);
    });

    it('draws an area as its fill with the kept pages over it, and lets go of pages', () => {
        const { gpu, released, passes } = fakeGpu();
        const picture = new SparsePicture(gpu, 1024, 16, [1, 1, 1, 1]);
        picture.pageAt(1, 1, true);
        const target = {} as GpuImage;
        passes.length = 0;
        // An area-sized target whose corner is the area's.
        picture.drawInto(target, rect(200, 200, 600, 400), [200, 200]);
        expect(passes).toHaveLength(2);
        expect(passes[0].scissor).toEqual({ x: 0, y: 0, width: 400, height: 200 });
        // Page (1, 1) covers 256..512: its part of the area, in the target's own texels.
        expect(passes[1].scissor).toEqual({ x: 56, y: 56, width: 256, height: 144 });
        const copy = new SparsePicture(gpu, 1024, 16, [1, 1, 1, 1]);
        copy.copyFrom(picture);
        expect(copy.has(1, 1)).toBe(true);
        expect(copy.pageCount).toBe(1);
        picture.drop(1, 1);
        expect(picture.pageCount).toBe(0);
        expect(released).toHaveLength(1);
        copy.dispose();
        expect(released).toHaveLength(2);
        // Pages of a lost GPU context are let go without being handed back.
        const lost = new SparsePicture(gpu, 1024, 8, [0, 0, 0, 0]);
        lost.pageAt(0, 0, true);
        lost.dispose(false);
        expect(released).toHaveLength(2);
        expect(lost.pageCount).toBe(0);
    });
});

describe('brush mirrors', () => {
    it('paints one copy per combination of mirrored axes', () => {
        const centre = new THREE.Vector3(1, 2, 3);
        expect(mirrorsOf({ x: false, y: false, z: false }, centre)).toHaveLength(1);
        const x = mirrorsOf({ x: true, y: false, z: false }, centre);
        expect(x.map((mirror) => mirror.signs)).toEqual([[1, 1, 1], [-1, 1, 1]]);
        expect(x[1].centre).toEqual([1, 2, 3]);
        expect(mirrorsOf({ x: true, y: true, z: false }, centre)).toHaveLength(4);
        expect(mirrorsOf({ x: true, y: true, z: true }, centre)).toHaveLength(8);
    });
});

describe('what an area must be put together with', () => {
    const document = createPaintDocument('model', ['Surface']);

    it('puts together the channels that read a changed one from below', () => {
        const wear: PaintLayer = { ...newFillLayer(document, 'Wear', { baseColor: { kind: 'value', value: [1, 1, 1] } }), mask: [{ id: 'e', kind: 'below', enabled: true, blend: 'replace', opacity: 1, channel: 'height', edges: true }] };
        const copy: PaintLayer = newFillLayer(document, 'Glow from colour', { emissive: { kind: 'below', channel: 'baseColor' } });
        const layers = [wear, newFolder('Folder', [copy])];
        // Height changes: the wear layer's colour reads its edges, and the glow reads that colour.
        expect(dependentChannels(layers, ['height']).sort()).toEqual(['baseColor', 'emissive', 'height']);
        expect(dependentChannels(layers, ['roughness'])).toEqual(['roughness']);
        expect(channelsReadAnywhere(layers).sort()).toEqual(['baseColor', 'height']);
    });

    it('grows areas by how far filters and mask blurs read round a texel', () => {
        const blur = { ...newFilterLayer(document, 'blur'), filter: { ...newFilterLayer(document, 'blur').filter!, radius: 0.01 } };
        const hidden = { ...newFilterLayer(document, 'warp'), visible: false };
        const softMask: PaintLayer = { ...newFillLayer(document, 'Soft'), mask: [{ id: 'b', kind: 'blur', enabled: true, blend: 'replace', opacity: 1, radius: 0.005 }] };
        expect(stackReach([], 1024)).toBe(0);
        expect(stackReach([blur], 1024)).toBe(Math.ceil(0.01 * 1024) + 2);
        expect(stackReach([blur, hidden, softMask], 1024)).toBe(Math.ceil(0.01 * 1024) + 2 + Math.ceil(0.005 * 1024) + 2);
        expect(stackReach([newFilterLayer(document, 'invert')], 1024)).toBe(0);
    });
});

describe('painting on the UV layout', () => {
    it('changes only the texels round each dab, on the tile shown', () => {
        const view = { tile: 1002, toUv: (x: number, y: number): [number, number] => [x / 100, 1 - y / 100], pixelsPerUv: 100 };
        const reach = uvFootprint(1024, view, [{ x: 50, y: 50, radius: 10, angle: 0, flow: 1 }], 'round');
        expect([...reach.keys()]).toEqual([1002]);
        const [area] = reach.get(1002)!;
        // A radius of a tenth of the tile round its middle, with a small margin.
        expect(area.x0).toBeLessThanOrEqual(512 - 102);
        expect(area.x1).toBeGreaterThanOrEqual(512 + 102);
        expect(area.x1 - area.x0).toBeLessThan(260);
        expect(uvFootprint(1024, view, [], 'round').size).toBe(0);
    });
});
