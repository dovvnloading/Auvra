import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { OUTPUT_NODE_TYPE, compileMaterialGraph, defaultParams, normalizeMaterialGraph, type MaterialGraph } from '../../runtime/materials/materialGraph';
import { bindMaterialGraph } from '../../runtime/materials/graphMaterial';
import { helperSource } from '../../runtime/materials/materialGlsl';

const node = (id: string, type: string, params: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, params: { ...defaultParams(type), ...params } });
const link = (fromNode: string, fromOutput: string, toNode: string, toInput: string) => ({ fromNode, fromOutput, toNode, toInput });

/** Bricks raised by a height map: Parallax's UV into the colour, its shadow into Self-shadow. */
const bricks = (parallax: Record<string, unknown> = {}, shadowWired = true): MaterialGraph => normalizeMaterialGraph({
    nodes: [node('out', OUTPUT_NODE_TYPE), node('height', 'parallax', { texture: 'bumps', ...parallax }), node('colour', 'texture', { texture: 'bricks' })],
    links: [link('height', 'uv', 'colour', 'uv'), link('colour', 'rgb', 'out', 'baseColor'), ...(shadowWired ? [link('height', 'shadow', 'out', 'selfShadow')] : [])],
});

const fragmentOf = (material: THREE.Material) => {
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader } as unknown as THREE.WebGLProgramParametersWithUniforms;
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    return shader.fragmentShader;
};

describe('the Parallax node', () => {
    it('marches through its height map at the quality asked, and shades toward the sun', () => {
        const medium = compileMaterialGraph(bricks());
        expect(medium.helpers).toEqual(expect.arrayContaining(['mgParallaxUv', 'mgParallaxShadow', 'mgTangentFrame']));
        const code = medium.statements.join('\n');
        expect(code).toMatch(/mgParallaxUv\(mg_height_texture, vUv, normalize\(cameraPosition - vMgWorldPosition\) \* mg_height_frame, mg_height_depth, 16\.0\)/);
        expect(code).toContain('#if NUM_DIR_LIGHTS > 0');
        expect(code).toContain('directionalLights[0].direction');
        // The colour is read where the march ends.
        expect(code).toMatch(/texture\(mg_colour_texture, mg_height_out_uv_\d+\)/);
        expect(compileMaterialGraph(bricks({ quality: 'low' })).statements.join('\n')).toContain(', 8.0)');
        expect(compileMaterialGraph(bricks({ quality: 'high' })).statements.join('\n')).toContain(', 32.0)');
    });

    it('leaves out the shadow march when self-shadow is off, and changes the shader when it is', () => {
        const off = compileMaterialGraph(bricks({ selfShadow: false }));
        expect(off.helpers).not.toContain('mgParallaxShadow');
        expect(off.statements.join('\n')).not.toContain('directionalLights');
        expect(off.key).not.toBe(compileMaterialGraph(bricks()).key);
    });

    it('passes the UV through where no pixel is drawn (vertex offsets)', () => {
        const graph = normalizeMaterialGraph({
            nodes: [node('out', OUTPUT_NODE_TYPE), node('height', 'parallax', { texture: 'bumps' }), node('split', 'split'), node('combine', 'combine')],
            links: [link('height', 'uv', 'split', 'in'), link('split', 'x', 'combine', 'y'), link('combine', 'out', 'out', 'worldPositionOffset')],
        });
        const vertex = compileMaterialGraph(graph, { stage: 'vertex' });
        expect(vertex.helpers).not.toContain('mgParallaxUv');
        expect(vertex.statements.join('\n')).not.toContain('mgParallaxUv');
    });

    it('shades only the direct light through Self-shadow, and costs nothing unwired', () => {
        const material = new THREE.MeshStandardMaterial();
        bindMaterialGraph(material, bricks());
        const shaded = fragmentOf(material);
        const end = shaded.indexOf('#include <lights_fragment_end>');
        expect(end).toBeGreaterThan(0);
        expect(shaded.slice(end)).toMatch(/reflectedLight\.directDiffuse \*= mg_height_out_shadow_\d+;\s*reflectedLight\.directSpecular \*= mg_height_out_shadow_\d+;/);
        const plain = new THREE.MeshStandardMaterial();
        bindMaterialGraph(plain, bricks({}, false));
        expect(fragmentOf(plain)).not.toContain('reflectedLight.directDiffuse *=');
        const none = new THREE.MeshStandardMaterial();
        bindMaterialGraph(none, normalizeMaterialGraph({ nodes: [node('out', OUTPUT_NODE_TYPE)], links: [] }));
        expect(fragmentOf(none)).not.toContain('mgParallax');
    });

    it('has helpers that refine the march between its last two steps', () => {
        const source = helperSource(['mgParallaxUv', 'mgParallaxShadow']);
        expect(source).toContain('textureGrad(heightMap');
        expect(source).toContain('float weight = clamp(below / min(below - above, -1e-5), 0.0, 1.0);');
        expect(source).toContain('if (light.z <= 0.0) return 1.0;');
    });
});
