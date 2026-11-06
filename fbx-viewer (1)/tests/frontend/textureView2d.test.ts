import { describe, expect, it } from 'vitest';
import {
    dragGradient, dragShape, dragTile, dragTransform, gradientFrame, histogramOf, rangeShare, shapeFrame, tileFrame, transformFrame, uvToView, viewToUv, wrapAngle,
    type Vec2, type ViewPlacement,
} from '../../components/Texturing/view2d';

const close = (actual: readonly number[], expected: readonly number[], digits = 5) => actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], digits));
const point = (frame: { points: Array<{ key: string; at: Vec2 }> }, key: string): Vec2 => frame.points.find((item) => item.key === key)!.at;

describe('2D view: placing the image', () => {
    const placement: ViewPlacement = { width: 400, height: 300, ratio: 2, panX: 20, panY: -10, zoom: 1.5, imageWidth: 128, imageHeight: 64 };

    it('puts the image middle at the view middle plus the pan, v pointing up', () => {
        const middle = uvToView({ u: 0.5, v: 0.5 }, placement);
        close([middle.x, middle.y], [(200 + 20) / 2, (300 - (150 - 10)) / 2]);
        const top = uvToView({ u: 0.5, v: 1 }, placement);
        expect(top.y).toBeLessThan(middle.y);
    });

    it('reads a view point back to the same image point', () => {
        const at = uvToView({ u: 0.3, v: 0.8 }, placement);
        const back = viewToUv(at, placement);
        close([back.u, back.v], [0.3, 0.8]);
    });
});

describe('2D view: histogram', () => {
    it('counts pixels into bins for each channel and brightness', () => {
        const pixels = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 255, 128, 128, 128, 255]);
        const histogram = histogramOf(pixels, 4);
        expect(histogram.total).toBe(4);
        expect(histogram.red).toEqual([1, 0, 1, 2]);
        expect(histogram.green).toEqual([2, 0, 1, 1]);
        // Pure red is dark: 0.2126 of the way up.
        expect(histogram.luma).toEqual([2, 0, 1, 1]);
    });

    it('gives the share of pixels in a range, either way round', () => {
        const bins = [10, 20, 30, 40];
        expect(rangeShare(bins, 0, 1)).toBe(1);
        expect(rangeShare(bins, 0.5, 1)).toBeCloseTo(0.7, 6);
        expect(rangeShare(bins, 1, 0.5)).toBeCloseTo(0.7, 6);
        expect(rangeShare(bins, 0.3, 0.32)).toBe(0);
        expect(rangeShare([0, 0], 0, 1)).toBe(0);
    });
});

describe('2D view: handles', () => {
    it('frames a Transform round its moved, turned and scaled picture, and reads drags back', () => {
        const settings = { offset: [0.1, -0.2] as Vec2, rotation: 0, scale: [0.5, 2] as Vec2 };
        const frame = transformFrame(settings);
        close(point(frame, 'offset'), [0.6, 0.3]);
        close(frame.outline[2], [0.6 + 0.25, 0.3 + 1]);
        expect(dragTransform(settings, 'offset', [0.9, 0.5])).toEqual({ offset: [0.4, 0] });
        expect(dragTransform(settings, 'scale', [0.6 + 0.5, 0.3 + 0.25])).toEqual({ scale: [1, 0.5] });
        expect(dragTransform(settings, 'scale', [0.6 + 0.5, 0.3 + 0.25], true)).toEqual({ scale: [1, 1] });
        // The knob sits above the middle; dragging it to the right is a quarter turn.
        close(point(frame, 'rotation'), [0.6, 0.3 + 1 + 0.08]);
        expect(dragTransform(settings, 'rotation', [0.9, 0.3])).toEqual({ rotation: 90 });
    });

    it('turns a Transform\'s frame against its turn, as the picture turns', () => {
        const frame = transformFrame({ offset: [0, 0], rotation: 90, scale: [1, 1] });
        // The knob that sat above the middle now sits to its right.
        close(point(frame, 'rotation'), [0.5 + 0.58, 0.5]);
        expect(dragTransform({ offset: [0, 0], rotation: 90, scale: [1, 1] }, 'scale', [1, 0])).toEqual({ scale: [1, 1] });
    });

    it('frames a Shape round its centre and size, in its tile', () => {
        const settings = { centre: [0.3, 0.6] as Vec2, size: 0.8, stretch: [1, 0.5] as Vec2, rotation: 0, tiling: 2 };
        const frame = shapeFrame(settings);
        close(point(frame, 'centre'), [0.3, 0.6]);
        close(point(frame, 'size'), [0.3 + 0.8 / 4, 0.6 + 0.4 / 4]);
        expect(dragShape(settings, 'centre', [1.2, -0.1])).toEqual({ centre: [1, 0] });
        expect(dragShape(settings, 'size', [0.3 + 0.25, 0.6])).toEqual({ size: 1 });
        expect(dragShape(settings, 'rotation', [0.1, 0.6])).toEqual({ rotation: 90 });
    });

    it('puts a gradient\'s ends either side of the middle and turns it by either end', () => {
        const flat = gradientFrame(0);
        close(point(flat, 'start'), [0, 0.5]);
        close(point(flat, 'end'), [1, 0.5]);
        const diagonal = gradientFrame(45);
        close(point(diagonal, 'end'), [1, 1]);
        expect(dragGradient('end', [0.5, 1])).toEqual({ angle: 90 });
        expect(dragGradient('start', [0.5, 1])).toEqual({ angle: -90 });
    });

    it('frames a Tile sampler\'s middle copy and reads its size, turn and row offset', () => {
        const settings = { columns: 4, rows: 4, size: 0.8, stretch: [1, 1] as Vec2, rotation: 0, offset: 0.25 };
        const frame = tileFrame(settings);
        // The middle cell is (2, 2), an even row: no shift.
        close(frame.outline[2], [(2.5 + 0.4) / 4, (2.5 + 0.4) / 4]);
        close(point(frame, 'offset'), [(2.5 + 0.25) / 4, 3.5 / 4]);
        expect(dragTile(settings, 'offset', [(2.5 + 0.5) / 4, 3.5 / 4])).toEqual({ offset: 0.5 });
        expect(dragTile(settings, 'size', [3 / 4, 2.5 / 4])).toEqual({ size: 1 });
        expect(dragTile(settings, 'rotation', [2.5 / 4, 3.5 / 4])).toEqual({ rotation: 0 });
    });

    it('puts a Tile sampler\'s handles on its copies where their random shifts put them', () => {
        const settings = { columns: 4, rows: 4, size: 0.8, stretch: [1, 1] as Vec2, rotation: 0, offset: 0.25, jitterAt: (cell: Vec2): Vec2 => [cell[1] === 2 ? 0.1 : -0.2, 0.05] };
        const frame = tileFrame(settings);
        close(frame.outline[2], [(2.5 + 0.1 + 0.4) / 4, (2.5 + 0.05 + 0.4) / 4]);
        close(point(frame, 'offset'), [(2.5 + 0.25 - 0.2) / 4, (3.5 + 0.05) / 4]);
        expect(dragTile(settings, 'offset', [(2.5 + 0.5 - 0.2) / 4, 3.5 / 4])).toEqual({ offset: 0.5 });
    });

    it('keeps angles from -180 to 180', () => {
        expect(wrapAngle(270)).toBe(-90);
        expect(wrapAngle(-190)).toBe(170);
        expect(wrapAngle(45.04)).toBe(45);
    });
});
