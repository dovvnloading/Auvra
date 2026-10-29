import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SurfaceBuffer, drawsSurface, surfaceOf, surfaceTwin } from '../../runtime/gbuffer';
import { SCREEN_LIGHTING_DEFAULTS, ScreenLightingEffect, gatherAmbient } from '../../runtime/screenLighting';

/*
 * Bounced light and reflections, CPU side: which surfaces the surface buffer draws and with what, that
 * drawing it leaves the scene and the renderer as they were, the ambient light the trace compares against,
 * and the passes the effect runs. The shaders run in the engine.
 */

/** A renderer that draws nothing and records what each mesh wore when the scene was drawn. */
const fakeRenderer = () => {
  const drawn: Array<{ target: unknown; materials: Map<string, unknown>; visible: Map<string, boolean> }> = [];
  let target: unknown = 'screen';
  const clear = new THREE.Color(0.2, 0.3, 0.4);
  let clearAlpha = 1;
  const renderer = {
    autoClear: true,
    shadowMap: { autoUpdate: true },
    getRenderTarget: () => target,
    setRenderTarget: (next: unknown) => { target = next; },
    getClearColor: (into: THREE.Color) => into.copy(clear),
    getClearAlpha: () => clearAlpha,
    setClearColor: (color: THREE.ColorRepresentation, alpha = 1) => { clear.set(color); clearAlpha = alpha; },
    clear: () => undefined,
    render: (scene: THREE.Object3D) => {
      const materials = new Map<string, unknown>();
      const visible = new Map<string, boolean>();
      scene.traverse(object => {
        visible.set(object.name, object.visible);
        if ((object as THREE.Mesh).isMesh) materials.set(object.name, (object as THREE.Mesh).material);
      });
      drawn.push({ target, materials, visible });
    },
  };
  return { renderer: renderer as unknown as THREE.WebGLRenderer, drawn, state: () => ({ target, clear: clear.getHex(), clearAlpha }), raw: renderer };
};

const named = <T extends THREE.Object3D>(object: T, name: string): T => {
  object.name = name;
  return object;
};

