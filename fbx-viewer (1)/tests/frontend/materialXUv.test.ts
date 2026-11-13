import { describe, expect, it } from 'vitest';
import type { MaterialAsset } from '../../runtime/materials/materialLibrary';
import { materialFromMaterialX, materialToMaterialX, materialXPictures } from '../../texturing/materialX';

/** The same coordinates must be used for colour, data and tangent-space normal samples. */
const source = `<?xml version="1.0"?>
<materialx version="1.39">
  <nodegraph name="Scanned">
    <image name="base" type="color3">
      <input name="file" type="filename" value="stone_albedo.png" colorspace="srgb_texture" />
      <input name="uvtiling" type="vector2" value="2, 3" />
      <input name="uvoffset" type="vector2" value="0.125, -0.25" />
    </image>
    <tiledimage name="rough" type="float">
      <input name="file" type="filename" value="stone_rough.png" />
      <input name="uvtiling" type="vector2" value="4, 4" />
    </tiledimage>
    <image name="normal_image" type="vector3">
      <input name="file" type="filename" value="stone_normal.png" />
      <input name="uvtiling" type="vector2" value="1, 2" />
      <input name="uvoffset" type="vector2" value="-0.05, 0.75" />
    </image>
    <normalmap name="normal" type="vector3">
      <input name="in" type="vector3" nodename="normal_image" />
      <input name="scale" type="float" value="0.8" />
    </normalmap>
    <output name="base_out" type="color3" nodename="base" />
    <output name="rough_out" type="float" nodename="rough" />
    <output name="normal_out" type="vector3" nodename="normal" />
  </nodegraph>
  <standard_surface name="Stone" type="surfaceshader">
    <input name="base_color" type="color3" nodegraph="Scanned" output="base_out" />
    <input name="specular_roughness" type="float" nodegraph="Scanned" output="rough_out" />
    <input name="normal" type="vector3" nodegraph="Scanned" output="normal_out" />
  </standard_surface>
  <surfacematerial name="Stone_asset" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="Stone" />
  </surfacematerial>
</materialx>`;

const uvOf = (asset: MaterialAsset, key: string) => {
    const image = asset.graph.nodes.find((node) => node.id === `${key}_picture`)!;
    const link = asset.graph.links.find((wire) => wire.toNode === image.id && wire.toInput === 'uv');
    const uv = asset.graph.nodes.find((node) => node.id === link?.fromNode);
    return { image, uv, output: link?.fromOutput };
};

describe('MaterialX image UV transforms', () => {
    it('preserves numeric tiling/offset across colour, scalar and normal import', () => {
        expect(materialXPictures(source)).toEqual([
            { path: 'stone_albedo.png', colour: true },
            { path: 'stone_rough.png', colour: false },
            { path: 'stone_normal.png', colour: false },
        ]);
        const { asset, leftOut } = materialFromMaterialX(source, (path) => `tex:${path}`, 'a1');
        expect(leftOut).toEqual([]);

        const base = uvOf(asset, 'baseColor');
        expect(base.image.type).toBe('texture');
        expect(base.image.params).toMatchObject({ texture: 'tex:stone_albedo.png', space: 'color' });
        expect(base.output).toBe('out');
        expect(base.uv).toMatchObject({ type: 'tilingOffset', params: { tiling: [2, 3], offset: [0.125, -0.25] } });

        const rough = uvOf(asset, 'roughness');
        expect(rough.image.params.space).toBe('data');
        expect(rough.uv).toMatchObject({ type: 'tilingOffset', params: { tiling: [4, 4], offset: [0, 0] } });

        const normal = uvOf(asset, 'normal');
        expect(normal.image.type).toBe('normalMap');
        expect(normal.image.params).toMatchObject({ strength: 0.8, texture: 'tex:stone_normal.png' });
        expect(normal.uv).toMatchObject({ type: 'tilingOffset', params: { tiling: [1, 2], offset: [-0.05, 0.75] } });
    });

    it('writes uvtiling/uvoffset and reads them back without defaulting to identity', () => {
        const { asset } = materialFromMaterialX(source, (path) => `tex:${path}`, 'a1');
        const exported = materialToMaterialX(asset, 'standard_surface', (textureId) => textureId.replace(/^tex:/, ''));
        expect(exported.leftOut).toEqual([]);
        expect(exported.document).toContain('<input name="uvtiling" type="vector2" value="2, 3" />');
        expect(exported.document).toContain('<input name="uvoffset" type="vector2" value="0.125, -0.25" />');
        expect(exported.document).toContain('<input name="uvtiling" type="vector2" value="4, 4" />');
        expect(exported.document).toContain('<input name="uvoffset" type="vector2" value="-0.05, 0.75" />');

        const roundTrip = materialFromMaterialX(exported.document, (path) => `round:${path}`, 'a2');
        expect(roundTrip.leftOut).toEqual([]);
        for (const key of ['baseColor', 'roughness', 'normal']) {
            expect(uvOf(roundTrip.asset, key).uv?.params).toEqual(uvOf(asset, key).uv?.params);
        }
    });

    it('warns rather than flattening unsupported custom UV graphs or nonnumeric coordinates', () => {
        const imported = materialFromMaterialX(source, (path) => `tex:${path}`, 'a1').asset;
        const image = imported.graph.nodes.find((node) => node.id === 'baseColor_picture')!;
        imported.graph.nodes.push({ id: 'movingUv', type: 'panner', x: -200, y: 0, params: { speed: [0.1, 0] } });
        imported.graph.links = imported.graph.links.filter((wire) => !(wire.toNode === image.id && wire.toInput === 'uv'));
        imported.graph.links.push({ fromNode: 'movingUv', fromOutput: 'out', toNode: image.id, toInput: 'uv' });
        const exported = materialToMaterialX(imported, 'standard_surface', (id) => id.replace(/^tex:/, ''));
        expect(exported.leftOut).toContain('baseColor');

        const invalid = source.replace(
            '<input name="uvtiling" type="vector2" value="2, 3" />',
            '<input name="uvtiling" type="vector2" value="not-a-pair" />',
        );
        const result = materialFromMaterialX(invalid, (path) => `tex:${path}`, 'bad');
        expect(result.leftOut).toContain('base_color UV coordinates');
        expect(result.asset.graph.nodes.some((node) => node.id === 'baseColor_picture')).toBe(true);
    });

    it('does not invent transform nodes for identity mappings', () => {
        const document = source
            .replace('<input name="uvtiling" type="vector2" value="2, 3" />', '<input name="uvtiling" type="vector2" value="1, 1" />')
            .replace('<input name="uvoffset" type="vector2" value="0.125, -0.25" />', '<input name="uvoffset" type="vector2" value="0, 0" />');
        const { asset } = materialFromMaterialX(document, (path) => `tex:${path}`, 'identity');
        expect(uvOf(asset, 'baseColor').uv).toBeUndefined();
        const exported = materialToMaterialX(asset, 'standard_surface', (id) => id.replace(/^tex:/, ''));
        expect(exported.leftOut).toEqual([]);
        expect((exported.document.match(/<input name="uvtiling"/g) ?? []).length).toBe(2);
    });
});
