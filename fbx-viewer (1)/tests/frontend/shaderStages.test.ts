import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { OUTPUT_NODE_TYPE, defaultParams, normalizeMaterialGraph, type MaterialGraph } from '../../runtime/materials/materialGraph';
import { bindMaterialGraph, boundMaterialGraph, unbindMaterialGraph } from '../../runtime/materials/graphMaterial';
import { materialLibrary } from '../../runtime/materials/materialLibrary';
import { hasOwnCompileHook, setShaderStage, shaderStageNames } from '../../runtime/materials/shaderStages';
import { WEATHER_UNIFORMS, hasOwnShader, isWeatherPatched, patchWeatherMaterial, patchWindSurfaces, setSurfaceWeather } from '../../runtime/weatherSurfaces';
import { rebuildNormalZ } from '../../utils/textureCompression/compressTextures';

const node = (id: string, type: string, params: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, params: { ...defaultParams(type), ...params } });
const link = (fromNode: string, fromOutput: string, toNode: string, toInput: string) => ({ fromNode, fromOutput, toNode, toInput });

/** A colour into the base colour. */
const tinted = (value: number[] = [1, 0.5, 0.25]): MaterialGraph => normalizeMaterialGraph({
    nodes: [node('out', OUTPUT_NODE_TYPE), node('tint', 'color', { value })],
    links: [link('tint', 'out', 'out', 'baseColor')],
});

const physicalShader = () => ({
    uniforms: {} as Record<string, THREE.IUniform>,
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
}) as unknown as THREE.WebGLProgramParametersWithUniforms;

const compile = (material: THREE.Material) => {
    const shader = physicalShader();
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    return shader;
};

afterEach(() => setSurfaceWeather(0, 0, null));

