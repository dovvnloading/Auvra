import { describe, expect, it } from 'vitest';
import { budgetWarnings, levelTextureCost, materialTextureCost, sumCosts, textureCost, textureIdsIn } from '../../texturing/textureBudget';
import type { LevelObject } from '../../types';

const ALL = { bptc: true, rgtc: true };
const MB = 1024 * 1024;

const texture = (id: string, size: number, settings?: object) => ({ id, name: `${id}.png`, dimensions: { width: size, height: size }, settings });

describe('texture memory', () => {
    it('counts a texture as it would be kept', () => {
        expect(textureCost(texture('albedo', 1024), 'map', ALL)).toMatchObject({ format: 'bc7', width: 1024 });
        expect(textureCost(texture('albedo', 1024, { compression: 'none', mips: false }), 'map', ALL).bytes).toBe(4 * MB);
        expect(textureCost(texture('big', 4096, { maxSize: 1024, mips: false }), 'map', ALL)).toMatchObject({ width: 1024, bytes: MB });
        expect(textureCost(texture('rough', 1024, { source: { format: 'png', depth: 16, channels: 1 } }), 'data', ALL).format).toBe('bc4');
        expect(textureCost(texture('sky', 1024, { source: { format: 'exr', depth: 32, channels: 4, hdr: true }, mips: false }), 'map', ALL)).toMatchObject({ format: 'half', bytes: 8 * MB });
    });

    it('sums each texture once, at its dearer use, largest first', () => {
        const a = textureCost(texture('a', 512, { mips: false }), 'map', ALL);
        const b = textureCost(texture('b', 2048, { mips: false }), 'map', ALL);
        const aWhole = textureCost(texture('a', 512, { compression: 'none', mips: false }), 'map', ALL);
        const sum = sumCosts([a, b, aWhole, b]);
        expect(sum.textures.map(cost => cost.id)).toEqual(['b', 'a']);
        expect(sum.bytes).toBe(b.bytes + aWhole.bytes);
    });

    it('adds up a material\'s textures, read the way its graph reads them', () => {
        const textures = new Map([['albedo', texture('albedo', 1024, { mips: false })], ['normal', texture('normal', 1024, { mips: false })]]);
        const cost = materialTextureCost({ id: 'm', name: 'Bricks', textureIds: ['albedo', 'normal', 'gone'], slots: new Map([['normal', 'normal']]) }, textures, ALL);
        expect(cost.bytes).toBe(2 * MB);
        expect(cost.textures.find(entry => entry.id === 'normal')?.format).toBe('bc5');
    });

    it('adds up a level\'s textures: its models\' materials, overrides, decals and objects\' values', () => {
        const textures = new Map(['albedo', 'logo', 'dents', 'paint', 'unused'].map(id => [id, texture(id, 256, { mips: false })] as const));
        const materials = new Map([['bricks', { id: 'bricks', name: 'Bricks', textureIds: ['albedo'] }], ['rust', { id: 'rust', name: 'Rust', textureIds: ['dents'] }]]);
        const models = [
            { id: 'wall', materialOverrides: { Body: { materialId: 'bricks' } } },
            { id: 'crate', materialOverrides: { Lid: { mapTextureId: 'paint' } } },
            { id: 'barrel', materialOverrides: { Body: { mapTextureId: 'unused' } } },
        ];
        const objects = [
            { id: 'w', modelId: 'wall', components: [{ id: 'd', type: 'decal', enabled: true, props: { textureId: 'logo', materialId: 'rust' } }] },
            { id: 'c', modelId: 'crate' },
        ] as unknown as LevelObject[];
        const cost = levelTextureCost(objects, models, materials, textures, ALL);
        expect(cost.textures.map(entry => entry.id).sort()).toEqual(['albedo', 'dents', 'logo', 'paint']);
        expect(cost.bytes).toBe(4 * 256 * 256);
        expect([...textureIdsIn({ parameters: [{ name: 'Picture', value: 'logo' }, { name: 'Tint', value: [1, 0, 0] }] }, new Set(['logo']))]).toEqual(['logo']);
    });

    it('warns in plain words about a level over its budget and textures kept large', () => {
        const big = textureCost(texture('Rock', 4096, { compression: 'none' }), 'map', ALL);
        const warnings = budgetWarnings(sumCosts([big]), 50);
        expect(warnings[0]).toMatch(/This level's textures need \d+ MB, more than the game's 50 MB of asset memory/);
        expect(warnings[1]).toMatch(/^Rock\.png takes \d+ MB because it is not compressed/);
        expect(budgetWarnings(sumCosts([textureCost(texture('Small', 256), 'map', ALL)]), 50)).toEqual([]);
    });
});
