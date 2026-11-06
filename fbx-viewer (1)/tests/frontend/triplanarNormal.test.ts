import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MG_TRIPLANAR_NORMAL, triplanarNormal, triplanarUvs, type Vec3 } from '../../runtime/materials/triplanarNormal';
import { OUTPUT_NODE_TYPE, compileMaterialGraph, defaultParams, normalizeMaterialGraph, textureSlot } from '../../runtime/materials/materialGraph';
import { bindMaterialGraph } from '../../runtime/materials/graphMaterial';

const FLAT: Vec3 = [0, 0, 1];
/** A map whose every texel leans toward its own +u: a ridge rising to the right. */
const leaning: Vec3 = [Math.sin(0.4), 0, Math.cos(0.4)];

const FACES: Vec3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The world direction a projection's u and v run along on a face, found by moving the point. */
const uvAxes = (face: Vec3): { u: Vec3; v: Vec3 } => {
    const axis = face.findIndex(component => component !== 0);
    const key = (['x', 'y', 'z'] as const)[axis];
    const at = (position: Vec3) => triplanarUvs(position, face)[key];
    const along = (direction: Vec3, component: 0 | 1) => at(direction)[component] - at([0, 0, 0])[component];
    const unit: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    return {
        u: unit.map(direction => along(direction, 0)) as Vec3,
        v: unit.map(direction => along(direction, 1)) as Vec3,
    };
};

describe('a triplanar normal map', () => {
    it('leaves the surface normal as it is where the map is flat, on every face and in between', () => {
        for (const face of [...FACES, [0.6, 0.8, 0] as Vec3, [0.48, 0.6, -0.64] as Vec3]) {
            const normal = triplanarNormal(face, [0.3, 1.7, -2.2], () => FLAT);
            normal.forEach((component, index) => expect(component).toBeCloseTo(face[index] / Math.hypot(...face), 5));
        }
    });

    it('reads the map the right way round from outside every face, so opposite faces are not mirrored', () => {
        for (const face of FACES) {
            const { u, v } = uvAxes(face);
            // u to the face's right, v up: with the outward normal they make a right-handed frame.
            expect(cross(u, v).map(component => component + 0)).toEqual(face.map(component => component + 0));
        }
    });

    it('turns a lean in the map toward each face\'s own u, whichever way the face looks', () => {
        for (const face of FACES) {
            const { u } = uvAxes(face);
            const normal = triplanarNormal(face, [0.2, 0.4, 0.6], () => leaning, 32);
            // Tilted toward the projection's u by the map's lean, still facing out.
            expect(dot(normal, u)).toBeCloseTo(Math.sin(0.4), 2);
            expect(dot(normal, face)).toBeGreaterThan(0.8);
        }
    });

    it('scales the bumps by its strength, and blends the projections by how squarely the surface faces each', () => {
        const strong = triplanarNormal([0, 0, 1], [0, 0, 0], () => leaning, 4, 2);
        const weak = triplanarNormal([0, 0, 1], [0, 0, 0], () => leaning, 4, 0.5);
        expect(Math.abs(strong[0])).toBeGreaterThan(Math.abs(weak[0]));
        const corner = triplanarNormal([1, 1, 1], [0, 0, 0], () => FLAT);
        corner.forEach(component => expect(component).toBeCloseTo(1 / Math.sqrt(3), 5));
    });

    it('is drawn by GLSL following the same maths', () => {
        expect(MG_TRIPLANAR_NORMAL).toContain('vec2(-facing.x * position.z, position.y)');
        expect(MG_TRIPLANAR_NORMAL).toContain('vec2(-facing.y * position.x, position.z)');
        expect(MG_TRIPLANAR_NORMAL).toContain('vec2(facing.z * position.x, position.y)');
        expect(MG_TRIPLANAR_NORMAL).toContain('x.x *= -facing.x; y.x *= -facing.y; z.x *= facing.z;');
        expect(MG_TRIPLANAR_NORMAL).toContain('return normalize(x.zyx * weights.x + y.xzy * weights.y + z.xyz * weights.z);');
    });
});

describe('the Triplanar Normal Map node', () => {
    const graph = (normalSpace: 'tangent' | 'world') => normalizeMaterialGraph({
        nodes: [
            { id: 'out', type: OUTPUT_NODE_TYPE, x: 0, y: 0, params: { ...defaultParams(OUTPUT_NODE_TYPE), normalSpace } },
            { id: 'rock', type: 'triplanarNormal', x: 0, y: 0, params: { ...defaultParams('triplanarNormal'), texture: 'rock-normal', flipGreen: true } },
        ],
        links: [{ fromNode: 'rock', fromOutput: 'out', toNode: 'out', toInput: 'normal' }],
    });

    it('reads its map as a normal map, at the tiling and strength set', () => {
        const compiled = compileMaterialGraph(graph('world'));
        expect(compiled.helpers).toContain('mgTriplanarNormal');
        expect(compiled.statements.join(' ')).toMatch(/vec3 mg_rock_out_out_\d+ = mgTriplanarNormal\(mg_rock_texture, vMgWorldPosition \* mg_rock_tiling, mgWorldNormal\(\), mg_rock_sharpness, mg_rock_strength, -1\.0\);/);
        expect(textureSlot(graph('world').nodes[1])).toBe('normal');
    });

    it('gives the Material Output a world-space normal, taken without a tangent frame', () => {
        const fragment = (normalSpace: 'tangent' | 'world') => {
            const material = new THREE.MeshStandardMaterial();
            bindMaterialGraph(material, graph(normalSpace));
            const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader } as unknown as THREE.WebGLProgramParametersWithUniforms;
            material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
            return shader.fragmentShader;
        };
        const world = fragment('world');
        expect(world).toMatch(/normal = normalize\(\(viewMatrix \* vec4\(mg_rock_out_out_\d+, 0\.0\)\)\.xyz\);/);
        expect(world).not.toContain('normal = normalize( tbn * mapN );');
        expect(fragment('tangent')).toMatch(/vec3 mapN = mg_rock_out_out_\d+;/);
    });
});
