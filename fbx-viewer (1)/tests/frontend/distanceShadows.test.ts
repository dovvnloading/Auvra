import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { cascadeCount } from '../../runtime/lighting/DistanceShadowLights';
import { cascadedLightsChunk, cascadeSplits, farShadowReach, fitCascade, lookDistance, NEAR_SHADOW_REACH, nearShadowReach, viewSliceSphere } from '../../runtime/lighting/distanceShadows';
// The chunk as three.js ships it (the live one is replaced once the cascade lights' module loads).
// @ts-expect-error three.js ships its chunk sources without typings.
import plainLightsChunk from 'three/src/renderers/shaders/ShaderChunk/lights_fragment_begin.glsl.js';

/*
 * Distance shadows: the lighting chunk every lit material shares (cascades found by their colour and
 * direction), where the cascades' slices end, the sphere each is fitted to, and how a cascade's map is
 * placed so its shadows hold still.
 */

/** three.js's own unrolling of `#pragma unroll_loop` loops, once the light counts are written in. */
const unroll = (source: string) => source.replace(
  /#pragma unroll_loop_start\s+for\s*\(\s*int\s+i\s*=\s*(\d+)\s*;\s*i\s*<\s*(\d+)\s*;\s*i\s*\+\+\s*\)\s*{([\s\S]+?)}\s+#pragma unroll_loop_end/g,
  (_match, start: string, end: string, snippet: string) => {
    let out = '';
    for (let i = Number(start); i < Number(end); i++) out += snippet.replace(/\[\s*i\s*\]/g, `[ ${i} ]`).replace(/UNROLLED_LOOP_INDEX/g, String(i));
    return out;
  },
);

