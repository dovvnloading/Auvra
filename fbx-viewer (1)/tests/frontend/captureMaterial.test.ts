import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BAKE_PLACE_ATTRIBUTE, captureMaterial, isUnboundedValue, type CapturedValue } from '../../runtime/materials/captureMaterial';
import { GraphMaterial } from '../../runtime/materials/graphMaterial';
import { OUTPUT_NODE_TYPE, defaultParams, normalizeMaterialGraph } from '../../runtime/materials/materialGraph';

/** The standard material's own shader source, which a material patches and this adds to. */
const standardShader = (): THREE.WebGLProgramParametersWithUniforms => ({
  vertexShader: THREE.ShaderChunk.meshphysical_vert,
  fragmentShader: THREE.ShaderChunk.meshphysical_frag,
  uniforms: {},
} as unknown as THREE.WebGLProgramParametersWithUniforms);

const captured = (material: THREE.Material, value: CapturedValue, place: Parameters<typeof captureMaterial>[2] = 'uv') => {
  const capture = captureMaterial(material, value, place);
  const shader = standardShader();
  capture.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return { capture, shader };
};

const graphed = () => new GraphMaterial(normalizeMaterialGraph({
  nodes: [
    { id: 'out', type: OUTPUT_NODE_TYPE, x: 0, y: 0, params: defaultParams(OUTPUT_NODE_TYPE) },
    { id: 'noise', type: 'noise', x: 0, y: 0, params: defaultParams('noise') },
  ],
  links: [{ fromNode: 'noise', fromOutput: 'out', toNode: 'out', toInput: 'baseColor' }],
}));

describe('asking a material what its shader works out', () => {
  it('draws each triangle where it lies on the map, after everything is worked out from where it stands', () => {
    const { capture, shader } = captured(graphed(), 'baseColor');
    expect(capture.side).toBe(THREE.DoubleSide);
    expect(capture.blending).toBe(THREE.NoBlending);
    expect(capture.depthTest).toBe(false);
    const place = shader.vertexShader.indexOf('gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);');
    expect(place).toBeGreaterThan(shader.vertexShader.indexOf('vMgWorldPosition = (mgModel'));
    expect(shader.fragmentShader.startsWith('#undef DOUBLE_SIDED')).toBe(true);
  });

  it('writes out each value after the last thing the shader does', () => {
    const lastLine = '#include <dithering_fragment>';
    for (const [value, read] of [
      ['baseColor', 'diffuseColor.rgb'], ['roughness', 'roughnessFactor'], ['metalness', 'metalnessFactor'],
      ['normal', 'mapN'], ['emissive', 'totalEmissiveRadiance'], ['opacity', 'diffuseColor.a'],
    ] as const) {
      const { fragmentShader } = captured(graphed(), value).shader;
      const output = fragmentShader.lastIndexOf('gl_FragColor = vec4(');
      expect(output).toBeGreaterThan(fragmentShader.indexOf(lastLine));
      expect(fragmentShader.slice(output)).toContain(read);
    }
  });

  it('gives a colour as a picture holds one, and values as they are', () => {
    expect(captured(graphed(), 'baseColor').shader.fragmentShader).toContain('sRGBTransferOETF(vec4(clamp(diffuseColor.rgb');
    const roughness = captured(graphed(), 'roughness').shader.fragmentShader;
    expect(roughness.slice(roughness.lastIndexOf('gl_FragColor = vec4('))).not.toContain('sRGBTransferOETF');
  });

  it('runs a material\'s own patches first, whatever they do', () => {
    const patched = new THREE.MeshStandardMaterial();
    patched.onBeforeCompile = (shader) => { shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= 0.5;'); };
    patched.customProgramCacheKey = () => 'patched';
    const { capture, shader } = captured(patched, 'baseColor');
    expect(shader.fragmentShader).toContain('diffuseColor.rgb *= 0.5;');
    expect(capture.customProgramCacheKey()).toContain('patched');
  });

  it('can be told where each corner lies by an attribute of its own', () => {
    const { capture, shader } = captured(graphed(), 'baseColor', BAKE_PLACE_ATTRIBUTE);
    expect(shader.vertexShader).toContain(`attribute vec2 ${BAKE_PLACE_ATTRIBUTE};`);
    expect(shader.vertexShader).toContain(`gl_Position = vec4(${BAKE_PLACE_ATTRIBUTE} * 2.0 - 1.0, 0.0, 1.0);`);
    expect(capture.customProgramCacheKey()).not.toBe(captured(graphed(), 'baseColor').capture.customProgramCacheKey());
  });

  it('can draw each vertex as a pixel of a grid, and tells where it ended up', () => {
    const { vertexShader, fragmentShader } = captured(new THREE.MeshStandardMaterial(), 'worldPosition', { columns: 8, rows: 4 }).shader;
    expect(vertexShader).toContain('gl_VertexID % 8');
    expect(vertexShader).toContain('gl_PointSize = 1.0;');
    // Wind is added once a vertex is in the camera's space.
    expect(vertexShader).toContain('inverse(viewMatrix) * vec4(mvPosition.xyz, 1.0)');
    expect(fragmentShader).toContain('varying vec3 vCaptured;');
  });

  it('leaves the material it was asked about as it was, and each question is a shader of its own', () => {
    const material = new THREE.MeshStandardMaterial({ alphaTest: 0.5 });
    const { capture } = captured(material, 'roughness');
    expect(capture.alphaTest).toBe(0);
    expect(material.alphaTest).toBe(0.5);
    expect(material.transparent).toBe(false);
    expect(capture.customProgramCacheKey()).not.toBe(captured(material, 'metalness').capture.customProgramCacheKey());
  });

  it('knows what goes past what a byte holds', () => {
    expect(['emissive', 'worldPosition', 'worldNormal'].every((value) => isUnboundedValue(value as CapturedValue))).toBe(true);
    expect(isUnboundedValue('baseColor')).toBe(false);
  });
});
