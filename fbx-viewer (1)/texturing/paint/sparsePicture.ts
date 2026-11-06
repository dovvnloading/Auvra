import * as THREE from 'three';
import type { GpuImage, PassInput, TextureGpu } from '../gpu/textureGpu';
import { intersectRect, isEmptyRect, scissorOf, type Rect } from './regions';

/**
 * PAINTED PICTURES, KEPT ONLY WHERE PAINTED
 *
 * A painted layer or mask is cut into square pages, and a page is made only once something is painted on
 * it; everywhere else the picture holds one value (nothing for a layer, white or black for a mask). A
 * stroke on a 4K set then costs the pages it touches, not the whole picture, and a set with many layers
 * keeps only what was painted.
 */

/** The side of a page in texels; a picture smaller than this is one page. */
export const PAGE_SIZE = 256;

export const pageSizeFor = (size: number): number => Math.min(PAGE_SIZE, size);

/** A page's texels in its picture. */
export const pageRect = (px: number, py: number, page: number): Rect => ({ x0: px * page, y0: py * page, x1: (px + 1) * page, y1: (py + 1) * page });

/** The pages (column, row) a rectangle reaches in a picture of `size` texels cut into pages of `page`. */
export const pagesIn = (area: Rect, size: number, page = pageSizeFor(size)): Array<[number, number]> => {
    if (isEmptyRect(area)) return [];
    const columns = Math.ceil(size / page);
    const px0 = Math.max(0, Math.floor(area.x0 / page));
    const py0 = Math.max(0, Math.floor(area.y0 / page));
    const px1 = Math.min(columns - 1, Math.floor((area.x1 - 1) / page));
    const py1 = Math.min(columns - 1, Math.floor((area.y1 - 1) / page));
    const pages: Array<[number, number]> = [];
    for (let py = py0; py <= py1; py++) for (let px = px0; px <= px1; px++) pages.push([px, py]);
    return pages;
};

const FILL = /* glsl */ `uniform vec4 uValue;
void main() { outColor = uValue; }`;

/** Texels of `source` from `uAt` on (whole texels), drawn from this target's corner. */
const SHIFTED = /* glsl */ `uniform vec2 uAt;
void main() { outColor = texelFetch(source, ivec2(gl_FragCoord.xy + uAt), 0); }`;

/** Per block of 16 × 16 texels, how far any texel strays from the fill. */
const STRAY = /* glsl */ `uniform vec4 uFill;
void main() {
    ivec2 base = ivec2(gl_FragCoord.xy) * 16;
    ivec2 size = textureSize(source, 0);
    float most = 0.0;
    for (int y = 0; y < 16; y++) for (int x = 0; x < 16; x++) {
        ivec2 q = base + ivec2(x, y);
        if (q.x >= size.x || q.y >= size.y) continue;
        vec4 d = abs(texelFetch(source, q, 0) - uFill);
        most = max(most, max(max(d.r, d.g), max(d.b, d.a)));
    }
    outColor = vec4(most);
}`;

/** The largest of each `uBlock` × `uBlock` texels. */
const LARGEST = /* glsl */ `uniform int uBlock;
void main() {
    ivec2 base = ivec2(gl_FragCoord.xy) * uBlock;
    ivec2 size = textureSize(source, 0);
    float most = 0.0;
    for (int y = 0; y < 64; y++) {
        if (y >= uBlock) break;
        for (int x = 0; x < 64; x++) {
            if (x >= uBlock) break;
            ivec2 q = base + ivec2(x, y);
            if (q.x < size.x && q.y < size.y) most = max(most, texelFetch(source, q, 0).r);
        }
    }
    outColor = vec4(most);
}`;

/** The part of the GPU a sparse picture uses (an interface, so the bookkeeping can be checked without one). */
export type PageGpu = Pick<TextureGpu, 'image' | 'release' | 'passNow'>;

export class SparsePicture {
    readonly page: number;
    readonly columns: number;
    private readonly kept = new Map<number, GpuImage>();

    constructor(private readonly gpu: PageGpu, readonly size: number, readonly precision: 8 | 16, readonly fill: readonly [number, number, number, number]) {
        this.page = pageSizeFor(size);
        this.columns = Math.ceil(size / this.page);
    }

    /** How many pages are kept. */
    get pageCount(): number {
        return this.kept.size;
    }

    /** Bytes the kept pages take on the GPU. */
    get bytes(): number {
        return this.kept.size * this.page * this.page * 4 * (this.precision / 8);
    }

    has(px: number, py: number): boolean {
        return this.kept.has(py * this.columns + px);
    }

    /** The page at (px, py), or null; made (holding the fill) when `create`. */
    pageAt(px: number, py: number, create = false): GpuImage | null {
        const index = py * this.columns + px;
        let image = this.kept.get(index) ?? null;
        if (!image && create) {
            image = this.gpu.image(this.page, this.page, 'color', this.precision);
            this.gpu.passNow(image, { fragment: FILL, uniforms: { uValue: new THREE.Vector4(...this.fill) } });
            this.kept.set(index, image);
        }
        return image;
    }