describe('shader stages of a material', () => {
    it('runs a graph, a compressed normal map and the weather together, in that order', () => {
        const material = new THREE.MeshStandardMaterial({ name: 'Hull' });
        rebuildNormalZ(material);
        expect(patchWeatherMaterial(material)).toBe(true);
        bindMaterialGraph(material, tinted());
        expect(shaderStageNames(material)).toEqual(['graph', 'normalRg', 'weather']);

        const { fragmentShader, vertexShader, uniforms } = compile(material);
        const graphColour = fragmentShader.indexOf('diffuseColor.rgb = mg_tint_out_out_');
        const weatherColour = fragmentShader.indexOf('diffuseColor.rgb *= 1.0 - 0.42 * weatherWet');
        expect(graphColour).toBeGreaterThan(0);
        // The weather darkens and whitens the colour the graph worked out.
        expect(weatherColour).toBeGreaterThan(graphColour);
        expect(weatherColour).toBeLessThan(fragmentShader.indexOf('#include <lights_physical_fragment>'));
        expect(fragmentShader).toContain('mapN.z = sqrt');
        expect(vertexShader).toContain('vWeatherWorld =');
        expect(vertexShader).toContain('vMgWorldPosition =');
        expect(uniforms.uWeatherSnow).toBe(WEATHER_UNIFORMS.uWeatherSnow);
        expect(uniforms.mg_tint_value).toBeDefined();
    });

    it('keys the program by every stage, in order, after the material\'s own key', () => {
        const material = new THREE.MeshStandardMaterial();
        const own = material.customProgramCacheKey();
        rebuildNormalZ(material);
        patchWeatherMaterial(material);
        bindMaterialGraph(material, tinted());
        const key = material.customProgramCacheKey();
        expect(key.startsWith(own)).toBe(true);
        const at = (part: string) => key.indexOf(part);
        expect(at('graph:')).toBeGreaterThan(0);
        expect(at('graph:')).toBeLessThan(at('normal-rg'));
        expect(at('normal-rg')).toBeLessThan(at('auvra-weather-1'));
    });

    it('lets an imported material with a compressed normal map take the weather', () => {
        // The compressed-normal hook is put on at load, before the sky first patches the scene.
        const helmet = new THREE.MeshStandardMaterial({ name: 'Helmet' });
        rebuildNormalZ(helmet);
        expect(patchWeatherMaterial(helmet)).toBe(true);
        expect(isWeatherPatched(helmet)).toBe(true);
        const { fragmentShader } = compile(helmet);
        expect(fragmentShader).toContain('mapN.z = sqrt');
        expect(fragmentShader).toContain('weatherOpen()');
        expect(helmet.customProgramCacheKey()).toContain('normal-rg');
        expect(helmet.customProgramCacheKey()).toContain('auvra-weather-1');
    });

    it('lets foliage with a compressed normal map sway', () => {
        const leaves = new THREE.MeshStandardMaterial({ name: 'Leaves' });
        rebuildNormalZ(leaves);
        const scene = new THREE.Scene().add(new THREE.Mesh(new THREE.ConeGeometry(1, 3), leaves));
        expect(patchWindSurfaces(scene)).toBe(1);
        const { vertexShader } = compile(leaves);
        expect(vertexShader).toContain('#define AUVRA_WIND');
        expect(leaves.customProgramCacheKey()).toContain('|wind');
    });

    it('weathers a graph-shaded material, whichever comes first', () => {
        const boundFirst = new THREE.MeshStandardMaterial();
        bindMaterialGraph(boundFirst, tinted());
        expect(patchWeatherMaterial(boundFirst)).toBe(true);
        const weatheredFirst = new THREE.MeshStandardMaterial();
        patchWeatherMaterial(weatheredFirst);
        bindMaterialGraph(weatheredFirst, tinted());
        for (const material of [boundFirst, weatheredFirst]) {
            const { fragmentShader } = compile(material);
            expect(fragmentShader).toContain('diffuseColor.rgb = mg_tint_out_out_');
            expect(fragmentShader).toContain('weatherOpen()');
        }
        // Unbound, the weather stays.
        unbindMaterialGraph(weatheredFirst);
        expect(shaderStageNames(weatheredFirst)).toEqual(['weather']);
        expect(weatheredFirst.customProgramCacheKey()).not.toContain('graph:');
        expect(compile(weatheredFirst).fragmentShader).toContain('weatherOpen()');
    });

    it('runs a hook of the material\'s own first, and still keeps such materials out of the weather unless they ask', () => {
        const terrain = new THREE.MeshStandardMaterial();
        const calls: string[] = [];
        terrain.onBeforeCompile = (shader) => {
            calls.push('own');
            shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n// own patch');
        };
        expect(hasOwnCompileHook(terrain)).toBe(true);
        expect(patchWeatherMaterial(terrain)).toBe(false);
        terrain.userData.weatherSurface = true;
        expect(patchWeatherMaterial(terrain)).toBe(true);
        setShaderStage(terrain, 'normalRg', { patch: () => { calls.push('stage'); }, key: () => 'test-stage' });
        const { fragmentShader } = compile(terrain);
        expect(calls).toEqual(['own', 'stage']);
        expect(fragmentShader).toContain('// own patch');
        expect(fragmentShader).toContain('weatherOpen()');
    });

    it('says a material has a shader of its own only while something patches it beyond the weather, or it is wet', () => {
        const plain = new THREE.MeshStandardMaterial();
        expect(hasOwnShader(plain)).toBe(false);
        patchWeatherMaterial(plain);
        expect(hasOwnShader(plain)).toBe(false);
        setSurfaceWeather(0.5, 0, null);
        expect(hasOwnShader(plain)).toBe(true);
        setSurfaceWeather(0, 0, null);
        const compressed = new THREE.MeshStandardMaterial();
        rebuildNormalZ(compressed);
        expect(hasOwnShader(compressed)).toBe(true);
        const graphed = new THREE.MeshStandardMaterial();
        bindMaterialGraph(graphed, tinted());
        expect(hasOwnShader(graphed)).toBe(true);
        unbindMaterialGraph(graphed);
        expect(hasOwnShader(graphed)).toBe(false);
    });
});