describe('surface buffer', () => {
  it('draws lit, opaque surfaces only', () => {
    expect(drawsSurface(new THREE.MeshStandardMaterial())).toBe(true);
    expect(drawsSurface(new THREE.MeshPhongMaterial())).toBe(true);
    expect(drawsSurface(new THREE.MeshLambertMaterial())).toBe(true);
    expect(drawsSurface(new THREE.MeshBasicMaterial())).toBe(false);
    expect(drawsSurface(new THREE.ShaderMaterial())).toBe(false);
    expect(drawsSurface(new THREE.MeshStandardMaterial({ transparent: true }))).toBe(false);
    expect(drawsSurface(new THREE.MeshStandardMaterial({ depthWrite: false }))).toBe(false);
    // Alpha-tested foliage is opaque where it draws.
    expect(drawsSurface(new THREE.MeshStandardMaterial({ alphaTest: 0.5 }))).toBe(true);
  });

  it('reads roughness and metalness from each kind of lit material', () => {
    expect(surfaceOf(new THREE.MeshStandardMaterial({ roughness: 0.2, metalness: 1 }))).toEqual({ roughness: 0.2, metalness: 1 });
    expect(surfaceOf(new THREE.MeshLambertMaterial())).toEqual({ roughness: 1, metalness: 0 });
    // Shinier Phong is smoother.
    const dull = surfaceOf(new THREE.MeshPhongMaterial({ shininess: 2 })).roughness;
    const shiny = surfaceOf(new THREE.MeshPhongMaterial({ shininess: 200 })).roughness;
    expect(shiny).toBeLessThan(dull);
    expect(shiny).toBeGreaterThan(0);
  });

  it('keeps one twin per material, following its values and rebuilding when its maps change', () => {
    const material = new THREE.MeshStandardMaterial({ color: 0xff0000, roughness: 0.3, metalness: 0.5, side: THREE.DoubleSide });
    const twin = surfaceTwin(material);
    expect(twin.uniforms.roughness.value).toBe(0.3);
    expect(twin.uniforms.metalness.value).toBe(0.5);
    expect((twin.uniforms.diffuse.value as THREE.Color).getHex()).toBe(0xff0000);
    expect(twin.side).toBe(THREE.DoubleSide);
    expect(twin.defines.SURFACE_MAP).toBeUndefined();

    material.roughness = 0.8;
    expect(surfaceTwin(material)).toBe(twin);
    expect(twin.uniforms.roughness.value).toBe(0.8);

    // A colour map needs another program; its transform is followed.
    material.map = new THREE.Texture();
    material.map.repeat.set(2, 3);
    const mapped = surfaceTwin(material);
    expect(mapped).not.toBe(twin);
    expect(mapped.defines.SURFACE_MAP).toBe('');
    expect(mapped.uniforms.map.value).toBe(material.map);
    expect((mapped.uniforms.mapTransform.value as THREE.Matrix3).elements[0]).toBe(2);
    expect((mapped.uniforms.mapTransform.value as THREE.Matrix3).elements[4]).toBe(3);
  });

  it('draws the scene with twins into its own targets and puts everything back', () => {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x123456);
    const lit = named(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()), 'lit');
    const sky = named(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.ShaderMaterial()), 'sky');
    const water = named(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial()), 'water');
    const onWater = named(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()), 'boat');
    water.add(onWater);
    const mixed = named(new THREE.Mesh(new THREE.BoxGeometry(), [new THREE.MeshStandardMaterial(), new THREE.MeshBasicMaterial()]), 'mixed');
    const line = named(new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial()), 'line');
    scene.add(lit, sky, water, mixed, line);
    const before = new Map(scene.children.map(child => [child.name, (child as THREE.Mesh).material]));

    const buffer = new SurfaceBuffer(4, 4);
    const { renderer, drawn, state, raw } = fakeRenderer();
    const camera = new THREE.PerspectiveCamera();
    buffer.render(renderer, scene, camera);

    expect(drawn).toHaveLength(1);
    const frame = drawn[0];
    expect(frame.target).toBe(buffer.target);
    expect((frame.materials.get('lit') as THREE.ShaderMaterial).isShaderMaterial).toBe(true);
    expect(frame.materials.get('lit')).toBe(surfaceTwin(lit.material as THREE.MeshStandardMaterial));
    // The sky and the line are hidden; water draws nothing but still carries the boat on it.
    expect(frame.visible.get('sky')).toBe(false);
    expect(frame.visible.get('line')).toBe(false);
    expect(frame.visible.get('water')).toBe(true);
    expect((frame.materials.get('water') as THREE.Material).colorWrite).toBe(false);
    expect((frame.materials.get('boat') as THREE.ShaderMaterial).isShaderMaterial).toBe(true);
    const slots = frame.materials.get('mixed') as THREE.Material[];
    expect((slots[0] as THREE.ShaderMaterial).isShaderMaterial).toBe(true);
    expect(slots[1].colorWrite).toBe(false);

    // Afterwards the scene and the renderer are as they were.
    for (const child of scene.children) {
      expect(child.visible).toBe(true);
      expect((child as THREE.Mesh).material).toBe(before.get(child.name));
    }
    expect((scene.background as THREE.Color).getHex()).toBe(0x123456);
    expect(state()).toEqual({ target: 'screen', clear: new THREE.Color(0.2, 0.3, 0.4).getHex(), clearAlpha: 1 });
    expect(raw.autoClear).toBe(true);
    expect(raw.shadowMap.autoUpdate).toBe(true);
    expect(buffer.normalRoughness).toBe(buffer.target.textures[0]);
    expect(buffer.albedoMetalness).toBe(buffer.target.textures[1]);
    buffer.dispose();
  });
});

