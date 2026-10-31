import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { LevelObject } from '../../types';
import { BAKED_LIGHTING_UNIFORMS } from '../../runtime/lighting/bakedLighting';
import {
    DYNAMIC_GI_COMPONENT_TYPE,
    dynamicGiSettingsOf,
    gatheringRunner,
    tracedMeshFilter,
} from '../../runtime/lighting/dynamicGi/LevelDynamicGi';
import {
    DYNAMIC_GI_UNIFORMS,
    GI_SAMPLE_GLSL,
    applySceneGi,
    giAtlas,
    holdGiAtlas,
    pauseSceneGi,
    sceneReadsGi,
    setSceneGi,
} from '../../runtime/lighting/dynamicGi/giMaterials';
import { IRRADIANCE_FRAGMENT, OFFSET_FRAGMENT, TRACE_FRAGMENT, VISIBILITY_FRAGMENT } from '../../runtime/lighting/dynamicGi/giShaders';
import { GRID_LIFT, PROBES_X, PROBES_Y, PROBES_Z } from '../../runtime/lighting/dynamicGi/probeGrid';

const object = (id: string, type: LevelObject['type'], components: LevelObject['components'] = []): LevelObject => ({
    id, levelId: 'level', modelId: '', name: id, type, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], parentId: null, components,
} as unknown as LevelObject);

const owned = (id: string | undefined, parentData: Record<string, unknown> = {}): THREE.Mesh => {
    const parent = new THREE.Group();
    parent.userData = { ...(id ? { levelObjectId: id } : {}), ...parentData };
    const mesh = new THREE.Mesh();
    parent.add(mesh);
    return mesh;
};

describe('whether a level has it', () => {
    it('has none without the component', () => {
        expect(dynamicGiSettingsOf([object('a', 'prop')])).toBeNull();
    });

    it('takes the first enabled component, wherever it is', () => {
        const levelObjects = [
            object('off', 'prop', [{ id: '1', type: DYNAMIC_GI_COMPONENT_TYPE, enabled: false, props: { quality: 'high' } }]),
            object('on', 'sky_sphere', [{ id: '2', type: DYNAMIC_GI_COMPONENT_TYPE, enabled: true, props: { quality: 'low' } }]),
        ];
        expect(dynamicGiSettingsOf(levelObjects)?.quality).toBe('low');
    });
});

describe('what rays see of a level', () => {
    const levelObjects = [object('crate', 'prop'), object('ground', 'terrain'), object('tree', 'foliage'), object('spawn', 'spawn_point'), object('sound', 'audio_emitter')];
    const include = tracedMeshFilter(levelObjects);

    it('sees props, foliage and terrain', () => {
        expect(include(owned('crate'))).toBe(true);
        expect(include(owned('tree'))).toBe(true);
    });

    it('does not see the markers of what has no body', () => {
        expect(include(owned('spawn'))).toBe(false);
        expect(include(owned('sound'))).toBe(false);
    });

    it('does not see what belongs to no level object: gizmos, grids and the like', () => {
        expect(include(owned(undefined))).toBe(false);
    });

    it('sees an instanced layer, which is marked rather than owned', () => {
        expect(include(owned(undefined, { staticLighting: true }))).toBe(true);
    });

    it('sees a terrain\'s whole mesh and not the pieces that change with distance', () => {
        const terrain = new THREE.Group();
        terrain.userData = { levelObjectId: 'ground', isTerrain: true };
        const whole = new THREE.Mesh();
        whole.userData = { levelObjectId: 'ground', isTerrain: true };
        const piece = new THREE.Mesh();
        const pieces = new THREE.Group();
        pieces.add(piece);
        terrain.add(whole, pieces);
        expect(include(whole)).toBe(true);
        expect(include(piece)).toBe(false);
    });

    it('sees characters, whoever owns them', () => {
        expect(include(new THREE.SkinnedMesh())).toBe(true);
    });
});

describe('which view gathers', () => {
    it('is the first that stands in the level, however many there are', () => {
        const left = { camera: new THREE.OrthographicCamera() };
        const main = { camera: new THREE.PerspectiveCamera() };
        const other = { camera: new THREE.PerspectiveCamera() };
        expect(gatheringRunner([left, main, other])).toBe(main);
    });

    it('is the first, when all of them look from outside it', () => {
        const left = { camera: new THREE.OrthographicCamera() };
        const top = { camera: new THREE.OrthographicCamera() };
        expect(gatheringRunner([left, top])).toBe(left);
    });

    it('is nothing with no views', () => {
        expect(gatheringRunner([])).toBeUndefined();
    });
});