describe('uniforms kept for a material\'s whole life', () => {
    it('keeps one object per uniform across unbinding and binding again', () => {
        const material = new THREE.MeshStandardMaterial();
        bindMaterialGraph(material, tinted([1, 0, 0]));
        const first = compile(material).uniforms.mg_tint_value;
        unbindMaterialGraph(material);
        bindMaterialGraph(material, tinted([0, 0, 1]));
        const again = compile(material).uniforms.mg_tint_value;
        expect(again).toBe(first);
        expect((again.value as THREE.Color).b).toBeCloseTo(1);
    });

    it('hands every program the material builds the uniforms of stages it no longer has', () => {
        // three reuses the uniforms of the last program it built when the material goes back to an older one.
        const material = new THREE.MeshStandardMaterial();
        bindMaterialGraph(material, tinted());
        const tint = compile(material).uniforms.mg_tint_value;
        unbindMaterialGraph(material);
        expect(compile(material).uniforms.mg_tint_value).toBe(tint);
        // The same for the wind's, whether or not the material sways when a program is built.
        patchWeatherMaterial(material);
        expect(compile(material).uniforms.uWindStrength).toBeDefined();
    });

    it('gives a renderer of another kind the graph\'s uniform objects by running the hook with no renderer', () => {
        const material = new THREE.MeshStandardMaterial();
        rebuildNormalZ(material);
        patchWeatherMaterial(material);
        bindMaterialGraph(material, tinted());
        const shader = physicalShader();
        expect(() => material.onBeforeCompile(shader, null as unknown as THREE.WebGLRenderer)).not.toThrow();
        expect(shader.uniforms.mg_tint_value).toBe(compile(material).uniforms.mg_tint_value);
    });
});

describe('vertex colours under a graph', () => {
    it('are multiplied in by three only when the graph does not read them itself', () => {
        const reads = new THREE.MeshStandardMaterial({ vertexColors: true });
        bindMaterialGraph(reads, normalizeMaterialGraph({
            nodes: [node('out', OUTPUT_NODE_TYPE), node('vc', 'vertexColor')],
            links: [link('vc', 'out', 'out', 'baseColor')],
        }));
        expect(compile(reads).fragmentShader).not.toContain('#include <color_fragment>');
        const ignores = new THREE.MeshStandardMaterial({ vertexColors: true });
        bindMaterialGraph(ignores, tinted());
        expect(compile(ignores).fragmentShader).toContain('#include <color_fragment>');
    });
});

describe('edits to a material asset', () => {
    afterEach(() => materialLibrary.replaceAll([]));

    it('leave its materials alone when only nodes move, and update values without a rebuild', () => {
        const graph = tinted([1, 0, 0]);
        materialLibrary.replaceAll([{ id: 'paint', name: 'Paint', graph }]);
        const material = new THREE.MeshStandardMaterial();
        materialLibrary.assign(material, 'paint');
        compile(material);
        const bound = boundMaterialGraph(material);
        const version = material.version;

        materialLibrary.upsert({ id: 'paint', name: 'Paint', graph: { ...graph, nodes: graph.nodes.map(n => ({ ...n, x: n.x + 40 })) } });
        expect(boundMaterialGraph(material)).toBe(bound);
        expect(material.version).toBe(version);

        materialLibrary.upsert({ id: 'paint', name: 'Paint', graph: { ...graph, nodes: graph.nodes.map(n => (n.id === 'tint' ? { ...n, params: { value: [0, 1, 0] } } : n)) } });
        expect(material.version).toBe(version);
        expect((compile(material).uniforms.mg_tint_value.value as THREE.Color).g).toBeCloseTo(1);
        materialLibrary.assign(material, null);
    });
});
