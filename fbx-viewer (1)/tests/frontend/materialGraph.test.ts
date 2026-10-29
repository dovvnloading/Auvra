import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  MATERIAL_NODE_DEFINITIONS,
  OUTPUT_NODE_TYPE,
  compileMaterialGraph,
  materialGraphSettings,
  resolveAutoTypes,
  convertValue,
  createMaterialGraph,
  defaultParams,
  materialGraphParameters,
  normalizeMaterialGraph,
  withMaterialParameters,
  wouldCreateCycle,
  type MaterialGraph,
} from '../../runtime/materials/materialGraph';
import { GraphMaterial, MATERIAL_TIME, bindMaterialGraph, boundMaterialGraph, unbindMaterialGraph } from '../../runtime/materials/graphMaterial';
import { graphTextures, materialAssetDocument, materialLibrary, readMaterialAsset } from '../../runtime/materials/materialLibrary';
import { applyMaterialOverrides, materialParameterValues, normalizeMaterialOverride } from '../../utils/materialOverrides';

const node = (id: string, type: string, params: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, params: { ...defaultParams(type), ...params } });
const link = (fromNode: string, fromOutput: string, toNode: string, toInput: string) => ({ fromNode, fromOutput, toNode, toInput });

/** A texture tinted by a colour into the base colour, and a panning noise into the emissive. */
const tintedGraph = (): MaterialGraph => normalizeMaterialGraph({
  nodes: [
    node('out', OUTPUT_NODE_TYPE),
    node('tex', 'texture', { texture: 'bricks' }),
    node('tint', 'color', { value: [1, 0.5, 0.25] }),
    node('mul', 'multiply'),
    node('pan', 'panner'),
    node('noise', 'noise'),
  ],
  links: [
    link('tex', 'rgb', 'mul', 'a'),
    link('tint', 'out', 'mul', 'b'),
    link('mul', 'out', 'out', 'baseColor'),
    link('pan', 'out', 'noise', 'uv'),
    link('noise', 'out', 'out', 'emissive'),
  ],
});

/** The standard material's own shader source, which GraphMaterial patches. */
const standardShader = (): THREE.WebGLProgramParametersWithUniforms => ({
  vertexShader: THREE.ShaderLib.physical.vertexShader,
  fragmentShader: THREE.ShaderLib.physical.fragmentShader,
  uniforms: {},
} as unknown as THREE.WebGLProgramParametersWithUniforms);

