import * as THREE from 'three';

/**
 * TERRAIN BRUSH OVERLAY
 *
 * Draws a tool's brush into the terrain's own shader, so it lies on the ground exactly and shows
 * where its strength fades. The uniforms are shared by every terrain material: one brush exists at a
 * time. A radius of 0 draws nothing, which is the state in play.
 */
export const TERRAIN_BRUSH_UNIFORMS = {
  terrainBrushCentre: { value: new THREE.Vector2() },
  /** World metres from the centre to the outer edge; 0 for no brush. */
  terrainBrushRadius: { value: 0 },
  /** World metres from the centre to where the strength starts to fade. */
  terrainBrushInner: { value: 0 },
  terrainBrushColour: { value: new THREE.Color('#ffffff') },
  /** A world-space rectangle outlined on the ground, for picking a region: minX, minZ, maxX, maxZ; empty when max < min. */
  terrainBrushRect: { value: new THREE.Vector4(0, 0, -1, -1) },
};

export const showTerrainBrush = (x: number, z: number, radius: number, inner: number, colour: string | THREE.Color): void => {
  TERRAIN_BRUSH_UNIFORMS.terrainBrushCentre.value.set(x, z);
  TERRAIN_BRUSH_UNIFORMS.terrainBrushRadius.value = radius;
  TERRAIN_BRUSH_UNIFORMS.terrainBrushInner.value = inner;
  TERRAIN_BRUSH_UNIFORMS.terrainBrushColour.value.set(colour as THREE.ColorRepresentation);
};

export const hideTerrainBrush = (): void => {
  TERRAIN_BRUSH_UNIFORMS.terrainBrushRadius.value = 0;
};

export const showTerrainRect = (minX: number, minZ: number, maxX: number, maxZ: number): void => {
  TERRAIN_BRUSH_UNIFORMS.terrainBrushRect.value.set(minX, minZ, maxX, maxZ);
};

export const hideTerrainRect = (): void => {
  TERRAIN_BRUSH_UNIFORMS.terrainBrushRect.value.set(0, 0, -1, -1);
};

const VERTEX = /* glsl */`
vTerrainBrushWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`;

const FRAGMENT_DECLARATIONS = /* glsl */`
uniform vec2 terrainBrushCentre;
uniform float terrainBrushRadius;
uniform float terrainBrushInner;
uniform vec3 terrainBrushColour;
uniform vec4 terrainBrushRect;
varying vec3 vTerrainBrushWorld;`;

// A soft fill that follows the falloff, a bright outer ring and a thin ring where the fade begins.
const FRAGMENT = /* glsl */`
if ( terrainBrushRadius > 0.0 ) {
    float brushDistance = distance( vTerrainBrushWorld.xz, terrainBrushCentre );
    if ( brushDistance < terrainBrushRadius + 1.0 ) {
        float brushPixel = max( fwidth( brushDistance ), 1e-4 );
        float brushOuter = 1.0 - smoothstep( 0.0, brushPixel * 1.5, abs( brushDistance - terrainBrushRadius ) - brushPixel * 0.75 );
        float brushInner = 1.0 - smoothstep( 0.0, brushPixel * 1.5, abs( brushDistance - terrainBrushInner ) - brushPixel * 0.25 );
        float brushBand = max( terrainBrushRadius - terrainBrushInner, 1e-4 );
        float brushFill = brushDistance < terrainBrushRadius ? 1.0 - clamp( ( brushDistance - terrainBrushInner ) / brushBand, 0.0, 1.0 ) : 0.0;
        float brushAmount = max( max( brushOuter * 0.95, brushInner * 0.45 ), brushFill * 0.08 );
        gl_FragColor.rgb = mix( gl_FragColor.rgb, terrainBrushColour, brushAmount );
    }
}
if ( terrainBrushRect.z >= terrainBrushRect.x ) {
    vec2 rectLow = vTerrainBrushWorld.xz - terrainBrushRect.xy;
    vec2 rectHigh = terrainBrushRect.zw - vTerrainBrushWorld.xz;
    float rectEdge = min( min( rectLow.x, rectLow.y ), min( rectHigh.x, rectHigh.y ) );
    float rectPixel = max( fwidth( rectEdge ), 1e-4 );
    float rectLine = 1.0 - smoothstep( 0.0, rectPixel * 1.5, abs( rectEdge ) - rectPixel * 0.75 );
    float rectFill = rectEdge > 0.0 ? 0.12 : 0.0;
    gl_FragColor.rgb = mix( gl_FragColor.rgb, terrainBrushColour, max( rectLine * 0.95, rectFill ) );
}`;

const inject = (source: string, marker: string, code: string): string => {
  if (!source.includes(marker)) throw new Error(`Terrain brush shader is missing ${marker}`);
  return source.replace(marker, `${marker}\n${code}`);
};

/** Adds the overlay to a MeshStandardMaterial program (the shader handed to onBeforeCompile). */
export const patchTerrainBrushOverlay = (shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, THREE.IUniform> }): void => {
  Object.assign(shader.uniforms, TERRAIN_BRUSH_UNIFORMS);
  shader.vertexShader = inject(shader.vertexShader, '#include <common>', 'varying vec3 vTerrainBrushWorld;');
  shader.vertexShader = inject(shader.vertexShader, '#include <project_vertex>', VERTEX);
  shader.fragmentShader = inject(shader.fragmentShader, '#include <common>', FRAGMENT_DECLARATIONS);
  shader.fragmentShader = inject(shader.fragmentShader, '#include <opaque_fragment>', FRAGMENT);
};