describe('distance-shadow lighting chunk', () => {
  it("lays the cascade search before the directional lights and hands each lit light's shadow over at its map's edge", () => {
    const chunk = cascadedLightsChunk(plainLightsChunk)!;
    expect(chunk).not.toBeNull();
    expect(chunk).toContain('shadowCascadeFound');
    expect(chunk).toContain('smoothstep( 0.0, 0.040, shadowCascadeEdge )');
    // Point, spot and area lights are untouched.
    expect(chunk).toContain('getPointShadow');
    expect(chunk).toContain('RE_Direct_RectArea');
    // Unrolled for three shadow-casting directional lights, as three.js unrolls it: every loop opened is gone, every index constant.
    const unrolled = unroll(chunk.replace(/NUM_DIR_LIGHT_SHADOWS/g, '3').replace(/NUM_DIR_LIGHTS/g, '5').replace(/NUM_[A-Z_]+/g, '0'));
    expect(unrolled).not.toContain('unroll_loop');
    expect(unrolled).not.toMatch(/\[\s*i\s*\]/);
    expect(unrolled).toContain('directionalShadowMap[ 2 ]');
    // Each cascade is looked for once, and each of the five directional lights shades once.
    expect(unrolled.match(/shadowCascadeFound = true;/g)).toHaveLength(3);
    expect(unrolled.match(/RE_Direct\( directLight/g)?.length).toBeGreaterThanOrEqual(5);
    // One sample per shadow map in the search, one per directional light (the compiler drops those past the third).
    expect(unrolled.match(/getShadow\( directionalShadowMap/g)).toHaveLength(3 + 5);
  });

  it('eases one cascade into the next, fades out the last, and spends no lighting on dark lights', () => {
    const chunk = cascadedLightsChunk(plainLightsChunk)!;
    expect(chunk).toContain('mix( shadowCascadeSample, shadowCascade, smoothstep( 0.0, 0.040, shadowCascadeFirstEdge ) )');
    expect(chunk).toContain('mix( 1.0, shadowCascade, smoothstep( 0.0, 0.040, shadowCascadeFirstEdge ) )');
    expect(chunk).toContain('if ( dot( directLight.color, directLight.color ) > 0.0 ) RE_Direct( directLight,');
    // What does not take shadows reads no cascade.
    expect(chunk).toContain('receiveShadow && shadowCascadeEdge > 0.002');
  });

  it('leaves a chunk it was not written against alone, and is what lit materials now compile with', () => {
    expect(cascadedLightsChunk('void main() {}')).toBeNull();
    expect(THREE.ShaderChunk.lights_fragment_begin).toContain('shadowCascadeFound');
  });
});

describe('cascades', () => {
  it('are as many for any distance, so changing it recompiles nothing, and none when it is off', () => {
    expect([0, -5, 80, 250, 1000].map(cascadeCount)).toEqual([0, 0, 2, 2, 2]);
  });

  it('start where the near map stops and reach the distance past it, moving out only as an orbit pulls back', () => {
    expect(nearShadowReach(0)).toBe(NEAR_SHADOW_REACH);
    expect(nearShadowReach(10)).toBe(NEAR_SHADOW_REACH);
    expect(farShadowReach(250, 10)).toBe(250);
    // Pulled back, the near map still reaches what is looked at, and the rest goes along with it.
    expect(nearShadowReach(200)).toBeGreaterThanOrEqual(240);
    expect(farShadowReach(250, 200)).toBe(250 + nearShadowReach(200) - NEAR_SHADOW_REACH);
    // In steps: a small zoom does not re-fit the map.
    expect(nearShadowReach(200)).toBe(nearShadowReach(201));
    expect(nearShadowReach(400)).toBeGreaterThan(nearShadowReach(200));
  });

  it('count a look from what the camera orbits, none without an orbit, and hold it while the orbit is off', () => {
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 30, 40);
    camera.updateMatrixWorld();
    const orbit = { target: new THREE.Vector3(), enabled: true };
    expect(lookDistance(camera, orbit, 0)).toBeCloseTo(50, 6);
    expect(lookDistance(camera, null, 12)).toBe(0);
    orbit.enabled = false;
    expect(lookDistance(camera, orbit, 12)).toBe(12);
  });

  it('split the view from the near map out to the distance, tighter near', () => {
    const splits = cascadeSplits(25, 250, 3);
    expect(splits).toHaveLength(3);
    expect(splits[2]).toBeCloseTo(250, 6);
    expect(splits[0]).toBeGreaterThan(25);
    expect(splits[1] - splits[0]).toBeLessThan(splits[2] - splits[1]);
  });

  it("are fitted to a sphere round their slice of the view that does not change as the camera turns", () => {
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
    camera.position.set(3, 2, 1);
    camera.updateMatrixWorld();
    const centre = new THREE.Vector3();
    const radius = viewSliceSphere(camera, 100, centre);
    // Every corner of the slice is inside.
    const corners: THREE.Vector3[] = [];
    for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const near = new THREE.Vector3(x, y, -1).unproject(camera);
      const far = new THREE.Vector3(x, y, 1).unproject(camera);
      const along = new THREE.Vector3(x, y, -1).applyMatrix4(camera.projectionMatrixInverse);
      const farView = new THREE.Vector3(x, y, 1).applyMatrix4(camera.projectionMatrixInverse);
      corners.push(near, near.clone().lerp(far, (100 - -along.z) / (-farView.z - -along.z)));
    }
    corners.forEach(corner => expect(corner.distanceTo(centre)).toBeLessThanOrEqual(radius + 1e-6));
    camera.rotation.set(0.4, 1.2, 0);
    camera.updateMatrixWorld();
    expect(viewSliceSphere(camera, 100, new THREE.Vector3())).toBe(radius);
  });

  it('face the sun and move their map only in whole texels', () => {
    const light = new THREE.DirectionalLight(0x000000, 0);
    light.shadow.mapSize.set(1024, 1024);
    const towardSun = new THREE.Vector3(1, 2, 0.5).normalize();
    fitCascade(light, new THREE.Vector3(10, 0, 10), 64, towardSun);
    const direction = light.position.clone().sub(light.target.position).normalize();
    expect(direction.dot(towardSun)).toBeCloseTo(1, 6);
    expect(light.shadow.camera.right).toBe(64);
    expect(light.shadow.normalBias).toBeCloseTo((128 / 1024) * 1.5, 6);
    // The depth bias is two texels in world units, whatever the map's depth range.
    expect(-light.shadow.bias * (light.shadow.camera.far - light.shadow.camera.near)).toBeCloseTo((128 / 1024) * 2, 6);
    // Where the map sits across the light (moving along the light changes nothing it draws).
    const across = (point: THREE.Vector3) => point.clone().sub(towardSun.clone().multiplyScalar(point.dot(towardSun)));
    const placed = across(light.target.position);
    // A nudge of less than half a texel leaves the map where it was; a larger move shifts it by whole texels.
    fitCascade(light, new THREE.Vector3(10.03, 0, 10), 64, towardSun);
    expect(across(light.target.position).distanceTo(placed)).toBeLessThan(1e-6);
    fitCascade(light, new THREE.Vector3(14, 0, 10), 64, towardSun);
    const moved = across(light.target.position).distanceTo(placed) / (128 / 1024);
    expect(moved).toBeGreaterThan(1);
  });

  it('stand back far enough for a sphere of any size', () => {
    const light = new THREE.DirectionalLight(0x000000, 0);
    light.shadow.mapSize.set(1024, 1024);
    const towardSun = new THREE.Vector3(0, 1, 0);
    fitCascade(light, new THREE.Vector3(), 1500, towardSun);
    expect(light.position.distanceTo(light.target.position)).toBeGreaterThanOrEqual(1500);
    expect(light.shadow.camera.far).toBeGreaterThanOrEqual(light.position.distanceTo(light.target.position) + 1500);
  });
});