describe('material graphs', () => {
  it('converts values between float and vector types', () => {
    expect(convertValue('x', 'float', 'vec3')).toBe('vec3(x)');
    expect(convertValue('x', 'float', 'vec4')).toBe('vec4(x)');
    expect(convertValue('v', 'vec4', 'vec3')).toBe('(v).xyz');
    expect(convertValue('v', 'vec3', 'float')).toBe('(v).x');
    expect(convertValue('v', 'vec2', 'vec4')).toBe('vec4(v, 0.0, 1.0)');
    expect(convertValue('v', 'vec3', 'vec3')).toBe('v');
  });

  it('makes a stored graph safe: known nodes, valid params, real ports, one Material Output', () => {
    const graph = normalizeMaterialGraph({
      nodes: [
        node('a', 'float', { value: 'not a number' }),
        { id: 'b', type: 'no such node', x: 0, y: 0, params: {} },
        node('a', 'color'),
        node('o1', OUTPUT_NODE_TYPE, { roughness: 7 }),
        node('o2', OUTPUT_NODE_TYPE),
      ],
      links: [
        link('a', 'out', 'o1', 'roughness'),
        link('a', 'out', 'o1', 'roughness'),
        link('a', 'missing', 'o1', 'metalness'),
        link('b', 'out', 'o1', 'opacity'),
        link('a', 'out', 'o1', 'nonsense'),
      ],
    });
    expect(graph.nodes.map(n => `${n.id}:${n.type}`)).toEqual(['a:float', 'o1:output']);
    expect(graph.nodes[0].params.value).toBe(1);
    expect(graph.nodes[1].params.roughness).toBe(1);
    expect(graph.links).toEqual([link('a', 'out', 'o1', 'roughness')]);
    // An empty graph gets its Material Output.
    expect(normalizeMaterialGraph(null).nodes.map(n => n.type)).toEqual([OUTPUT_NODE_TYPE]);
  });

  it('compiles each node once, after what it reads, into the output inputs', () => {
    const compiled = compileMaterialGraph(tintedGraph());
    const code = compiled.statements.join('\n');
    expect(code).toContain('texture(mg_tex_texture, vUv)');
    expect(code).toContain('uMaterialTime');
    expect(code.indexOf('mg_tex_sample')).toBeLessThan(code.indexOf('mg_mul_out'));
    // Texture RGB times a colour is a colour: the auto Multiply needs no conversion.
    expect(compiled.outputs.baseColor).toMatch(/^mg_mul_out_out_\d+$/);
    expect(compiled.outputs.roughness).toBe('mg_out_roughness');
    expect(compiled.connected).toEqual(new Set(['baseColor', 'emissive']));
    expect(compiled.uniforms.map(u => `${u.name}:${u.kind}`)).toEqual(expect.arrayContaining([
      'mg_tex_texture:texture', 'mg_tint_value:color', 'mg_out_roughness:float', 'mg_noise_scale:float', 'mg_pan_speed:vec2',
    ]));
  });

  it('keeps the shader for a change of constants, and rebuilds it for a change of wiring', () => {
    const graph = tintedGraph();
    const key = compileMaterialGraph(graph).key;
    const recoloured = { ...graph, nodes: graph.nodes.map(n => (n.id === 'tint' ? { ...n, params: { value: [0, 1, 0] } } : n)) };
    expect(compileMaterialGraph(recoloured).key).toBe(key);
    const rewired = { ...graph, links: graph.links.filter(l => l.toInput !== 'emissive') };
    expect(compileMaterialGraph(rewired).key).not.toBe(key);
  });

  it('refuses links that close a loop, and survives one in stored data', () => {
    const graph = normalizeMaterialGraph({
      nodes: [node('out', OUTPUT_NODE_TYPE), node('a', 'add'), node('b', 'add')],
      links: [link('a', 'out', 'b', 'a'), link('b', 'out', 'out', 'baseColor')],
    });
    expect(wouldCreateCycle(graph, 'b', 'a')).toBe(true);
    expect(wouldCreateCycle(graph, 'a', 'out')).toBe(false);
    const looped = { ...graph, links: [...graph.links, link('b', 'out', 'a', 'a')] };
    expect(() => compileMaterialGraph(looped)).not.toThrow();
  });

  it('splats the param of an unwired auto input to the type wired into the node', () => {
    const graph = normalizeMaterialGraph({
      nodes: [node('out', OUTPUT_NODE_TYPE), node('lerp', 'lerp'), node('c', 'color')],
      links: [link('c', 'out', 'lerp', 'a'), link('lerp', 'out', 'out', 'baseColor')],
    });
    const code = compileMaterialGraph(graph).statements.join('\n');
    // A colour wired into A makes the Lerp work on colours; B and T are numbers splatted to colours.
    expect(code).toMatch(/vec3 mg_lerp_out_out_\d+ = mix\(mg_c_out_out_\d+, vec3\(mg_lerp_b\), vec3\(mg_lerp_t\)\);/);
  });

  it('leaves out nodes that do not reach the output', () => {
    const graph = normalizeMaterialGraph({ nodes: [node('out', OUTPUT_NODE_TYPE), node('lonely', 'noise')], links: [] });
    const compiled = compileMaterialGraph(graph);
    expect(compiled.unused).toEqual(['lonely']);
    expect(compiled.statements).toEqual([]);
  });
});

