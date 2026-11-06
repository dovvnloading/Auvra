import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { OUTPUT_NODE_TYPE, defaultParams, materialGraphFeatures, normalizeMaterialGraph, type MaterialGraph } from '../../runtime/materials/materialGraph';
import { GraphMaterial, bindMaterialGraph, unbindMaterialGraph } from '../../runtime/materials/graphMaterial';
import { isGraphUpgraded } from '../../runtime/materials/physicalSurface';
import { shaderStageNames } from '../../runtime/materials/shaderStages';
import { patchWeatherMaterial, setSurfaceWeather } from '../../runtime/weatherSurfaces';
import { rebuildNormalZ } from '../../utils/textureCompression/compressTextures';
import { MATERIAL_UNLIT, rayMaterialFor, raysSeeMaterial } from '../../runtime/raytracing/rayScene';

const node = (id: string, type: string, params: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, params: { ...defaultParams(type), ...params } });
const link = (fromNode: string, fromOutput: string, toNode: string, toInput: string) => ({ fromNode, fromOutput, toNode, toInput });

/** A Material Output set to `params`, with `wired` numbers fed into its inputs. */
const surface = (params: Record<string, unknown> = {}, wired: Record<string, number> = {}): MaterialGraph => normalizeMaterialGraph({
    nodes: [
        node('out', OUTPUT_NODE_TYPE, params),
        ...Object.entries(wired).map(([input, value]) => node(`n_${input}`, 'float', { value })),
    ],
    links: Object.keys(wired).map(input => link(`n_${input}`, 'out', 'out', input)),
});

