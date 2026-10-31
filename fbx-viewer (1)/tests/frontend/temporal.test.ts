import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { allowedAntialias } from '../../runtime/components/postProcess';
import { installMipBias, setTextureMipBias } from '../../runtime/temporal/mipBias';
import {
    cameraStillnessFor, clampRenderScale, contrastFadeFor, halton, isCameraCut, jitterPhases, MAX_RENDER_SCALE, MIN_RENDER_SCALE, mipBiasFor, renderSizeOf, temporalJitter,
} from '../../runtime/temporal/temporalSettings';
import { OUTPUT_FRAGMENT, RESOLVE_FRAGMENT } from '../../runtime/temporal/temporalShaders';
import { drawsVelocity } from '../../runtime/temporal/velocityBuffer';
import { NORMAL_READ } from '../../utils/textureCompression/compressTextures';

/*
 * Temporal anti-aliasing: the rules behind it, and the shader text other code relies on. How it looks and
 * holds up in motion is checked in the Temporal Lab.
 */

describe('where the samples fall', () => {
    it('follows the low-discrepancy sequence', () => {
        expect([1, 2, 3, 4].map(i => halton(i, 2))).toEqual([0.5, 0.25, 0.75, 0.125]);
        expect(halton(1, 3)).toBeCloseTo(1 / 3);
        expect(halton(2, 3)).toBeCloseTo(2 / 3);
    });

    it('stays inside the pixel and averages out to its centre over a cycle', () => {
        for (const scale of [1, 0.75, 0.5]) {
            const phases = jitterPhases(scale);
            let x = 0;
            let y = 0;
            for (let frame = 0; frame < phases; frame++) {
                const jitter = temporalJitter(frame, scale, { x: 0, y: 0 });
                expect(Math.abs(jitter.x)).toBeLessThanOrEqual(0.5);
                expect(Math.abs(jitter.y)).toBeLessThanOrEqual(0.5);
                x += jitter.x;
                y += jitter.y;
            }
            expect(Math.abs(x / phases)).toBeLessThan(0.07);
            expect(Math.abs(y / phases)).toBeLessThan(0.07);
        }
    });

    it('repeats after one cycle, and takes more samples to cover a smaller picture', () => {
        expect(temporalJitter(0, 1, { x: 0, y: 0 })).toEqual(temporalJitter(jitterPhases(1), 1, { x: 0, y: 0 }));
        expect(jitterPhases(1)).toBe(8);
        expect(jitterPhases(0.75)).toBe(15);
        expect(jitterPhases(0.5)).toBe(32);
    });
});

describe('the size of the picture', () => {
    it('holds the scale to what can be rebuilt', () => {
        expect(clampRenderScale(0.1)).toBe(MIN_RENDER_SCALE);
        expect(clampRenderScale(3)).toBe(MAX_RENDER_SCALE);
        expect(clampRenderScale(Number.NaN)).toBe(MAX_RENDER_SCALE);
        expect(clampRenderScale(0.75)).toBe(0.75);
    });

    it('rounds to whole pixels and never reaches nothing', () => {
        expect(renderSizeOf(1920, 1080, 0.5)).toEqual({ width: 960, height: 540 });
        expect(renderSizeOf(1921, 1081, 0.75)).toEqual({ width: 1441, height: 811 });
        expect(renderSizeOf(1, 1, 0.5)).toEqual({ width: 1, height: 1 });
    });

    it('reads textures sharper the smaller the picture', () => {
        expect(mipBiasFor(1)).toBeCloseTo(-0.25);
        expect(mipBiasFor(0.5)).toBeCloseTo(-1.25);
        expect(mipBiasFor(0.5)).toBeLessThan(mipBiasFor(0.75));
    });

    it('lets remembered contrast halve over one cycle of jitter', () => {
        for (const scale of [1, 0.75, 0.5]) {
            expect(Math.pow(contrastFadeFor(scale), jitterPhases(scale))).toBeCloseTo(0.5);
        }
    });
});

describe('camera cuts', () => {
    it('tells a cut from fast movement', () => {
        expect(isCameraCut(0.2, 0.999)).toBe(false);
        expect(isCameraCut(3, 0.95)).toBe(false);
        expect(isCameraCut(30, 1)).toBe(true);
        expect(isCameraCut(0, 0.2)).toBe(true);
    });
});

describe('a camera holding still', () => {
    it('keeps a slow drift, and counts walking pace as moving', () => {
        expect(cameraStillnessFor(0)).toBe(1);
        expect(cameraStillnessFor(0.002)).toBe(1);
        expect(cameraStillnessFor(0.0175)).toBeCloseTo(0.5);
        expect(cameraStillnessFor(0.03)).toBe(0);
        expect(cameraStillnessFor(0.09)).toBe(0);
    });
});