    /** The kept pages a rectangle reaches (all of them it reaches, made as needed, when `create`). */
    pagesIn(area: Rect, create = false): Array<{ px: number; py: number; image: GpuImage }> {
        const pages: Array<{ px: number; py: number; image: GpuImage }> = [];
        for (const [px, py] of pagesIn(area, this.size, this.page)) {
            const image = this.pageAt(px, py, create);
            if (image) pages.push({ px, py, image });
        }
        return pages;
    }

    /** Every kept page. */
    entries(): Array<{ px: number; py: number; image: GpuImage }> {
        return [...this.kept].map(([index, image]) => ({ px: index % this.columns, py: Math.floor(index / this.columns), image }));
    }

    /** Whether any kept page reaches the rectangle (else it holds only the fill there). */
    reaches(area: Rect): boolean {
        if (!this.kept.size) return false;
        return pagesIn(area, this.size, this.page).some(([px, py]) => this.kept.has(py * this.columns + px));
    }

    /** Lets go of one page (the picture holds the fill there again). */
    drop(px: number, py: number): void {
        const index = py * this.columns + px;
        const image = this.kept.get(index);
        if (!image) return;
        this.gpu.release(image);
        this.kept.delete(index);
    }

    /**
     * Draws the picture's texels within `area` into `target`, whose texel (0, 0) is the picture's texel
     * `origin` (so a target the size of the area takes the area's corner, a whole-size one (0, 0)): the
     * fill first, then every kept page over it.
     */
    drawInto(target: GpuImage | THREE.WebGLRenderTarget, area: Rect, origin: readonly [number, number] = [0, 0]): void {
        const local = (r: Rect): Rect => ({ x0: r.x0 - origin[0], y0: r.y0 - origin[1], x1: r.x1 - origin[0], y1: r.y1 - origin[1] });
        if (isEmptyRect(area)) return;
        this.gpu.passNow(target, { fragment: FILL, uniforms: { uValue: new THREE.Vector4(...this.fill) }, scissor: scissorOf(local(area)) });
        for (const { px, py, image } of this.pagesIn(area)) {
            const within = intersectRect(area, { x0: px * this.page, y0: py * this.page, x1: (px + 1) * this.page, y1: (py + 1) * this.page });
            if (isEmptyRect(within)) continue;
            this.gpu.passNow(target, {
                fragment: SHIFTED,
                inputs: { source: image },
                uniforms: { uAt: new THREE.Vector2(origin[0] - px * this.page, origin[1] - py * this.page) },
                scissor: scissorOf(local(within)),
            });
        }
    }

    /** Draws a whole-size picture (or texture) into this one's pages, area by area; pages it reaches are made. */
    writeFrom(source: PassInput, area: Rect): void {
        for (const { px, py, image } of this.pagesIn(area, true)) {
            const within = intersectRect(area, { x0: px * this.page, y0: py * this.page, x1: (px + 1) * this.page, y1: (py + 1) * this.page });
            if (isEmptyRect(within)) continue;
            this.gpu.passNow(image, {
                fragment: SHIFTED,
                inputs: { source },
                uniforms: { uAt: new THREE.Vector2(px * this.page, py * this.page) },
                scissor: scissorOf({ x0: within.x0 - px * this.page, y0: within.y0 - py * this.page, x1: within.x1 - px * this.page, y1: within.y1 - py * this.page }),
            });
        }
    }

    /**
     * Takes a whole-size picture (or texture) as this one's content, making only the pages where it strays
     * from the fill (read back as one small grid of page values). Pages kept before are let go.
     */
    adopt(source: PassInput, gpu: TextureGpu): void {
        for (const image of this.kept.values()) this.gpu.release(image);
        this.kept.clear();
        const blocks = Math.ceil(this.size / 16);
        const strays = gpu.image(blocks, blocks, 'gray', 16);
        gpu.passNow(strays, { fragment: STRAY, inputs: { source }, uniforms: { uFill: new THREE.Vector4(...this.fill) } });
        const grid = gpu.image(this.columns, this.columns, 'color', 32);
        gpu.passNow(grid, { fragment: LARGEST, inputs: { source: strays }, uniforms: { uBlock: this.page / 16 } });
        gpu.release(strays);
        const values = gpu.readFloat(grid);
        gpu.release(grid);
        for (let py = 0; py < this.columns; py++) {
            for (let px = 0; px < this.columns; px++) {
                // Less than half an 8-bit step from the fill is the fill.
                if (values[(py * this.columns + px) * 4] <= 0.5 / 255) continue;
                const area = { x0: px * this.page, y0: py * this.page, x1: (px + 1) * this.page, y1: (py + 1) * this.page };
                this.writeFrom(source, area);
            }
        }
    }

    /** Becomes a copy of another picture of the same size (its pages copied, its own let go). */
    copyFrom(other: SparsePicture): void {
        for (const image of this.kept.values()) this.gpu.release(image);
        this.kept.clear();
        for (const { px, py, image } of other.entries()) {
            const page = this.pageAt(px, py, true)!;
            this.gpu.passNow(page, { fragment: SHIFTED, inputs: { source: image }, uniforms: { uAt: new THREE.Vector2(0, 0) } });
        }
    }

    /** Lets go of every page (`release` false when the GPU context they lived on is gone). */
    dispose(release = true): void {
        if (release) for (const image of this.kept.values()) this.gpu.release(image);
        this.kept.clear();
    }
}
