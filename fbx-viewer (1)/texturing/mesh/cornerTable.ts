import * as THREE from 'three';
import type { PartMesh } from './partMesh';

/**
 * PER-VERTEX VALUES FOR UV-SPACE SHADERS, BY TRIANGLE
 *
 * Four numbers per vertex of a texture set (a bake's cage ray, say) handed to the shaders the UV raster
 * draws without a vertex attribute: a float picture holds, for each triangle, its three corners' values
 * and its first corner's position, four texels a triangle. A shader finds its triangle by vIds.z, where
 * it lies on it from vPos and the triangle's edges (vE1, vE2), and blends the corners' values as the
 * raster would have.
 */

export const CORNER_TABLE_WIDTH = 4096;

/** The table's numbers (four texels a triangle) and its rows. */
export interface CornerTable { data: Float32Array; rows: number }

/** Each triangle's corners' values (four per vertex in `perVertex`) and its first corner's position. */
export const cornerTable = (part: Pick<PartMesh, 'indices' | 'positions'>, perVertex: Float32Array): CornerTable => {
    const triangles = part.indices.length / 3;
    const rows = Math.max(1, Math.ceil((triangles * 4) / CORNER_TABLE_WIDTH));
    const data = new Float32Array(rows * CORNER_TABLE_WIDTH * 4);
    for (let t = 0; t < triangles; t++) {
        for (let k = 0; k < 3; k++) {
            const vertex = part.indices[t * 3 + k];
            data.set(perVertex.subarray(vertex * 4, vertex * 4 + 4), (t * 4 + k) * 4);
        }
        const first = part.indices[t * 3];
        data.set([part.positions[first * 3], part.positions[first * 3 + 1], part.positions[first * 3 + 2], 0], (t * 4 + 3) * 4);
    }
    return { data, rows };
};

/** The table as a float texture for the shaders (the caller lets it go). */
export const cornerTexture = (table: CornerTable): THREE.DataTexture => {
    const texture = new THREE.DataTexture(table.data, CORNER_TABLE_WIDTH, table.rows, THREE.RGBAFormat, THREE.FloatType);
    texture.needsUpdate = true;
    return texture;
};

/** The shader's sums on the CPU: the value at a point of a triangle, from its id, the point and its edges. */
export const cornerValueAt = (table: CornerTable, triangle: number, position: readonly number[], edge1: readonly number[], edge2: readonly number[]): [number, number, number, number] => {
    const texel = (i: number) => table.data.subarray(i * 4, i * 4 + 4);
    const p0 = texel(triangle * 4 + 3);
    const d = [position[0] - p0[0], position[1] - p0[1], position[2] - p0[2]];
    const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const d00 = dot(edge1, edge1), d01 = dot(edge1, edge2), d11 = dot(edge2, edge2), d20 = dot(d, edge1), d21 = dot(d, edge2);
    const denominator = d00 * d11 - d01 * d01;
    const b1 = Math.abs(denominator) < 1e-30 ? 0 : (d11 * d20 - d01 * d21) / denominator;
    const b2 = Math.abs(denominator) < 1e-30 ? 0 : (d00 * d21 - d01 * d20) / denominator;
    const c0 = texel(triangle * 4), c1 = texel(triangle * 4 + 1), c2 = texel(triangle * 4 + 2);
    return [0, 1, 2, 3].map((i) => (1 - b1 - b2) * c0[i] + b1 * c1[i] + b2 * c2[i]) as [number, number, number, number];
};

/** GLSL for a UV-space shader reading a corner table bound as \`sampler\`: \`cornerValue()\` is the value at the texel. */
export const cornerTableGlsl = (sampler: string): string => `
uniform sampler2D ${sampler};
vec4 cornerTexel(int i) { return texelFetch(${sampler}, ivec2(i % ${CORNER_TABLE_WIDTH}, i / ${CORNER_TABLE_WIDTH}), 0); }
vec4 cornerValue() {
    int t = int(vIds.z + 0.5);
    vec3 d = vPos - cornerTexel(t * 4 + 3).xyz;
    float d00 = dot(vE1, vE1), d01 = dot(vE1, vE2), d11 = dot(vE2, vE2), d20 = dot(d, vE1), d21 = dot(d, vE2);
    float denominator = d00 * d11 - d01 * d01;
    float b1 = abs(denominator) < 1e-30 ? 0.0 : (d11 * d20 - d01 * d21) / denominator;
    float b2 = abs(denominator) < 1e-30 ? 0.0 : (d00 * d21 - d01 * d20) / denominator;
    return (1.0 - b1 - b2) * cornerTexel(t * 4) + b1 * cornerTexel(t * 4 + 1) + b2 * cornerTexel(t * 4 + 2);
}
`;
