import { describe, expect, it } from 'vitest';
import { OUTPUT_NODE_TYPE, defaultParams, normalizeMaterialGraph, type MaterialGraph } from '../../runtime/materials/materialGraph';
import type { MaterialAsset } from '../../runtime/materials/materialLibrary';
import { materialFromMaterialX, materialToMaterialX, materialXPictures, type MaterialXSurface } from '../../texturing/materialX';

const VALUES = {
    baseColor: [0.6, 0.3, 0.1], metalness: 0.9, roughness: 0.35, specularWeight: 0.8, specularColor: [1, 0.9, 0.8], ior: 1.45,
    anisotropy: 0.4, anisotropyRotation: 90, coat: 0.5, coatRoughness: 0.1, sheenColor: [0.2, 0.3, 0.4], sheenRoughness: 0.6,
    thinFilm: 1, thinFilmThickness: 500, transmission: 0.25, attenuationColor: [0.9, 1, 0.95], attenuationDistance: 2,
    dispersion: 0.5, emissive: [1, 0.5, 0], emissiveStrength: 3, opacity: 0.75,
};

/** A metal with a colour picture, roughness from the green of a packed picture, a normal map and a worked-out specular. */
const material = (): MaterialAsset => ({
    id: 'm1',
    name: 'Copper kettle',
    graph: normalizeMaterialGraph({
        nodes: [
            { id: 'out', type: OUTPUT_NODE_TYPE, x: 0, y: 0, params: { ...defaultParams(OUTPUT_NODE_TYPE), ...VALUES } },
            { id: 'colour', type: 'texture', x: -300, y: 0, params: { ...defaultParams('texture'), texture: 'tex-colour', space: 'color' } },
            { id: 'orm', type: 'texture', x: -300, y: 150, params: { ...defaultParams('texture'), texture: 'tex-orm', space: 'data' } },
            { id: 'normal', type: 'normalMap', x: -300, y: 300, params: { ...defaultParams('normalMap'), texture: 'tex-normal', strength: 0.7 } },
            { id: 'half', type: 'multiply', x: -300, y: 450, params: {} },
        ],
        links: [
            { fromNode: 'colour', fromOutput: 'rgb', toNode: 'out', toInput: 'baseColor' },
            { fromNode: 'orm', fromOutput: 'g', toNode: 'out', toInput: 'roughness' },
            { fromNode: 'orm', fromOutput: 'b', toNode: 'out', toInput: 'metalness' },
            { fromNode: 'normal', fromOutput: 'out', toNode: 'out', toInput: 'normal' },
            { fromNode: 'half', fromOutput: 'out', toNode: 'out', toInput: 'specularWeight' },
        ],
    }),
});

const FILES: Record<string, string> = { 'tex-colour': 'kettle_col.png', 'tex-orm': 'kettle_orm.png', 'tex-normal': 'kettle_nor_gl.png' };

const outputOf = (graph: MaterialGraph) => graph.nodes.find(node => node.type === OUTPUT_NODE_TYPE)!;
const wiredInto = (graph: MaterialGraph, input: string) => {
    const link = graph.links.find(candidate => candidate.toInput === input);
    const node = graph.nodes.find(candidate => candidate.id === link?.fromNode);
    return node ? { type: node.type, output: link!.fromOutput, texture: node.params.texture, space: node.params.space, strength: node.params.strength } : null;
};

