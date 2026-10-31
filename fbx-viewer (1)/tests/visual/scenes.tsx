import React, { useMemo } from 'react';
import * as THREE from 'three';
import { useThree, type RootState } from '@react-three/fiber';
import { DEFAULT_SKY_CONFIG, SkySystem } from '../../components/Environment/SkySystem';
import { POST_PROCESS_COMPONENT } from '../../runtime/components/postProcess';
import { LevelDynamicGi, dynamicGiFor } from '../../runtime/lighting/dynamicGi/LevelDynamicGi';
import { GraphMaterial } from '../../runtime/materials/graphMaterial';
import { normalizeMaterialGraph } from '../../runtime/materials/materialGraph';
import type { LevelComponent, LevelObject, SkyConfig } from '../../types';

/**
 * The scenes the rendering pictures are taken of: each small, fixed and built from the engine's own lighting, sky,
 * effects and materials, so that a change to any of them shows up in the picture.
 */

export interface SceneSteps {
  state: () => RootState;
  frames: (count: number) => Promise<void>;
  until: (condition: () => boolean) => Promise<void>;
}

export interface VisualScene {
  camera: { position: [number, number, number]; fov: number; near?: number; far?: number };
  Scene: React.FC;
  /** Frames before the picture. */
  frames?: number;
  /** Instead of `frames`, for a scene that waits on the GPU. */
  settle?: (steps: SceneSteps) => Promise<void>;
}

const levelObject = (id: string, type: LevelObject['type'], extra: Partial<LevelObject> = {}): LevelObject => ({
  id, levelId: 'visual', modelId: '', name: id, type, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], ...extra,
} as LevelObject);

const component = (type: string, props: Record<string, unknown>): LevelComponent => ({ id: type, type, enabled: true, props });

const LookAt: React.FC<{ at: [number, number, number] }> = ({ at }) => {
  const camera = useThree(state => state.camera);
  useMemo(() => {
    camera.lookAt(...at);
    camera.updateMatrixWorld();
  }, [camera, at]);
  return null;
};

const Sky: React.FC<{ config?: Partial<SkyConfig> }> = ({ config }) => {
  const objects = useMemo(() => [levelObject('sky', 'sky_sphere', { skyConfig: { ...DEFAULT_SKY_CONFIG, fogDensity: 0, ...config } })], [config]);
  return <SkySystem levelObjects={objects} />;
};

const PostProcess: React.FC<{ settings: Record<string, unknown> }> = ({ settings }) => {
  const owner = useMemo(() => levelObject('post', 'prop'), []);
  const held = useMemo(() => component('postProcess', settings), [settings]);
  const Render = POST_PROCESS_COMPONENT.Render!;
  return <Render object={owner} component={held} mode="runtime" />;
};

const Standard: React.FC<THREE.MeshStandardMaterialParameters> = (props) => {
  const material = useMemo(() => new THREE.MeshStandardMaterial(props), []); // eslint-disable-line react-hooks/exhaustive-deps
  return <primitive object={material} attach="material" />;
};

const Box: React.FC<{
  at: [number, number, number];
  size?: [number, number, number];
  turn?: number;
  color?: string;
  roughness?: number;
  metalness?: number;
  emissive?: string;
  emissiveIntensity?: number;
  owner?: string;
}> = ({ at, size = [1, 1, 1], turn = 0, color = '#b8b8b8', roughness = 0.7, metalness = 0, emissive = '#000000', emissiveIntensity = 1, owner }) => (
  <mesh position={at} rotation={[0, turn, 0]} castShadow receiveShadow userData={owner ? { levelObjectId: owner } : undefined}>
    <boxGeometry args={size} />
    <Standard color={color} roughness={roughness} metalness={metalness} emissive={emissive} emissiveIntensity={emissiveIntensity} />
  </mesh>
);

const Ball: React.FC<{ at: [number, number, number]; radius?: number; material: THREE.MeshStandardMaterialParameters; owner?: string }> = ({ at, radius = 0.5, material, owner }) => (
  <mesh position={at} castShadow receiveShadow userData={owner ? { levelObjectId: owner } : undefined}>
    <sphereGeometry args={[radius, 48, 32]} />
    <Standard {...material} />
  </mesh>
);

const Ground: React.FC<{ color?: string; roughness?: number; metalness?: number; size?: number; owner?: string }> = ({ color = '#6b6b6b', roughness = 0.9, metalness = 0, size = 400, owner }) => (
  <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow userData={owner ? { levelObjectId: owner } : undefined}>
    <planeGeometry args={[size, size]} />
    <Standard color={color} roughness={roughness} metalness={metalness} />
  </mesh>
);