describe('material parameters', () => {
  /** A tint and a strength exposed by name, and a constant that is not. */
  const exposed = () => normalizeMaterialGraph({
    nodes: [
      node('out', OUTPUT_NODE_TYPE),
      { ...node('tint', 'color', { value: [1, 0.5, 0.25] }), parameter: '  Tint ' },
      { ...node('tint2', 'color', { value: [0, 0, 0] }), parameter: 'Tint' },
      { ...node('k', 'float', { value: 2 }), parameter: 'Strength' },
      { ...node('n', 'noise'), parameter: 'Not a value node' },
      node('plain', 'float', { value: 9 }),
    ],
    links: [link('tint', 'out', 'out', 'baseColor'), link('k', 'out', 'out', 'roughness')],
  });

  it('keeps the names of value nodes, trimmed, and lists each name once with its value', () => {
    const graph = exposed();
    expect(graph.nodes.find(n => n.id === 'tint')?.parameter).toBe('Tint');
    expect(graph.nodes.find(n => n.id === 'n')?.parameter).toBeUndefined();
    expect(materialGraphParameters(graph).map(p => [p.name, p.param.kind, p.value])).toEqual([
      ['Strength', 'float', 2],
      ['Tint', 'color', [1, 0.5, 0.25]],
    ]);
  });

  it('sets every node of a name to the value, keeps the rest, and changes only constants', () => {
    const graph = exposed();
    expect(withMaterialParameters(graph, undefined)).toBe(graph);
    expect(withMaterialParameters(graph, { Missing: 1 })).toBe(graph);
    const set = withMaterialParameters(graph, { Tint: [0, 1, 0], Strength: 'loud' as unknown as number });
    expect(set.nodes.find(n => n.id === 'tint')?.params.value).toEqual([0, 1, 0]);
    expect(set.nodes.find(n => n.id === 'tint2')?.params.value).toEqual([0, 1, 0]);
    // A malformed value falls back to the node's default, and the graph keeps its wiring and shader.
    expect(set.nodes.find(n => n.id === 'k')?.params.value).toBe(defaultParams('float').value);
    expect(set.nodes.find(n => n.id === 'plain')?.params.value).toBe(9);
    expect(compileMaterialGraph(set).key).toBe(compileMaterialGraph(graph).key);
  });

  it('stores the settings of a material as a sorted list of names and values', () => {
    const override = normalizeMaterialOverride({
      materialId: 'm',
      parameters: [
        { name: 'Tint', value: [1, 0, 0] },
        { name: 'Strength', value: 3 },
        { name: 'Tint', value: [0, 0, 1] },
        { name: ' padded', value: 1 },
        { name: 'Pair', value: [1, 2] },
        { name: 'Word', value: 'x' },
      ],
    });
    expect(override?.parameters).toEqual([{ name: 'Strength', value: 3 }, { name: 'Tint', value: [1, 0, 0] }]);
    expect(materialParameterValues(override?.parameters)).toEqual({ Strength: 3, Tint: [1, 0, 0] });
    expect(normalizeMaterialOverride({ parameters: { Tint: 1 } })).toBeNull();
  });

  it('gives each material using an asset its own values, on the same shader', () => {
    materialLibrary.replaceAll([{ id: 'paint', name: 'Paint', graph: exposed() }]);
    const red = new THREE.MeshStandardMaterial({ name: 'Red' });
    const blue = new THREE.MeshStandardMaterial({ name: 'Blue' });
    const root = new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry(), [red, blue]));
    applyMaterialOverrides(root, {
      Red: { materialId: 'paint', parameters: [{ name: 'Tint', value: [1, 0, 0] }] },
      Blue: { materialId: 'paint', parameters: [{ name: 'Tint', value: [0, 0, 1] }] },
    });
    const tint = (material: THREE.Material) => boundMaterialGraph(material)?.nodes.find(n => n.id === 'tint')?.params.value;
    expect(tint(red)).toEqual([1, 0, 0]);
    expect(tint(blue)).toEqual([0, 0, 1]);
    expect(red.customProgramCacheKey()).toBe(blue.customProgramCacheKey());
    applyMaterialOverrides(root, {});
    materialLibrary.replaceAll([]);
  });
});

