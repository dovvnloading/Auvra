import { describe, expect, it } from 'vitest';
import { bestSquare, cropScale, pickRegion, type RegionPicture } from '../../texturing/paint/photoRegion';

/**
 * A photo of a brick wall with a door and a window in it: a click on the wall picks the wall, without
 * the door or the window, and its best square is all wall; a click on the door picks the door.
 */

const W = 128, H = 96;
const grain = (x: number, y: number, c: number) => { let h = Math.imul(x * 374761393 + y * 668265263 + c * 2246822519, 3266489917); h = Math.imul(h ^ (h >>> 15), 2246822519); return ((h ^ (h >>> 13)) >>> 0) / 4294967295; };
const inDoor = (x: number, y: number) => x >= 80 && x < 110 && y >= 30;
const inWindow = (x: number, y: number) => x >= 15 && x < 40 && y >= 15 && y < 40;
const isMortar = (x: number, y: number) => y % 6 < 1 || (x + (Math.floor(y / 6) % 2) * 6) % 12 < 1;
const photo: RegionPicture = {
    width: W, height: H,
    rgb: (() => {
        const rgb = new Float32Array(W * H * 3);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            let colour: number[];
            if (inDoor(x, y)) colour = [0.36, 0.42, 0.5].map((v) => v + (grain(x, 0, 5) - 0.5) * 0.03); // Painted wood: smooth, a faint grain down it.
            else if (inWindow(x, y)) colour = [0.1, 0.12, 0.15];
            else if (isMortar(x, y)) colour = [0.75, 0.72, 0.68];
            else colour = [0.55, 0.25, 0.18].map((v) => v * (0.85 + 0.3 * grain(Math.floor((x + (Math.floor(y / 6) % 2) * 6) / 12), Math.floor(y / 6), 7)));
            // Light falling off a little to the right, and the camera's grain.
            for (let c = 0; c < 3; c++) rgb[(y * W + x) * 3 + c] = Math.min(1, Math.max(0, colour[c] * (1 - 0.1 * (x / W)) + (grain(x, y, c) - 0.5) * 0.05));
        }
        return rgb;
    })(),
};

const count = (mask: Uint8Array, where: (x: number, y: number) => boolean) => {
    let inside = 0, all = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (where(x, y)) { all++; inside += mask[y * W + x]; }
    return inside / all;
};
const squareTouches = (square: { x: number; y: number; size: number }, where: (x: number, y: number) => boolean) => {
    for (let y = square.y; y < square.y + square.size; y++) for (let x = square.x; x < square.x + square.size; x++) if (where(x, y)) return true;
    return false;
};

describe('pulling one material out of a photo', () => {
    it('picks the wall, without the door or the window, and squares off all wall', () => {
        const pick = pickRegion(photo, 60, 60, 0.5);
        const wall = (x: number, y: number) => !inDoor(x, y) && !inWindow(x, y);
        expect(count(pick.mask, wall)).toBeGreaterThan(0.85);
        expect(count(pick.mask, inDoor)).toBeLessThan(0.1);
        expect(count(pick.mask, inWindow)).toBeLessThan(0.1);
        expect(pick.square).not.toBeNull();
        expect(squareTouches(pick.square!, (x, y) => inDoor(x, y) || inWindow(x, y))).toBe(false);
        expect(pick.square!.size).toBeGreaterThanOrEqual(40);
    });

    it('picks the door when the door is clicked', () => {
        const pick = pickRegion(photo, 95, 70, 0.5);
        expect(count(pick.mask, inDoor)).toBeGreaterThan(0.8);
        expect(count(pick.mask, (x, y) => !inDoor(x, y))).toBeLessThan(0.05);
        expect(squareTouches(pick.square!, (x, y) => !inDoor(x, y))).toBe(false);
        expect(pick.square!.size).toBeGreaterThanOrEqual(18);
    });

    it('takes in more as the tolerance rises', () => {
        const shares = [0, 0.5, 1].map((tolerance) => pickRegion(photo, 60, 60, tolerance).share);
        expect(shares[0]).toBeLessThanOrEqual(shares[1]);
        expect(shares[1]).toBeLessThanOrEqual(shares[2]);
    });

    it('finds the largest square of a mask, the most evenly lit of equals', () => {
        const mask = new Uint8Array(10 * 6);
        for (let y = 0; y < 6; y++) for (let x = 0; x < 10; x++) mask[y * 10 + x] = x < 4 || x >= 6 ? 1 : 0;
        // Two 4 x 4 squares fit (each side of the gap): the right one is even, the left one is not.
        const light = new Float32Array(60).map((_, i) => (i % 10 < 4 ? (i % 2) * 50 : 40));
        const square = bestSquare(mask, 10, 6, light)!;
        expect(square.size).toBe(4);
        expect(square.x).toBe(6);
    });
});

describe('keeping the feature scale when a square is used', () => {
    it('scales the size in the world by how much of the photo the picture then shows', () => {
        // A 400 x 300 photo, filled into the square: its middle 300 x 300 shows. A 120-pixel square shows 0.4 of that.
        expect(cropScale([1, 1], [120 / 400, 120 / 300], 400, 300)).toBeCloseTo(0.4);
        // Back to the whole photo from that square: two and a half times as much.
        expect(cropScale([120 / 400, 120 / 300], [1, 1], 400, 300)).toBeCloseTo(2.5);
        // The same square again changes nothing.
        expect(cropScale([0.3, 0.4], [0.3, 0.4], 400, 300)).toBeCloseTo(1);
    });
});
