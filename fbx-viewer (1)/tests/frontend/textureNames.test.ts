import { afterEach, describe, expect, it } from 'vitest';
import { clearTextureSettings, normalizeTextureSettings, setTextureSettings, settingsFromName } from '../../texturing/textureSettings';
import { textureFromPicture } from '../../texturing/materialTextureLoader';

afterEach(() => clearTextureSettings());

describe('a texture recognised by its name', () => {
    it('is a normal map for the usual endings, with or without a size after', () => {
        for (const name of ['brick_n.png', 'Brick_NRM.tga', 'wall_normal.png', 'rock_nor.jpg', 'aerial_rocks_02_nor_gl_4k.exr', 'tiles-normal_2048px.png']) {
            expect(settingsFromName(name), name).toEqual({ normalMap: true });
        }
    });

    it('is marked to flip green when made for DirectX', () => {
        expect(settingsFromName('aerial_rocks_02_nor_dx_4k.exr')).toEqual({ normalMap: true, flipGreen: true });
        expect(settingsFromName('metal_normal_dx.png')).toEqual({ normalMap: true, flipGreen: true });
    });

    it('is read as data for roughness, metallic, occlusion, height and packed maps', () => {
        for (const name of ['rock_rough_4k.jpg', 'Plate_Metallic.png', 'crate_ao.png', 'ground_disp_2k.exr', 'bricks_arm_4k.png', 'panel_height.tif', 'Wood_Roughness.png']) {
            expect(settingsFromName(name), name).toEqual({ colorSpace: 'data' });
        }
    });

    it('is left to be read by use otherwise, without mistaking words that only end alike', () => {
        for (const name of ['rock_diff_4k.jpg', 'albedo.png', 'canyon.png', 'woodgrain.png', 'Logo.psd', 'banner_2.png']) {
            expect(settingsFromName(name), name).toBeUndefined();
        }
    });

    it('keeps the flip with its settings, and turns green over as it loads', async () => {
        expect(normalizeTextureSettings({ normalMap: true, flipGreen: true })).toEqual({ normalMap: true, flipGreen: true });
        setTextureSettings('dx', { normalMap: true, flipGreen: true, compression: 'none' });
        const picture = { width: 1, height: 1, depth: 8 as const, channels: 4 as const, hdr: false, rgba: new Float32Array([0.5, 0.25, 1, 1]) };
        const { texture } = await textureFromPicture(picture, { textureId: 'dx', slot: 'normal', flipY: false }, false);
        const data = (texture.image as { data: Uint8Array }).data;
        expect(data[1]).toBe(255 - Math.round(0.25 * 255));
    });
});