describe('graph materials', () => {
  it('splices the graph into the standard material shader', () => {
    const material = new GraphMaterial(tintedGraph());
    const shader = standardShader();
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain('diffuseColor.rgb = mg_mul_out_out_');
    expect(shader.fragmentShader).toContain('float roughnessFactor = mg_out_roughness;');
    expect(shader.fragmentShader).toContain('uniform sampler2D mg_tex_texture;');
    expect(shader.fragmentShader).not.toContain('#include <map_fragment>');
    expect(shader.vertexShader).toContain('vMgWorldPosition = (mgModel * vec4(transformed, 1.0)).xyz;');
    expect(shader.uniforms.uMaterialTime).toBe(MATERIAL_TIME);
    // A colour picked in sRGB reaches the shader in linear light.
    const tint = (shader.uniforms.mg_tint_value as THREE.IUniform<THREE.Color>).value;
    expect(tint.g).toBeCloseTo(new THREE.Color().setRGB(1, 0.5, 0.25, THREE.SRGBColorSpace).g, 5);
    expect(material.customProgramCacheKey()).toContain('graph:');
  });

  it('wires a normal map through three’s tangent frame, and transparency through opacity', () => {
    const graph = normalizeMaterialGraph({
      nodes: [node('out', OUTPUT_NODE_TYPE, { blendMode: 'translucent' }), node('nm', 'normalMap'), node('fade', 'float', { value: 0.4 })],
      links: [link('nm', 'out', 'out', 'normal'), link('fade', 'out', 'out', 'opacity')],
    });
    const material = new GraphMaterial(graph);
    expect(material.normalMap).not.toBeNull();
    expect(material.transparent).toBe(true);
    const shader = standardShader();
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toMatch(/vec3 mg_nm_out_out_\d+ = normalize\(mg_nm_normal\);/);
    expect(shader.fragmentShader).toMatch(/vec3 mapN = mg_nm_out_out_\d+;/);
    expect(shader.fragmentShader).not.toContain('mg_nm_normal.y = -mg_nm_normal.y;');
    // A DirectX normal map has its green flipped.
    const directX = compileMaterialGraph(normalizeMaterialGraph({
      nodes: [node('out', OUTPUT_NODE_TYPE), node('nm', 'normalMap', { flipGreen: true })],
      links: [link('nm', 'out', 'out', 'normal')],
    }));
    expect(directX.statements).toContain('mg_nm_normal.y = -mg_nm_normal.y;');
  });

  it('updates constants in place, and rebuilds only when the wiring changes', () => {
    const material = new GraphMaterial(tintedGraph(), () => null);
    const shader = standardShader();
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    const version = material.version;
    const graph = material.getGraph();
    material.setGraph({ ...graph, nodes: graph.nodes.map(n => (n.id === 'out' ? { ...n, params: { ...n.params, roughness: 0.1 } } : n)) });
    expect(material.version).toBe(version);
    expect((shader.uniforms.mg_out_roughness as THREE.IUniform<number>).value).toBeCloseTo(0.1);
    material.setGraph({ ...graph, links: [] });
    expect(material.version).toBeGreaterThan(version);
  });

  it('binds to an imported material in place, and gives it back its own shading when unbound', () => {
    const imported = new THREE.MeshStandardMaterial({ name: 'Bricks' });
    const ownKey = imported.customProgramCacheKey();
    bindMaterialGraph(imported, tintedGraph());
    expect(boundMaterialGraph(imported)).not.toBeNull();
    expect(imported.customProgramCacheKey()).toContain('graph:');
    expect(imported.defines?.USE_UV).toBe('');
    const shader = standardShader();
    imported.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain('diffuseColor.rgb = mg_mul_out_out_');
    unbindMaterialGraph(imported);
    expect(boundMaterialGraph(imported)).toBeNull();
    expect(imported.customProgramCacheKey()).toBe(ownKey);
    expect(imported.defines?.USE_UV).toBeUndefined();
    const own = standardShader();
    imported.onBeforeCompile(own, {} as THREE.WebGLRenderer);
    expect(own.fragmentShader).toContain('#include <map_fragment>');
  });

  it('starts from a plain grey surface', () => {
    const compiled = compileMaterialGraph(createMaterialGraph());
    expect(compiled.connected.size).toBe(0);
    expect(compiled.outputs.baseColor).toBe('mg_output_baseColor');
  });
});