const compile = (material: THREE.Material) => {
    const shader = {
        uniforms: {} as Record<string, THREE.IUniform>,
        vertexShader: THREE.ShaderLib.physical.vertexShader,
        fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    return shader;
};

afterEach(() => setSurfaceWeather(0, 0, null));

describe('the parts of the physical surface a graph uses', () => {
    it('are those wired, or set away from their default', () => {
        expect(materialGraphFeatures(surface())).toEqual([]);
        expect(materialGraphFeatures(surface({ coat: 1 }))).toEqual(['coat']);
        expect(materialGraphFeatures(surface({ ior: 1.33 }))).toEqual(['specular']);
        expect(materialGraphFeatures(surface({}, { transmission: 1 }))).toEqual(['transmission']);
        expect(materialGraphFeatures(surface({ sheenColor: [0.5, 0.2, 0.3], thinFilm: 0.5, anisotropy: 0.4 }))).toEqual(['anisotropy', 'sheen', 'thinFilm']);
    });

    it('need their switching value: a coat roughness alone makes no coat, nor dispersion without transmission', () => {
        expect(materialGraphFeatures(surface({ coatRoughness: 0.5, thickness: 2 }))).toEqual([]);
        expect(materialGraphFeatures(surface({ dispersion: 1 }))).toEqual([]);
        expect(materialGraphFeatures(surface({ dispersion: 1, transmission: 1 }))).toEqual(['transmission', 'dispersion']);
    });
});

describe('the material a graph is drawn by', () => {
    it('stays the cheaper standard material while no physical part is used', () => {
        const material = new THREE.MeshStandardMaterial();
        bindMaterialGraph(material, surface({ roughness: 0.3, emissiveStrength: 4 }));
        expect((material as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial).toBeFalsy();
        expect(material.type).toBe('MeshStandardMaterial');
        expect(material.customProgramCacheKey()).toContain('standard');
    });

    it('becomes physical in place for a physical part, and standard again without one', () => {
        const material = new THREE.MeshStandardMaterial({ name: 'Hull' });
        const sameObject = material;
        bindMaterialGraph(material, surface({ coat: 1 }));
        const physical = material as unknown as THREE.MeshPhysicalMaterial;
        expect(physical).toBe(sameObject);
        expect(physical.isMeshPhysicalMaterial).toBe(true);
        expect(physical.type).toBe('MeshPhysicalMaterial');
        expect(physical.defines?.PHYSICAL).toBe('');
        expect(physical.clearcoat).toBe(1);
        expect(physical.sheen).toBe(0);
        expect(isGraphUpgraded(material)).toBe(true);
        expect(material.customProgramCacheKey()).toMatch(/#physical#coat/);

        bindMaterialGraph(material, surface());
        expect((material as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial).toBeFalsy();
        expect(material.type).toBe('MeshStandardMaterial');
        expect('clearcoat' in material).toBe(false);
        expect(material.defines?.PHYSICAL).toBeUndefined();
        bindMaterialGraph(material, surface({}, { transmission: 1 }));
        expect((material as unknown as THREE.MeshPhysicalMaterial).transmission).toBe(1);
        unbindMaterialGraph(material);
        expect(material.type).toBe('MeshStandardMaterial');
        expect(isGraphUpgraded(material)).toBe(false);
    });

    it('keeps an imported physical material physical, its own parts off while a graph shades it and back after', () => {
        const glass = new THREE.MeshPhysicalMaterial({ clearcoat: 1, transmission: 1, sheen: 0 });
        bindMaterialGraph(glass, surface());
        expect(glass.isMeshPhysicalMaterial).toBe(true);
        expect([glass.clearcoat, glass.transmission]).toEqual([0, 0]);
        expect(glass.customProgramCacheKey()).toMatch(/#physical#/);
        unbindMaterialGraph(glass);
        expect([glass.clearcoat, glass.transmission]).toEqual([1, 1]);
        expect(isGraphUpgraded(glass)).toBe(false);
    });

    it('keeps a graph material\'s own methods when it becomes physical', () => {
        const material = new GraphMaterial(surface({ sheenColor: [0.6, 0.3, 0.4] }));
        expect((material as unknown as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial).toBe(true);
        expect(material.getGraph().nodes[0].params.sheenColor).toEqual([0.6, 0.3, 0.4]);
        material.setGraph(surface());
        expect(material).toBeInstanceOf(GraphMaterial);
    });

    it('updates a physical value in place, and rebuilds only when a part switches on or off', () => {
        const material = new THREE.MeshStandardMaterial();
        bindMaterialGraph(material, surface({ coat: 0.5 }));
        const shader = compile(material);
        const version = material.version;
        bindMaterialGraph(material, surface({ coat: 0.8, coatRoughness: 0.2 }));
        expect(material.version).toBe(version);
        expect(shader.uniforms.mg_out_coat.value).toBeCloseTo(0.8);
        expect(shader.uniforms.mg_out_coatRoughness.value).toBeCloseTo(0.2);
        bindMaterialGraph(material, surface({ coat: 0.8, sheenColor: [1, 1, 1] }));
        expect(material.version).toBeGreaterThan(version);
    });
});

describe('the physical shader', () => {
    it('sets each part up again from the graph after three does, keeping the include the weather lies before', () => {
        const material = new THREE.MeshStandardMaterial();
        bindMaterialGraph(material, surface({ coat: 1, sheenColor: [0.4, 0.4, 0.4], thinFilm: 1, anisotropy: 0.5, ior: 1.33 }));
        const { fragmentShader } = compile(material);
        const setup = fragmentShader.indexOf('#include <lights_physical_fragment>');
        const graph = fragmentShader.indexOf("// The graph's physical surface.");
        expect(setup).toBeGreaterThan(0);
        expect(graph).toBeGreaterThan(setup);
        for (const line of [
            'material.ior = clamp(mg_out_ior, 1.0, 3.0);',
            'material.clearcoat = saturate(mg_out_coat);',
            'material.sheenColor = max(mg_out_sheenColor, vec3(0.0));',
            'material.iridescence = saturate(mg_out_thinFilm);',
            'material.iridescenceThickness = max(mg_out_thinFilmThickness, 0.0);',
            'float mgAnisotropyAngle = radians(mg_out_anisotropyRotation);',
        ]) expect(fragmentShader).toContain(line);
        expect(fragmentShader).toContain('totalEmissiveRadiance = mg_out_emissive * mg_out_emissiveStrength;');
    });

    it('reads transmission, thickness and absorption from the graph, and the coat\'s own normal when wired', () => {
        const material = new THREE.MeshStandardMaterial();
        bindMaterialGraph(material, normalizeMaterialGraph({
            nodes: [node('out', OUTPUT_NODE_TYPE, { transmission: 1, thickness: 0.2, coat: 1 }), node('bumps', 'normalMap')],
            links: [link('bumps', 'out', 'out', 'coatNormal')],
        }));
        const { fragmentShader } = compile(material);
        expect(fragmentShader).not.toContain('#include <transmission_fragment>');
        expect(fragmentShader).toContain('material.transmission = saturate(mg_out_transmission);');
        expect(fragmentShader).toContain('material.thickness = max(mg_out_thickness, 0.0);');
        expect(fragmentShader).toContain('material.attenuationColor = mg_out_attenuationColor;');
        expect(fragmentShader).toContain('mat3 mgCoatFrame = mgTangentFrame(');
        expect(fragmentShader).toContain('mat3 mgTangentFrame(vec3 position');
    });

    it('leaves the standard material\'s shader without physical parts', () => {
        const material = new THREE.MeshStandardMaterial();
        bindMaterialGraph(material, surface());
        const { fragmentShader } = compile(material);
        expect(fragmentShader).not.toContain("// The graph's physical surface.");
        expect(fragmentShader).toContain('#include <transmission_fragment>');
    });
});

describe('the composed shader stages on a physical material', () => {
    it('run the graph, a compressed normal map and the weather on it, the weather on its top layer', () => {
        const material = new THREE.MeshStandardMaterial({ name: 'Paint' });
        rebuildNormalZ(material);
        expect(patchWeatherMaterial(material)).toBe(true);
        bindMaterialGraph(material, surface({ coat: 1, transmission: 1 }));
        expect(shaderStageNames(material)).toEqual(['graph', 'normalRg', 'weather']);
        expect(material.customProgramCacheKey()).toMatch(/graph:.*\|normal-rg\|auvra-weather-1/);
        const { fragmentShader } = compile(material);
        const weather = fragmentShader.indexOf('float weatherSnowCover = 0.0;');
        const setup = fragmentShader.indexOf('#include <lights_physical_fragment>');
        const graph = fragmentShader.indexOf("// The graph's physical surface.");
        const onCoat = fragmentShader.indexOf('material.clearcoat *= 1.0 - weatherSnowCover;');
        // Weather on the colour before three's setup, the graph's parts after it, then the weather on the coat.
        expect(weather).toBeGreaterThan(0);
        expect(weather).toBeLessThan(setup);
        expect(graph).toBeGreaterThan(setup);
        expect(onCoat).toBeGreaterThan(graph);
        expect(onCoat).toBeLessThan(fragmentShader.indexOf('#include <lights_fragment_begin>'));
        // Snow covers the glass rather than frosting it.
        expect(fragmentShader).toContain('material.transmission = ( saturate(mg_out_transmission) ) * ( 1.0 - weatherSnowCover );');
        expect(fragmentShader).toContain('mapN.z = sqrt');
    });

    it('lay the weather on an imported physical material\'s own coat and glass too', () => {
        const glass = new THREE.MeshPhysicalMaterial({ transmission: 1, clearcoat: 1 });
        expect(patchWeatherMaterial(glass)).toBe(true);
        const { fragmentShader } = compile(glass);
        expect(fragmentShader).toContain('material.transmission = ( transmission ) * ( 1.0 - weatherSnowCover );');
        expect(fragmentShader).toContain('material.clearcoatRoughness = mix( material.clearcoatRoughness, min( material.clearcoatRoughness, 0.08 ), weatherWetCover );');
    });

    it('keep the weather when the material changes kind', () => {
        const material = new THREE.MeshStandardMaterial();
        patchWeatherMaterial(material);
        bindMaterialGraph(material, surface({ coat: 1 }));
        expect(compile(material).fragmentShader).toContain('weatherOpen()');
        bindMaterialGraph(material, surface());
        expect(shaderStageNames(material)).toEqual(['graph', 'weather']);
        expect(compile(material).fragmentShader).toContain('weatherOpen()');
    });
});

describe('bounced light off a physical graph', () => {
    const linear = (value: number) => new THREE.Color().setRGB(value, value, value, THREE.SRGBColorSpace).r;

    it('still takes the graph\'s base colour, and its glow at its strength', () => {
        const paint = new THREE.MeshStandardMaterial({ color: 0xff0000 });
        bindMaterialGraph(paint, surface({ baseColor: [0.5, 0.5, 0.5], coat: 1, emissive: [0, 0.5, 0], emissiveStrength: 4 }));
        expect(paint.type).toBe('MeshPhysicalMaterial');
        expect(raysSeeMaterial(paint)).toBe(true);
        const look = rayMaterialFor(paint, () => [1, 1, 1]);
        expect(look.albedo[0]).toBeCloseTo(linear(0.5));
        expect(look.flags & MATERIAL_UNLIT).toBe(0);
        expect(look.emissive[1]).toBeCloseTo(linear(0.5) * 4);
    });

    it('passes through a graph\'s glass, as through imported glass', () => {
        const glass = new THREE.MeshStandardMaterial();
        bindMaterialGraph(glass, surface({ transmission: 1 }));
        expect(raysSeeMaterial(glass)).toBe(false);
        bindMaterialGraph(glass, surface());
        expect(raysSeeMaterial(glass)).toBe(true);
    });
});
