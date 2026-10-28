import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  OUTPUT_NODE_TYPE,
  compileMaterialGraph,
  convertValue,
  createMaterialGraph,
  defaultParams,
  normalizeMaterialGraph,
  wouldCreateCycle,
  type MaterialGraph,
} from '../../runtime/materials/materialGraph';
import { GraphMaterial, MATERIAL_TIME, bindMaterialGraph, boundMaterialGraph, unbindMaterialGraph } from '../../runtime/materials/graphMaterial';

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
    expect(convertValue('x', 'float', 'vec4')).toBe('vec4(vec3(x), 1.0)');
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
    expect(code).toContain('texture2D(mg_tex_texture, vUv)');
    expect(code).toContain('uMaterialTime');
    expect(code.indexOf('mg_tex_sample')).toBeLessThan(code.indexOf('mg_mul_out'));
    expect(compiled.outputs.baseColor).toMatch(/^\(mg_mul_out_out_\d+\)\.xyz$/);
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

  it('leaves out nodes that do not reach the output', () => {
    const graph = normalizeMaterialGraph({ nodes: [node('out', OUTPUT_NODE_TYPE), node('lonely', 'noise')], links: [] });
    const compiled = compileMaterialGraph(graph);
    expect(compiled.unused).toEqual(['lonely']);
    expect(compiled.statements).toEqual([]);
  });
});

describe('graph materials', () => {
  it('splices the graph into the standard material shader', () => {
    const material = new GraphMaterial(tintedGraph());
    const shader = standardShader();
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain('diffuseColor.rgb = (mg_mul_out_out_');
    expect(shader.fragmentShader).toContain('float roughnessFactor = mg_out_roughness;');
    expect(shader.fragmentShader).toContain('uniform sampler2D mg_tex_texture;');
    expect(shader.fragmentShader).not.toContain('#include <map_fragment>');
    expect(shader.vertexShader).toContain('vMaterialWorldPosition = ( modelMatrix * materialWorld ).xyz;');
    expect(shader.uniforms.uMaterialTime).toBe(MATERIAL_TIME);
    // A colour picked in sRGB reaches the shader in linear light.
    const tint = (shader.uniforms.mg_tint_value as THREE.IUniform<THREE.Color>).value;
    expect(tint.g).toBeCloseTo(new THREE.Color().setRGB(1, 0.5, 0.25, THREE.SRGBColorSpace).g, 5);
    expect(material.customProgramCacheKey()).toContain('graph:');
  });

  it('wires a normal map through three’s tangent frame, and transparency through opacity', () => {
    const graph = normalizeMaterialGraph({
      nodes: [node('out', OUTPUT_NODE_TYPE), node('nm', 'normalMap'), node('fade', 'float', { value: 0.4 })],
      links: [link('nm', 'out', 'out', 'normal'), link('fade', 'out', 'out', 'opacity')],
    });
    const material = new GraphMaterial(graph);
    expect(material.normalMap).not.toBeNull();
    expect(material.transparent).toBe(true);
    const shader = standardShader();
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toMatch(/vec3 mg_nm_out_out_\d+ = normalize\(mg_nm_normal\);/);
    expect(shader.fragmentShader).toMatch(/vec3 mapN = mg_nm_out_out_\d+;/);
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
    expect(shader.fragmentShader).toContain('diffuseColor.rgb = (mg_mul_out_out_');
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
