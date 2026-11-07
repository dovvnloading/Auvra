import { describe, expect, it } from 'vitest';
import { BUILT_IN_TEMPLATES, fileName, holdsNormalGreen, planPicture, readTemplates } from '../../texturing/paint/exportTemplates';
import { writeExr, writeTga, writeTiff, type PictureData } from '../../texturing/paint/pictureFiles';

const picture = (channels: 1 | 3 | 4): PictureData => ({
    width: 3, height: 2, channels,
    data: Float32Array.from({ length: 3 * 2 * channels }, (_, i) => (i % 7) / 6),
});

describe('export templates', () => {
    it('fill in file names from their tokens', () => {
        expect(fileName('$set_$tile_$size', { set: 'Helmet body', model: 'SciFi', tile: 1002, size: 2048 })).toBe('Helmet_body_1002_2048');
        expect(fileName('$model/$set??', { set: 'A', model: 'B', tile: 1001, size: 512 })).toBe('B_A');
        expect(fileName('$$$', { set: '', model: '', tile: 1001, size: 1 })).toBe('picture');
    });

    it('pack channels from at most four maps, each read once', () => {
        const orm = BUILT_IN_TEMPLATES.find((template) => template.id === 'builtin:orm')!.pictures[1];
        expect(planPicture(orm)).toEqual({ sources: ['ambientOcclusion', 'roughness', 'metallic'], channels: [{ slot: 0, component: 0 }, { slot: 1, component: 0 }, { slot: 2, component: 0 }] });
        const colour = BUILT_IN_TEMPLATES[0].pictures[0];
        expect(planPicture(colour)).toEqual({ sources: ['baseColor', 'opacity'], channels: [{ slot: 0, component: 0 }, { slot: 0, component: 1 }, { slot: 0, component: 2 }, { slot: 1, component: 0 }] });
        const many = planPicture({ name: 'x', channels: [{ from: 'height', component: 0 }, { from: 'roughness', component: 0 }, { value: 2 }, { from: 'height', component: 0 }] });
        expect(many.sources).toEqual(['height', 'roughness']);
        expect(many.channels[2]).toEqual({ value: 1 });
        expect(holdsNormalGreen({ from: 'normal', component: 1 })).toBe(true);
        expect(holdsNormalGreen({ from: 'normal', component: 0 })).toBe(false);
    });

    it('read templates back from the project safely', () => {
        const back = readTemplates(JSON.parse(JSON.stringify([...BUILT_IN_TEMPLATES, { id: 'bad', pictures: [{ name: 'x', channels: [{ from: 'nothing', component: 0 }, { value: 1 }] }] }])));
        expect(back.map((template) => template.id)).toEqual(BUILT_IN_TEMPLATES.map((template) => template.id));
        expect(readTemplates([{ id: 't', name: 'Mine', format: 'jpeg', sizes: [11, 99], pictures: [{ name: '$set_H', channels: [{ from: 'height', component: 0 }] }] }])[0]).toMatchObject({ format: 'png8', sizes: [11], normal: 'openGl', padding: true });
    });
});

describe('picture files', () => {
    it('write TGA headers for grey and colour, rows from the top', () => {
        const grey = writeTga(picture(1));
        expect([grey[2], grey[12], grey[14], grey[16], grey[17]]).toEqual([3, 3, 2, 8, 0x20]);
        expect(grey.length).toBe(18 + 6);
        const rgba = writeTga(picture(4));
        expect([rgba[2], rgba[16], rgba[17]]).toEqual([2, 32, 0x28]);
        // Blue, green, red, alpha.
        expect([rgba[18], rgba[19], rgba[20], rgba[21]]).toEqual([Math.round((2 / 6) * 255), Math.round((1 / 6) * 255), 0, Math.round(0.5 * 255)]);
    });

    it('write TIFF headers with their bit depth and sample kind', () => {
        for (const [bits, kind] of [[8, 1], [16, 1], [32, 3]] as const) {
            const file = writeTiff(picture(3), bits);
            const view = new DataView(file.buffer);
            expect(view.getUint16(0, true)).toBe(0x4949);
            expect(view.getUint16(2, true)).toBe(42);
            const ifd = view.getUint32(4, true);
            const count = view.getUint16(ifd, true);
            const tags = new Map<number, number>();
            const counts = new Map<number, number>();
            for (let i = 0; i < count; i++) {
                const at = ifd + 2 + i * 12;
                const tag = view.getUint16(at, true);
                counts.set(tag, view.getUint32(at + 4, true));
                tags.set(tag, view.getUint16(at + 2, true) === 3 && view.getUint32(at + 4, true) > 2 ? view.getUint16(view.getUint32(at + 8, true), true) : view.getUint16(at + 2, true) === 3 ? view.getUint16(at + 8, true) : view.getUint32(at + 8, true));
            }
            expect(tags.get(256)).toBe(3);
            expect(tags.get(257)).toBe(2);
            expect(tags.get(258)).toBe(bits);
            expect(counts.get(258)).toBe(3);
            expect(tags.get(339)).toBe(kind);
            expect(tags.get(279)).toBe(3 * 2 * 3 * (bits / 8));
            const first = tags.get(273)!;
            if (bits === 32) expect(view.getFloat32(first + 4, true)).toBeCloseTo(1 / 6, 6);
            if (bits === 16) expect(view.getUint16(first + 2, true)).toBe(Math.round((1 / 6) * 65535));
        }
    });

    it('write EXR files with their channels, depth and scan lines', () => {
        for (const bits of [16, 32] as const) {
            const file = writeExr(picture(4), bits);
            const view = new DataView(file.buffer);
            expect(view.getUint32(0, true)).toBe(20000630);
            expect(view.getUint32(4, true)).toBe(2);
            const text = new TextDecoder().decode(file.subarray(8, 400));
            expect(text).toContain('chlist');
            expect(text).toContain('dataWindow');
            // Channels in name order, each with its pixel kind (1 half, 2 float).
            const listAt = 8 + 'channels'.length + 1 + 'chlist'.length + 1 + 4;
            expect(String.fromCharCode(file[listAt])).toBe('A');
            expect(view.getInt32(listAt + 2, true)).toBe(bits === 16 ? 1 : 2);
        }
        // Grey is one Y channel.
        const grey = new TextDecoder().decode(writeExr(picture(1), 16).subarray(8, 80));
        expect(grey).toContain('Y');
    });
});