const checkerTexture = (): THREE.DataTexture => {
  const size = 64;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const light = ((x >> 3) + (y >> 3)) % 2 === 0;
      pixels.set(light ? [220, 200, 170, 255] : [70, 80, 110, 255], (x + y * size) * 4);
    }
  }
  const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
};

const graphNode = (id: string, type: string, params: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, params });
const graphLink = (fromNode: string, fromOutput: string, toNode: string, toInput: string) => ({ fromNode, fromOutput, toNode, toInput });

const GraphBall: React.FC<{ at: [number, number, number] }> = ({ at }) => {
  const material = useMemo(() => new GraphMaterial(normalizeMaterialGraph({
    nodes: [
      graphNode('out', 'output'),
      graphNode('a', 'color', { value: [0.9, 0.2, 0.1] }),
      graphNode('b', 'color', { value: [0.1, 0.3, 0.9] }),
      graphNode('noise', 'noise'),
      graphNode('mix', 'lerp'),
    ],
    links: [graphLink('a', 'out', 'mix', 'a'), graphLink('b', 'out', 'mix', 'b'), graphLink('noise', 'out', 'mix', 't'), graphLink('mix', 'out', 'out', 'baseColor')],
  })), []);
  return (
    <mesh position={at} castShadow receiveShadow material={material}>
      <sphereGeometry args={[0.5, 48, 32]} />
    </mesh>
  );
};

/** Dielectrics and metals across roughness, a texture, glass, a glow and a material graph. */
const MaterialsScene: React.FC = () => {
  const checker = useMemo(checkerTexture, []);
  const steps = [0.05, 0.25, 0.5, 0.75, 1];
  return (
    <>
      <LookAt at={[0, 0.3, 0.4]} />
      <Sky />
      <Ground />
      {steps.map((roughness, index) => <Ball key={`d${index}`} at={[-2.4 + index * 1.2, 0.5, 2]} material={{ color: '#c0392b', roughness }} />)}
      {steps.map((roughness, index) => <Ball key={`m${index}`} at={[-2.4 + index * 1.2, 0.5, 0.6]} material={{ color: '#d9c7a0', roughness, metalness: 1 }} />)}
      <mesh position={[-2.4, 0.5, -0.8]} castShadow receiveShadow>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial map={checker} roughness={0.6} />
      </mesh>
      <mesh position={[-1.2, 0.6, -0.8]}>
        <boxGeometry args={[1, 1.2, 0.1]} />
        <meshStandardMaterial color="#88bbff" transparent opacity={0.35} roughness={0.1} />
      </mesh>
      <Ball at={[0, 0.5, -0.8]} material={{ color: '#111111', emissive: '#ff8a2a', emissiveIntensity: 3 }} />
      <GraphBall at={[1.2, 0.5, -0.8]} />
      <mesh position={[2.4, 0.5, -0.8]} castShadow receiveShadow>
        <torusKnotGeometry args={[0.32, 0.12, 96, 16]} />
        <meshStandardMaterial color="#2ecc71" wireframe={false} flatShading roughness={0.4} />
      </mesh>
    </>
  );
};

/** Point, spot and fill lights in the dark, with their shadows and falloff. */
const LightingScene: React.FC = () => (
  <>
    <LookAt at={[0, 1, 0]} />
    <color attach="background" args={['#000000']} />
    <hemisphereLight args={['#334466', '#221a11', 0.5]} />
    <pointLight position={[-2.5, 2, 1]} color="#ff5533" intensity={18} distance={12} castShadow shadow-mapSize={[1024, 1024]} />
    <pointLight position={[2.5, 1.2, 1.5]} color="#33aaff" intensity={10} distance={8} />
    <spotLight position={[0, 5, 2.5]} angle={0.5} penumbra={0.4} color="#fff2cc" intensity={60} distance={14} castShadow shadow-mapSize={[1024, 1024]} />
    <Ground color="#8a8a8a" size={60} />
    <Box at={[-1.5, 0.6, 0]} size={[1.2, 1.2, 1.2]} turn={0.5} />
    <Box at={[1.4, 0.9, -0.4]} size={[0.8, 1.8, 0.8]} turn={-0.3} color="#d9d0c0" />
    <Ball at={[0, 0.6, 1]} radius={0.6} material={{ color: '#e8e8e8', roughness: 0.35 }} />
    <Box at={[0, 5, -4]} size={[40, 10, 0.4]} color="#6f7780" />
  </>
);