describe.each<MaterialXSurface>(['standard_surface', 'open_pbr_surface'])('MaterialX as %s', (surface) => {
    it('keeps the values and pictures through a round trip', () => {
        const exported = materialToMaterialX(material(), surface, (id) => FILES[id] ?? null);
        expect(exported.document).toContain(`<${surface} name="Copper_kettle_surface" type="surfaceshader">`);
        expect(exported.document).toContain('<surfacematerial name="Copper_kettle" type="material">');
        expect(exported.textures).toEqual([
            { textureId: 'tex-colour', path: 'textures/kettle_col.png' },
            { textureId: 'tex-orm', path: 'textures/kettle_orm.png' },
            { textureId: 'tex-normal', path: 'textures/kettle_nor_gl.png' },
        ]);
        // What the graph works out is said to be left out, at its value.
        expect(exported.leftOut).toEqual(surface === 'standard_surface' ? ['specularWeight'] : ['specularWeight', 'anisotropyRotation']);
        expect(materialXPictures(exported.document)).toEqual([
            { path: 'textures/kettle_col.png', colour: true },
            { path: 'textures/kettle_orm.png', colour: false },
            { path: 'textures/kettle_nor_gl.png', colour: false },
        ]);

        const back = new Map(exported.textures.map(texture => [texture.path, `new-${texture.textureId}`]));
        const { asset, leftOut } = materialFromMaterialX(exported.document, (path) => back.get(path) ?? null, 'm2');
        expect(leftOut).toEqual([]);
        expect(asset).toMatchObject({ id: 'm2', name: 'Copper kettle' });
        const params = outputOf(asset.graph).params;
        for (const [key, value] of Object.entries(VALUES)) {
            // An input read from a picture keeps the picture, not its value.
            if (key === 'baseColor' || key === 'roughness' || key === 'metalness') continue;
            if (key === 'anisotropyRotation' && surface === 'open_pbr_surface') continue;
            if (Array.isArray(value)) (value as number[]).forEach((v, i) => expect((params[key] as number[])[i]).toBeCloseTo(v, 5));
            else expect(params[key]).toBeCloseTo(value, 5);
        }
        expect(wiredInto(asset.graph, 'baseColor')).toEqual({ type: 'texture', output: 'rgb', texture: 'new-tex-colour', space: 'color', strength: undefined });
        expect(wiredInto(asset.graph, 'roughness')).toMatchObject({ type: 'texture', output: 'g', texture: 'new-tex-orm', space: 'data' });
        expect(wiredInto(asset.graph, 'metalness')).toMatchObject({ type: 'texture', output: 'b', texture: 'new-tex-orm' });
        expect(wiredInto(asset.graph, 'normal')).toMatchObject({ type: 'normalMap', output: 'out', texture: 'new-tex-normal', strength: 0.7 });
    });
});

describe('reading MaterialX from elsewhere', () => {
    it('follows a nodegraph\'s outputs to its images, and says what it cannot read', () => {
        const document = `<?xml version="1.0"?>
<materialx version="1.38">
  <nodegraph name="NG_bricks">
    <tiledimage name="colour" type="color3">
      <input name="file" type="filename" value="bricks_basecolor.jpg" colorspace="srgb_texture" />
      <input name="uvtiling" type="vector2" value="2, 2" />
    </tiledimage>
    <tiledimage name="rough" type="float">
      <input name="file" type="filename" value="bricks_roughness.jpg" />
    </tiledimage>
    <multiply name="dimmed" type="float"><input name="in1" type="float" nodename="rough" /><input name="in2" type="float" value="0.5" /></multiply>
    <output name="base_color_output" type="color3" nodename="colour" />
    <output name="roughness_output" type="float" nodename="rough" />
    <output name="coat_output" type="float" nodename="dimmed" />
  </nodegraph>
  <standard_surface name="SR_bricks" type="surfaceshader">
    <input name="base" type="float" value="1" />
    <input name="base_color" type="color3" nodegraph="NG_bricks" output="base_color_output" />
    <input name="specular_roughness" type="float" nodegraph="NG_bricks" output="roughness_output" />
    <input name="coat" type="float" nodegraph="NG_bricks" output="coat_output" />
    <input name="metalness" type="float" value="0" />
  </standard_surface>
  <surfacematerial name="Bricks_old" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="SR_bricks" />
  </surfacematerial>
</materialx>`;
        expect(materialXPictures(document)).toEqual([{ path: 'bricks_basecolor.jpg', colour: true }, { path: 'bricks_roughness.jpg', colour: false }]);
        const { asset, leftOut } = materialFromMaterialX(document, (path) => `id:${path}`, 'b1');
        expect(asset.name).toBe('Bricks old');
        expect(leftOut).toEqual(['coat']);
        expect(wiredInto(asset.graph, 'baseColor')).toMatchObject({ texture: 'id:bricks_basecolor.jpg', output: 'rgb', space: 'color' });
        expect(wiredInto(asset.graph, 'roughness')).toMatchObject({ texture: 'id:bricks_roughness.jpg', output: 'r', space: 'data' });
        expect(outputOf(asset.graph).params.metalness).toBe(0);
    });

    it('reads markup-shaped attribute values as text and keeps imported elements off the page', () => {
        const xml = '<materialx><standard_surface name="&lt;Copper&gt;"/><aside id="materialx-import-test"/></materialx>';
        const { asset } = materialFromMaterialX(xml, () => null, 'm1');
        expect(asset.name).toBe('<Copper>');
        expect(document.getElementById('materialx-import-test')).toBeNull();
    });

    it('refuses what is not MaterialX', () => {
        expect(() => materialFromMaterialX('<svg></svg>', () => null, 'x')).toThrow('not a MaterialX file');
    });
});