describe('what owns a velocity', () => {
    it('is what shows in depth', () => {
        expect(drawsVelocity(new THREE.MeshStandardMaterial())).toBe(true);
        expect(drawsVelocity(new THREE.MeshStandardMaterial({ alphaTest: 0.5 }))).toBe(true);
        expect(drawsVelocity(new THREE.MeshStandardMaterial({ transparent: true }))).toBe(false);
        expect(drawsVelocity(new THREE.MeshStandardMaterial({ depthWrite: false }))).toBe(false);
        expect(drawsVelocity(new THREE.MeshStandardMaterial({ depthTest: false }))).toBe(false);
        expect(drawsVelocity(new THREE.MeshStandardMaterial({ colorWrite: false }))).toBe(false);
        expect(drawsVelocity(new THREE.MeshStandardMaterial({ visible: false }))).toBe(false);
    });
});

describe('what a level may choose', () => {
    it('steps temporal down to what the project allows, and nothing up', () => {
        expect(allowedAntialias('temporal', 'temporal')).toBe('temporal');
        expect(allowedAntialias('temporal', 'smaa')).toBe('smaa');
        expect(allowedAntialias('temporal', 'none')).toBe('none');
        expect(allowedAntialias('smaa', 'temporal')).toBe('smaa');
        expect(allowedAntialias('smaa', 'none')).toBe('none');
        expect(allowedAntialias('none', 'temporal')).toBe('none');
    });
});

describe('sharper textures', () => {
    it('leaves the normal lookup text that compressed maps and the material graph patch', () => {
        installMipBias();
        // A patch that stops matching does nothing and says nothing: normal maps would quietly lose their z.
        expect(THREE.ShaderChunk.normal_fragment_maps).toContain(NORMAL_READ);
        const graph = readFileSync(resolve(__dirname, '../../runtime/materials/graphMaterial.ts'), 'utf8');
        expect(graph).toContain(NORMAL_READ);
    });

    it('brings the bias along with the normal lookup, and only for that chunk', () => {
        const chunk = THREE.ShaderChunk.normal_fragment_maps;
        expect(chunk.indexOf('#define vNormalMapUv vNormalMapUv, auvraMipBias.x')).toBeLessThan(chunk.indexOf(NORMAL_READ));
        expect(chunk.indexOf('#undef vNormalMapUv')).toBeGreaterThan(chunk.indexOf(NORMAL_READ));
    });

    it('biases the other maps directly', () => {
        for (const [chunk, lookup] of [
            ['map_fragment', 'texture2D( map, vMapUv, auvraMipBias.x )'],
            ['roughnessmap_fragment', 'texture2D( roughnessMap, vRoughnessMapUv, auvraMipBias.x )'],
            ['metalnessmap_fragment', 'texture2D( metalnessMap, vMetalnessMapUv, auvraMipBias.x )'],
            ['emissivemap_fragment', 'texture2D( emissiveMap, vEmissiveMapUv, auvraMipBias.x )'],
            ['alphamap_fragment', 'texture2D( alphaMap, vAlphaMapUv, auvraMipBias.x )'],
        ] as const) {
            expect((THREE.ShaderChunk as Record<string, string>)[chunk]).toContain(lookup);
        }
        expect(THREE.ShaderChunk.uv_pars_fragment).toContain('uniform vec2 auvraMipBias;');
    });

    it('installs once, and every material copy of the uniforms shares one value', () => {
        const before = THREE.ShaderChunk.normal_fragment_maps;
        installMipBias();
        expect(THREE.ShaderChunk.normal_fragment_maps).toBe(before);
        const copy = THREE.UniformsUtils.clone(THREE.ShaderLib.standard.uniforms);
        setTextureMipBias(-1.25);
        expect((copy.auvraMipBias.value as THREE.Vector2).x).toBe(-1.25);
        setTextureMipBias(0);
        expect((copy.auvraMipBias.value as THREE.Vector2).x).toBe(0);
    });
});

describe('the shaders', () => {
    it('keep to what WebGL2 has', () => {
        for (const source of [RESOLVE_FRAGMENT, OUTPUT_FRAGMENT]) expect(source).not.toMatch(/textureGather/);
    });

    it('never let a stray value into history', () => {
        // A NaN or a negative would spread through the history filter and stay for good.
        expect(RESOLVE_FRAGMENT).toContain('greaterThanEqual( raw, vec3( 0.0 ) )');
    });

    it('have no history for what was behind last frame\'s camera', () => {
        expect(RESOLVE_FRAGMENT).toContain('( objectMoved || cameraBefore.w > 0.0 )');
    });

    it('take the distance last frame from a ratio, not as a distance', () => {
        // The reprojection runs from clip space to clip space, so its w alone is last frame's distance over this one's.
        expect(RESOLVE_FRAGMENT).toContain('cameraBefore.w * distanceOf( closest )');
    });

    it('remember contrast only from what holds still', () => {
        expect(RESOLVE_FRAGMENT).toMatch(/seenContrast = depthEdge && !objectNear \? deviation\.x \* \( 1\.0 - smoothstep/);
        expect(RESOLVE_FRAGMENT).toMatch(/contrastFade \* \( 1\.0 - motion \) \* cameraStillness/);
    });
});