/** The sun's own map and its distance cascades: thin things close up, and pillars going far off. */
const ShadowsScene: React.FC = () => (
  <>
    <LookAt at={[0, 1, -20]} />
    <Sky config={{ timeOfDay: 16.5, azimuth: 0.1 }} />
    <Ground color="#9a9a8a" />
    {Array.from({ length: 16 }, (_, index) => <Box key={index} at={[index % 2 ? 6 : -6, 3, -index * 12]} size={[1, 6, 1]} />)}
    <Box at={[0, 1, 2]} size={[0.15, 2, 3]} color="#c7b299" />
    <Ball at={[2.2, 0.8, 3]} radius={0.8} material={{ color: '#a0b4c8', roughness: 0.6 }} />
    {Array.from({ length: 6 }, (_, index) => <Box key={`rail${index}`} at={[-3.2 + index * 0.35, 0.75, 4]} size={[0.08, 1.5, 0.08]} color="#444444" />)}
  </>
);

const GI_OBJECTS = (rays: Record<string, unknown>): LevelObject[] => [
  levelObject('room', 'prop', { components: [component('dynamicGi', { quality: 'low', spacing: 1, rayLimit: 33, ...rays })] }),
];

/** Waits for the rays' two big shaders, on the GPU's time, without the frames moving on. */
const settleWithRays = (frames: number) => async ({ frames: run, until, state }: SceneSteps): Promise<void> => {
  const shaders = () => dynamicGiFor(state().gl) as unknown as { traceReady: boolean; reflectionsReady: boolean } | null;
  await run(1);
  await until(() => shaders()?.traceReady === true);
  await run(1);
  await until(() => shaders()?.reflectionsReady === true || !usesRayReflections(state()));
  await run(frames);
};

const usesRayReflections = (state: RootState): boolean => state.scene.userData.visualRayReflections === true;

const RayReflectionsFlag: React.FC = () => {
  const scene = useThree(state => state.scene);
  useMemo(() => { scene.userData.visualRayReflections = true; }, [scene]);
  return null;
};

const REFLECTIONS_POST = { antialias: 'smaa', reflections: true, reflectionIntensity: 1, bloom: false, ambientOcclusion: false, toneMapping: 'aces' };

/** A glossy floor and metal: what is in view from the screen, and what is behind the camera from rays. */
const ReflectionsScene: React.FC = () => {
  const objects = useMemo(() => GI_OBJECTS({ reflections: true }), []);
  return (
    <>
      <LookAt at={[0, 0.8, 0]} />
      <RayReflectionsFlag />
      <Sky config={{ timeOfDay: 15 }} />
      <LevelDynamicGi levelObjects={objects} />
      <PostProcess settings={REFLECTIONS_POST} />
      <Ground color="#202428" roughness={0.08} metalness={0.2} owner="room" />
      <Box at={[-2, 1, -1]} size={[1.4, 2, 1.4]} turn={0.4} color="#c0392b" owner="room" />
      <Ball at={[1.6, 1, 0]} radius={1} material={{ color: '#e6e6e6', roughness: 0.04, metalness: 1 }} owner="room" />
      <Box at={[0.2, 0.4, 1.4]} size={[0.8, 0.8, 0.8]} turn={0.8} color="#27ae60" owner="room" />
      {/* Behind the camera, where only rays can find it. */}
      <Box at={[0, 2.5, 8]} size={[10, 5, 0.5]} color="#2980b9" owner="room" />
    </>
  );
};

/** Light bouncing in a sunlit room: the white walls take on the colours of the red and green ones. */
const BounceLightScene: React.FC = () => {
  const objects = useMemo(() => GI_OBJECTS({ reflections: false, view: 'lit' }), []);
  return (
    <>
      <LookAt at={[0, 1.5, 0]} />
      <Sky config={{ timeOfDay: 13, azimuth: 0.35, ambienceIntensity: 0.1 }} />
      <LevelDynamicGi levelObjects={objects} />
      <Ground color="#c8c8c8" owner="room" />
      <Box at={[-4, 2, 0]} size={[0.3, 4, 8]} color="#c0261c" owner="room" />
      <Box at={[4, 2, 0]} size={[0.3, 4, 8]} color="#1f9e3a" owner="room" />
      <Box at={[0, 2, -4]} size={[8, 4, 0.3]} color="#d5d5d5" owner="room" />
      <Box at={[-2.2, 4.1, 0]} size={[4, 0.2, 8.3]} color="#d5d5d5" owner="room" />
      <Box at={[2.6, 4.1, 0]} size={[2.8, 0.2, 8.3]} color="#d5d5d5" owner="room" />
      <Box at={[0.6, 0.9, -1]} size={[1.6, 1.8, 1.6]} turn={0.5} color="#d5d5d5" owner="room" />
    </>
  );
};