describe('ambient light', () => {
  it('sums ambient lights and takes the hemisphere light as three lights with it', () => {
    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 0.5), new THREE.AmbientLight(0xff0000, 0.5));
    const hemisphere = new THREE.HemisphereLight(0x8080ff, 0x204010, 2);
    hemisphere.position.set(0, 5, 0);
    scene.add(hemisphere);
    const hidden = new THREE.AmbientLight(0xffffff, 10);
    hidden.visible = false;
    scene.add(hidden);
    const into = {
      ambientLight: { value: new THREE.Color() }, hemiSky: { value: new THREE.Color() },
      hemiGround: { value: new THREE.Color() }, hemiUp: { value: new THREE.Vector3() },
    };
    scene.updateMatrixWorld();
    gatherAmbient(scene, into);
    expect(into.ambientLight.value.toArray()).toEqual([1, 0.5, 0.5]);
    expect(into.hemiSky.value.r).toBeCloseTo(new THREE.Color(0x8080ff).r * 2);
    expect(into.hemiGround.value.g).toBeCloseTo(new THREE.Color(0x204010).g * 2);
    expect(into.hemiUp.value.toArray()).toEqual([0, 1, 0]);

    // Without lights: none, and up stays up.
    gatherAmbient(new THREE.Scene(), into);
    expect(into.ambientLight.value.toArray()).toEqual([0, 0, 0]);
    expect(into.hemiUp.value.toArray()).toEqual([0, 1, 0]);
  });
});

describe('screen lighting effect', () => {
  const effectFor = (camera: THREE.Camera, options = {}) => {
    const scene = new THREE.Scene();
    scene.add(named(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()), 'box'));
    return new ScreenLightingEffect(scene, camera, options);
  };

  it('starts from its defaults and takes new settings in place', () => {
    const effect = effectFor(new THREE.PerspectiveCamera());
    expect(effect.settings).toEqual(SCREEN_LIGHTING_DEFAULTS);
    effect.set({ bounce: 2, reflections: 0 });
    expect(effect.settings).toMatchObject({ bounce: 2, reflections: 0, bounceRadius: SCREEN_LIGHTING_DEFAULTS.bounceRadius });
    effect.view = 'reflections';
    expect(effect.uniforms.get('showOnly')!.value).toBe(2);
    effect.view = 'final';
    expect(effect.uniforms.get('showOnly')!.value).toBe(0);
    effect.dispose();
  });

  it('works only through a perspective camera, and only when one of its parts is on', () => {
    const { renderer, drawn } = fakeRenderer();
    const input = new THREE.WebGLRenderTarget(4, 4);
    const flat = effectFor(new THREE.OrthographicCamera());
    flat.update(renderer, input);
    expect(flat.uniforms.get('active')!.value).toBe(0);
    expect(drawn).toHaveLength(0);

    const off = effectFor(new THREE.PerspectiveCamera(), { bounce: 0, reflections: 0 });
    off.update(renderer, input);
    expect(off.uniforms.get('active')!.value).toBe(0);
    expect(drawn).toHaveLength(0);
    for (const effect of [flat, off]) effect.dispose();
    input.dispose();
  });

  it('draws the surfaces, then traces, eases and smooths the bounce and traces and softens reflections', () => {
    const { renderer, drawn, state } = fakeRenderer();
    const input = new THREE.WebGLRenderTarget(4, 4);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
    const effect = effectFor(camera);
    effect.setSize(8, 8);
    effect.update(renderer, input);
    expect(effect.uniforms.get('active')!.value).toBe(1);
    // Surfaces, bounce trace, ease, two smoothing steps, reflection trace, softening.
    expect(drawn).toHaveLength(7);
    expect(state().target).toBe('screen');
    expect(effect.uniforms.get('surfaceDepth')!.value).toBe(effect.surface.depth);
    expect((effect.uniforms.get('traceTexel')!.value as THREE.Vector2).toArray()).toEqual([0.25, 0.25]);

    // Reflections alone skip the bounce passes.
    effect.set({ bounce: 0 });
    drawn.length = 0;
    effect.update(renderer, input);
    expect(drawn).toHaveLength(3);
    effect.dispose();
    input.dispose();
  });
});