describe('material graph v2', () => {
  it('gives math nodes the widest type wired into them', () => {
    const graph = normalizeMaterialGraph({
      nodes: [node('out', OUTPUT_NODE_TYPE), node('c', 'color'), node('add', 'add'), node('k', 'float'), node('mul', 'multiply'), node('uv', 'uv'), node('sin', 'sine')],
      links: [link('c', 'out', 'add', 'a'), link('k', 'out', 'mul', 'a'), link('uv', 'out', 'sin', 'in'), link('add', 'out', 'out', 'baseColor')],
    });
    const types = resolveAutoTypes(graph);
    expect(types.get('add')).toBe('vec3');
    expect(types.get('mul')).toBe('float');
    expect(types.get('sin')).toBe('vec2');
    const code = compileMaterialGraph(graph).statements.join('\n');
    // The unwired B of a colour Add is its number, splatted to a colour.
    expect(code).toMatch(/vec3 mg_add_out_out_\d+ = \(mg_c_out_out_\d+ \+ vec3\(mg_add_b\)\);/);
  });

  it('reads graphs from before blend modes as translucent only where they set an opacity', () => {
    const stored = (params: Record<string, unknown>, links: unknown[] = []) => normalizeMaterialGraph({
      nodes: [{ id: 'out', type: OUTPUT_NODE_TYPE, x: 0, y: 0, params }, node('k', 'float')],
      links,
    });
    expect(materialGraphSettings(stored({})).blendMode).toBe('opaque');
    expect(materialGraphSettings(stored({ opacity: 0.5 })).blendMode).toBe('translucent');
    expect(materialGraphSettings(stored({}, [link('k', 'out', 'out', 'opacity')])).blendMode).toBe('translucent');
    expect(materialGraphSettings(stored({ blendMode: 'masked', alphaClip: 0.3, twoSided: true, shading: 'unlit' }))).toEqual({
      blendMode: 'masked', alphaClip: 0.3, twoSided: true, unlit: true,
    });
  });

  it('compiles every node in every stage', () => {
    for (const definition of MATERIAL_NODE_DEFINITIONS) {
      if (definition.type === OUTPUT_NODE_TYPE) continue;
      const graph = normalizeMaterialGraph({
        nodes: [node('out', OUTPUT_NODE_TYPE, { blendMode: 'masked' }), node('n', definition.type)],
        links: [
          link('n', definition.outputs[0].key, 'out', 'baseColor'),
          link('n', definition.outputs[0].key, 'out', 'opacity'),
          link('n', definition.outputs[0].key, 'out', 'worldPositionOffset'),
        ],
      });
      for (const stage of ['fragment', 'vertex', 'shadow'] as const) {
        const compiled = compileMaterialGraph(graph, { stage });
        expect(compiled.unused, `${definition.type} in the ${stage} stage`).toEqual([]);
        expect(compiled.statements.join('\n')).not.toMatch(/undefined|NaN/);
      }
    }
  });

  it('computes the vertex offset in the vertex shader from vertex builtins', () => {
    const graph = normalizeMaterialGraph({
      nodes: [node('out', OUTPUT_NODE_TYPE), node('pos', 'worldPosition'), node('t', 'time'), node('wave', 'sine'), node('up', 'multiply')],
      links: [link('t', 'out', 'wave', 'in'), link('wave', 'out', 'up', 'a'), link('pos', 'out', 'up', 'b'), link('up', 'out', 'out', 'worldPositionOffset')],
    });
    const vertex = compileMaterialGraph(graph, { stage: 'vertex' });
    expect(Object.keys(vertex.outputs)).toEqual(['worldPositionOffset']);
    expect(vertex.statements.join('\n')).toContain('mgVertexWorld');
    expect(vertex.statements.join('\n')).toContain('uMaterialTime');
    const material = new GraphMaterial(graph);
    const shader = standardShader();
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toMatch(/transformed \+= inverse\(mat3\(mgModel\)\) \* \(mg_up_out_out_\d+\);/);
    expect(shader.vertexShader.indexOf('transformed +=')).toBeLessThan(shader.vertexShader.indexOf('#include <project_vertex>'));
    // Offset vertices move the shadow too: the material gets the depth material of its own that carries it.
    expect(material.alphaTest).toBeGreaterThan(0);
    expect(material.map).not.toBeNull();
  });

  it('sets blending, clipping, sides and lighting from the Material Output, and gives them back when unbound', () => {
    const settings = (params: Record<string, unknown>) => normalizeMaterialGraph({ nodes: [node('out', OUTPUT_NODE_TYPE, params)], links: [] });
    const material = new THREE.MeshStandardMaterial({ side: THREE.FrontSide });
    bindMaterialGraph(material, settings({ blendMode: 'additive' }));
    expect([material.transparent, material.depthWrite, material.blending]).toEqual([true, false, THREE.AdditiveBlending]);
    bindMaterialGraph(material, settings({ blendMode: 'masked', alphaClip: 0.35, twoSided: true }));
    expect([material.transparent, material.depthWrite, material.alphaTest, material.side]).toEqual([false, true, 0.35, THREE.DoubleSide]);
    bindMaterialGraph(material, settings({ shading: 'unlit' }));
    const shader = standardShader();
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain('vec3 outgoingLight = diffuseColor.rgb + totalEmissiveRadiance;');
    expect(shader.fragmentShader).toContain('diffuseColor.a = 1.0;');
    unbindMaterialGraph(material);
    expect([material.transparent, material.depthWrite, material.alphaTest, material.side, material.map, material.blending])
      .toEqual([false, true, 0, THREE.FrontSide, null, THREE.NormalBlending]);
  });

  it('teaches the shadow depth material of a masked material its cut-out', () => {
    const graph = normalizeMaterialGraph({
      nodes: [node('out', OUTPUT_NODE_TYPE, { blendMode: 'masked' }), node('check', 'checker')],
      links: [link('check', 'out', 'out', 'opacity')],
    });
    const material = new GraphMaterial(graph);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
    const depth = new THREE.MeshDepthMaterial();
    const shadowDraw = () => mesh.onBeforeShadow({} as THREE.WebGLRenderer, new THREE.Scene(), new THREE.Camera(), new THREE.Camera(), mesh.geometry, depth, null as unknown as THREE.Group);
    shadowDraw();
    expect(depth.customProgramCacheKey()).toContain('graph-shadow:');
    const shader = {
      vertexShader: THREE.ShaderLib.depth.vertexShader,
      fragmentShader: THREE.ShaderLib.depth.fragmentShader,
      uniforms: {},
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    depth.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toMatch(/diffuseColor\.a = mg_check_out_out_\d+;/);
    expect(shader.fragmentShader).not.toContain('#include <map_fragment>');
    // Unbound, the depth material shades as three's own again.
    unbindMaterialGraph(material);
    shadowDraw();
    expect(depth.customProgramCacheKey()).not.toContain('graph-shadow:');
  });

  it('sends a colour ramp as eight linear stops', () => {
    const graph = normalizeMaterialGraph({
      nodes: [
        node('out', OUTPUT_NODE_TYPE),
        node('ramp', 'colorRamp', { ramp: { stops: [{ position: 0.8, color: [1, 1, 1] }, { position: 0.2, color: [1, 0, 0] }] } }),
      ],
      links: [link('ramp', 'out', 'out', 'baseColor')],
    });
    const material = new GraphMaterial(graph);
    const shader = standardShader();
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain('uniform vec4 mg_ramp_ramp[8];');
    const stops = (shader.uniforms.mg_ramp_ramp as THREE.IUniform<THREE.Vector4[]>).value;
    expect(stops).toHaveLength(8);
    expect(stops[0].toArray()).toEqual([1, 0, 0, 0.2]);
    expect(stops[1].w).toBe(0.8);
    // Past the last stop it holds the last colour.
    expect(stops[7].x).toBe(1);
    expect(stops[7].w).toBeGreaterThan(1);
  });

  it('wraps custom GLSL in a function of its own', () => {
    const graph = normalizeMaterialGraph({
      nodes: [node('out', OUTPUT_NODE_TYPE), node('code', 'customGlsl', { outputType: 'float', code: 'a.x * 2.0' })],
      links: [link('code', 'out', 'out', 'roughness')],
    });
    const compiled = compileMaterialGraph(graph);
    expect(compiled.globals).toEqual(['float mg_code_fn(vec4 a, vec4 b, vec4 c, vec4 d) {\nreturn float(a.x * 2.0);\n}']);
    expect(compiled.outputs.roughness).toMatch(/^mg_code_out_out_\d+$/);
  });
});

describe('the material library', () => {
  const asset = (id: string, graph: MaterialGraph) => ({ id, name: id, graph });

  it('lists the textures a graph samples, as colour or normals, and keeps them with the asset', () => {
    const graph = normalizeMaterialGraph({
      nodes: [node('out', OUTPUT_NODE_TYPE), node('t1', 'texture', { texture: 'bricks' }), node('t2', 'texture', { texture: 'bricks' }), node('n', 'normalMap', { texture: 'bricks-n' })],
      links: [],
    });
    expect(graphTextures(graph)).toEqual([{ textureId: 'bricks', slot: 'map' }, { textureId: 'bricks-n', slot: 'normal' }]);
    // A mask read as data, and a triplanar texture, are textures of the asset too.
    const masks = normalizeMaterialGraph({
      nodes: [node('out', OUTPUT_NODE_TYPE), node('m', 'texture', { texture: 'mask', space: 'data' }), node('t', 'triplanar', { texture: 'rock' })],
      links: [],
    });
    expect(graphTextures(masks)).toEqual([{ textureId: 'mask', slot: 'data' }, { textureId: 'rock', slot: 'map' }]);
    expect(materialAssetDocument(asset('m', graph)).textureIds).toEqual(['bricks', 'bricks-n']);
    expect(readMaterialAsset({ id: 'x', name: '  ', graph: null })).toMatchObject({ id: 'x', name: 'Material' });
    expect(readMaterialAsset({ name: 'no id' })).toBeNull();
  });

  it('binds assigned materials, follows edits to the asset, and lets go when it is removed', () => {
    materialLibrary.replaceAll([asset('glow', tintedGraph())]);
    const material = new THREE.MeshStandardMaterial();
    expect(materialLibrary.assign(material, 'glow')).toBe(true);
    expect(boundMaterialGraph(material)?.nodes.map(n => n.id)).toContain('tex');

    const plain = normalizeMaterialGraph(null);
    materialLibrary.upsert(asset('glow', plain));
    expect(boundMaterialGraph(material)?.nodes).toHaveLength(1);

    materialLibrary.remove('glow');
    expect(boundMaterialGraph(material)).toBeNull();
    // An asset not loaded (yet) leaves the material as it is.
    expect(materialLibrary.assign(material, 'nowhere')).toBe(false);
    expect(boundMaterialGraph(material)).toBeNull();
    materialLibrary.assign(material, null);
  });

  it('assigns an asset to a model material through its override, and unassigns it again', () => {
    materialLibrary.replaceAll([asset('stone', tintedGraph())]);
    const root = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({ name: 'Wall' });
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
    applyMaterialOverrides(root, { Wall: { materialId: 'stone' } });
    expect(boundMaterialGraph(material)).not.toBeNull();
    applyMaterialOverrides(root, {});
    expect(boundMaterialGraph(material)).toBeNull();
    materialLibrary.replaceAll([]);
  });
});