const Stage: React.FC = () => (
  <>
    <Ground color="#7c7c74" />
    <Box at={[-2.2, 0.7, -1]} size={[1.4, 1.4, 1.4]} turn={0.5} />
    <Ball at={[0, 0.8, 0.4]} radius={0.8} material={{ color: '#c9a35f', roughness: 0.3, metalness: 0.9 }} />
    <Box at={[2.3, 1, -0.5]} size={[1, 2, 1]} turn={-0.2} color="#587a99" />
    <Ball at={[-0.8, 0.25, 2.2]} radius={0.25} material={{ color: '#111111', emissive: '#ffcc66', emissiveIntensity: 12 }} />
    <Ball at={[1, 0.25, 2.4]} radius={0.25} material={{ color: '#111111', emissive: '#55aaff', emissiveIntensity: 12 }} />
    {Array.from({ length: 7 }, (_, index) => <Box key={index} at={[-6 + index * 2, 1.5, -6 - index]} size={[1, 3, 1]} color="#8a7f70" />)}
  </>
);

const LIT_POST = { antialias: 'smaa', bloom: true, bloomIntensity: 1.2, bloomThreshold: 1, ambientOcclusion: true, aoIntensity: 2.5, aoRadius: 1, toneMapping: 'aces', exposure: 1, reflections: false, globalIllumination: false };

/** Bloom, ambient occlusion and tone mapping on the lit scene. */
const PostLitScene: React.FC = () => (
  <>
    <LookAt at={[0, 0.8, 0]} />
    <Sky config={{ timeOfDay: 17.5 }} />
    <PostProcess settings={LIT_POST} />
    <Stage />
  </>
);

const GRADE_POST = {
  antialias: 'temporal', sharpness: 0.3, bloom: true, bloomIntensity: 0.6, bloomThreshold: 1, ambientOcclusion: false, toneMapping: 'agx', exposure: 1.1,
  depthOfField: true, focusDistance: 7, bokehScale: 3, vignette: true, vignetteDarkness: 0.6, saturation: 0.1, contrast: 0.08, temperature: 0.2, tint: -0.05,
  look: 'teal-orange', lookStrength: 0.6, chromaticAberration: 0.5, reflections: true, reflectionIntensity: 0.6, globalIllumination: true, giIntensity: 0.6,
};

/** Temporal resolve, screen-space light, depth of field, grading, a colour look, a vignette and fringes. */
const PostGradeScene: React.FC = () => (
  <>
    <LookAt at={[0, 0.8, 0]} />
    <Sky config={{ timeOfDay: 11 }} />
    <PostProcess settings={GRADE_POST} />
    <Stage />
  </>
);

/** Thousands of separate things, for what a full level's worth of draws and loading costs. */
const CrowdScene: React.FC = () => {
  const geometry = useMemo(() => new THREE.BoxGeometry(0.8, 0.8, 0.8), []);
  const materials = useMemo(() => Array.from({ length: 24 }, (_, index) => new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(index / 24, 0.5, 0.5), roughness: 0.3 + (index % 4) * 0.2 })), []);
  const places = useMemo(() => Array.from({ length: 2500 }, (_, index) => [(index % 50) * 1.6 - 40, 0.4 + (index % 3) * 0.2, -Math.floor(index / 50) * 1.6] as const), []);
  return (
    <>
      <LookAt at={[0, 0, -30]} />
      <Sky config={{ timeOfDay: 14 }} />
      <Ground />
      {places.map(([x, y, z], index) => <mesh key={index} geometry={geometry} material={materials[index % materials.length]} position={[x, y, z]} castShadow receiveShadow />)}
    </>
  );
};

export const SCENES: Record<string, VisualScene> = {
  materials: { camera: { position: [0, 4.2, 7.2], fov: 45 }, Scene: MaterialsScene, frames: 20 },
  lighting: { camera: { position: [0, 3, 7], fov: 45 }, Scene: LightingScene, frames: 10 },
  shadows: { camera: { position: [0, 4, 10], fov: 50, far: 400 }, Scene: ShadowsScene, frames: 20 },
  reflections: { camera: { position: [0, 2, 6], fov: 50 }, Scene: ReflectionsScene, settle: settleWithRays(60) },
  'bounce-light': { camera: { position: [0, 1.8, 7.5], fov: 50 }, Scene: BounceLightScene, settle: settleWithRays(120) },
  'post-lit': { camera: { position: [0, 2, 7], fov: 45 }, Scene: PostLitScene, frames: 20 },
  'post-grade': { camera: { position: [0, 2, 7], fov: 45 }, Scene: PostGradeScene, frames: 30 },
  crowd: { camera: { position: [0, 12, 14], fov: 50, far: 300 }, Scene: CrowdScene, frames: 3 },
};