describe('which scenes read it', () => {
    const on = () => (DYNAMIC_GI_UNIFORMS.auvraGiParams.value as THREE.Vector4).y;

    it('reads it while given it, and not after', () => {
        const scene = new THREE.Scene();
        const stop = setSceneGi(scene, { intensity: 2, indirectOnly: false });
        applySceneGi(scene);
        expect(on()).toBe(1);
        expect((DYNAMIC_GI_UNIFORMS.auvraGiParams.value as THREE.Vector4).x).toBe(2);
        expect(sceneReadsGi(scene)).toBe(true);
        stop();
        applySceneGi(scene);
        expect(on()).toBe(0);
        expect(sceneReadsGi(scene)).toBe(false);
    });

    it('leaves other scenes as they are, so a capture or a preview draws without it', () => {
        const level = new THREE.Scene();
        const other = new THREE.Scene();
        const stop = setSceneGi(level, { intensity: 1, indirectOnly: false });
        applySceneGi(other);
        expect(on()).toBe(0);
        applySceneGi(level);
        expect(on()).toBe(1);
        stop();
    });

    it('does not read it during a bake, which must see only what it bakes', () => {
        const scene = new THREE.Scene();
        const stop = setSceneGi(scene, { intensity: 1, indirectOnly: false });
        const resume = pauseSceneGi(scene);
        applySceneGi(scene);
        expect(on()).toBe(0);
        resume();
        applySceneGi(scene);
        expect(on()).toBe(1);
        stop();
    });

    it('goes to every lit material through the renderer\'s own copying of uniforms', () => {
        for (const name of ['standard', 'physical', 'lambert', 'phong', 'toon'] as const) {
            const copy = THREE.UniformsUtils.clone(THREE.ShaderLib[name].uniforms);
            expect((copy.auvraGiAtlas.value as THREE.Texture[])[0]).toBe(DYNAMIC_GI_UNIFORMS.auvraGiAtlas.value[0]);
            expect(copy.auvraGiParams.value).toBe(DYNAMIC_GI_UNIFORMS.auvraGiParams.value);
            expect((copy.auvraGiGrid.value as THREE.Vector4[])[2]).toBe(DYNAMIC_GI_UNIFORMS.auvraGiGrid.value[2]);
        }
    });

    it('leaves the baked volume one texture, for the texture units every lit material has to share', () => {
        expect(Object.keys(BAKED_LIGHTING_UNIFORMS).filter(key => key.startsWith('bakedGiSh'))).toEqual(['bakedGiSh']);
    });

    it('compiles the volume only into scenes that read it: it more than doubles how long a lit shader takes', () => {
        expect(THREE.ShaderChunk.lights_pars_begin).toContain('defined( USE_LIGHT_PROBES )');
        const beforeMaps = THREE.ShaderChunk.lights_fragment_maps;
        const uses = beforeMaps.split('auvraGiParams').length - 1;
        // Every reading of it sits behind the define: a shader without it does not declare it.
        const guarded = beforeMaps.split('#ifdef AUVRA_DYNAMIC_GI').length + beforeMaps.split('defined( AUVRA_DYNAMIC_GI )').length - 2;
        expect(uses).toBeGreaterThan(0);
        expect(guarded).toBeGreaterThanOrEqual(3);
        expect(beforeMaps).not.toMatch(/#else\s+if \( auvraGiParams/);
    });

    it('patches every lit material\'s shader once', () => {
        const count = (text: string, part: string) => text.split(part).length - 1;
        expect(count(THREE.ShaderChunk.lights_pars_begin, 'auvraGiIrradiance( vec3 point')).toBe(1);
        expect(count(THREE.ShaderChunk.lights_fragment_maps, 'auvraGiIrradiance(')).toBe(1);
    });
});

describe('the atlas, shared by every renderer', () => {
    it('is not freed while a new canvas has taken over from an old one', () => {
        let freed = 0;
        const listener = () => { freed++; };
        giAtlas.addEventListener('dispose', listener);
        const oldCanvas = holdGiAtlas();
        const newCanvas = holdGiAtlas();
        oldCanvas();
        expect(freed).toBe(0);
        // Letting go twice counts once.
        oldCanvas();
        expect(freed).toBe(0);
        newCanvas();
        expect(freed).toBe(1);
        giAtlas.removeEventListener('dispose', listener);
    });
});

describe('the shaders agree with the grid', () => {
    it('wraps by the same sizes', () => {
        expect(GI_SAMPLE_GLSL).toContain(`ivec3( ${PROBES_X - 1}, ${PROBES_Y - 1}, ${PROBES_Z - 1} )`);
    });

    it('takes the layers\' lift off before finding a probe\'s index', () => {
        expect(GI_SAMPLE_GLSL).toContain(`vec3( 0.0, ${GRID_LIFT}, 0.0 )`);
    });

    it('every pass that reads a ray\'s direction turns it the way its probe did', () => {
        for (const shader of [TRACE_FRAGMENT, IRRADIANCE_FRAGMENT, VISIBILITY_FRAGMENT, OFFSET_FRAGMENT]) {
            expect(shader).toContain('giTurn(');
        }
    });
});
