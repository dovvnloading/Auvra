import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { boneAtScreen, setSkeletonView, skeletonBones, skinnedStandIns, useSkeletonView } from '../../utils/skeletonView';
import { SkinPaintBrush } from './SkinPaintBrush';

const BONE_COLOR = new THREE.Color('#c7ccd6');
const SELECTED_COLOR = new THREE.Color('#ff9a3d');

const NOTHING = (): void => undefined;

/** A press that moves further than this, in pixels, is the camera being dragged and not a click. */
const CLICK_SLOP = 4;

/** Weights draw after everything of the model, its see-through parts too, and before the bones. */
const WEIGHT_ORDER = 900;

/** Bones drawn over the model as lines from each joint to its parent, the picked bone in the accent colour. */
const SkeletonLines: React.FC<{ root: THREE.Object3D; selectedBone: string | null; pickable: boolean }> = ({ root, selectedBone, pickable }) => {
  const bones = useMemo(() => skeletonBones(root), [root]);
  const linked = useMemo(() => bones.filter((entry) => entry.parent >= 0), [bones]);
  const lines = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(1, linked.length) * 6), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(Math.max(1, linked.length) * 6), 3));
    return geometry;
  }, [linked]);
  const joints = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(1, bones.length) * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(Math.max(1, bones.length) * 3), 3));
    return geometry;
  }, [bones]);
  useEffect(() => () => {
    lines.dispose();
    joints.dispose();
  }, [lines, joints]);

  // The picked bone and the line to its parent stand out.
  useEffect(() => {
    const lineColors = lines.getAttribute('color') as THREE.BufferAttribute;
    linked.forEach((entry, index) => {
      const color = entry.name === selectedBone ? SELECTED_COLOR : BONE_COLOR;
      lineColors.setXYZ(index * 2, color.r, color.g, color.b);
      lineColors.setXYZ(index * 2 + 1, color.r, color.g, color.b);
    });
    lineColors.needsUpdate = true;
    const jointColors = joints.getAttribute('color') as THREE.BufferAttribute;
    bones.forEach((entry, index) => {
      const color = entry.name === selectedBone ? SELECTED_COLOR : BONE_COLOR;
      jointColors.setXYZ(index, color.r, color.g, color.b);
    });
    jointColors.needsUpdate = true;
  }, [bones, linked, lines, joints, selectedBone]);

  // A click near a joint picks its bone.
  const camera = useThree((three) => three.camera);
  const canvas = useThree((three) => three.gl.domElement);
  useEffect(() => {
    if (!pickable) return undefined;
    let pressedAt: { x: number; y: number } | null = null;
    const onDown = (event: PointerEvent): void => {
      pressedAt = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
    };
    const onUp = (event: PointerEvent): void => {
      if (!pressedAt || Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y) > CLICK_SLOP) return;
      const bounds = canvas.getBoundingClientRect();
      const picked = boneAtScreen(bones, camera, event.clientX - bounds.left, event.clientY - bounds.top, bounds.width, bounds.height);
      if (picked) setSkeletonView({ selectedBone: picked.name });
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
    };
  }, [bones, camera, canvas, pickable]);

  // The picked bone's name goes by its joint, and follows it.
  const pickedBone = bones.find((entry) => entry.name === selectedBone)?.bone ?? null;
  const pickedLabel = useRef<THREE.Group>(null);

  const point = useRef(new THREE.Vector3());
  useFrame(() => {
    if (pickedLabel.current && pickedBone) pickedBone.getWorldPosition(pickedLabel.current.position);
    const places = joints.getAttribute('position') as THREE.BufferAttribute;
    bones.forEach((entry, index) => {
      entry.bone.getWorldPosition(point.current);
      places.setXYZ(index, point.current.x, point.current.y, point.current.z);
    });
    places.needsUpdate = true;
    const segments = lines.getAttribute('position') as THREE.BufferAttribute;
    linked.forEach((entry, index) => {
      segments.setXYZ(index * 2, places.getX(bones.indexOf(entry)), places.getY(bones.indexOf(entry)), places.getZ(bones.indexOf(entry)));
      segments.setXYZ(index * 2 + 1, places.getX(entry.parent), places.getY(entry.parent), places.getZ(entry.parent));
    });
    segments.needsUpdate = true;
    lines.computeBoundingSphere();
    joints.computeBoundingSphere();
  });

  // Positions are in the world: the parents of this group do not move it.
  const placeInWorld = (object: THREE.Object3D | null): void => {
    if (!object) return;
    object.matrixAutoUpdate = false;
    object.matrixWorldAutoUpdate = false;
    object.matrixWorld.identity();
  };

  return (
    <>
      <lineSegments ref={placeInWorld} geometry={lines} renderOrder={1000} frustumCulled={false} raycast={NOTHING}>
        <lineBasicMaterial vertexColors depthTest={false} transparent opacity={0.85} toneMapped={false} fog={false} />
      </lineSegments>
      <points ref={placeInWorld} geometry={joints} renderOrder={1001} frustumCulled={false} raycast={NOTHING}>
        <pointsMaterial vertexColors size={5} sizeAttenuation={false} depthTest={false} transparent toneMapped={false} fog={false} />
      </points>
      {pickedBone && (
        <group ref={pickedLabel}>
          <Html zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
            <span className="absolute left-2 -top-2 whitespace-nowrap rounded bg-black/60 px-1 py-px text-2xs text-white">{selectedBone}</span>
          </Html>
        </group>
      )}
    </>
  );
};

/**
 * A mesh coloured by how much the picked bone moves it: slate where not at all, then from blue through
 * green to red where fully, in the same colours as the panel's key. It is lit from the view, so the
 * shape of what is being painted can be seen. It covers the mesh as drawn already, at the same depth.
 */
const weightMaterial = (pickedBone: { value: number }): THREE.MeshBasicMaterial => {
  const material = new THREE.MeshBasicMaterial({
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
    transparent: true,
    forceSinglePass: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.pickedBone = pickedBone;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float pickedBone;\nvarying float vBoneWeight;\nvarying vec3 vSurface;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvSurface = mvPosition.xyz;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vBoneWeight = 0.0;
        #ifdef USE_SKINNING
          if (abs(skinIndex.x - pickedBone) < 0.5) vBoneWeight += skinWeight.x;
          if (abs(skinIndex.y - pickedBone) < 0.5) vBoneWeight += skinWeight.y;
          if (abs(skinIndex.z - pickedBone) < 0.5) vBoneWeight += skinWeight.z;
          if (abs(skinIndex.w - pickedBone) < 0.5) vBoneWeight += skinWeight.w;
        #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vBoneWeight;\nvarying vec3 vSurface;')
      .replace('#include <colorspace_fragment>', '')
      .replace('#include <opaque_fragment>', `
        vec3 heat = vBoneWeight < 0.004 ? vec3(0.2, 0.22, 0.28)
          : mix(mix(vec3(0.05, 0.25, 0.85), vec3(0.1, 0.85, 0.4), smoothstep(0.0, 0.5, vBoneWeight)), vec3(0.95, 0.15, 0.1), smoothstep(0.5, 1.0, vBoneWeight));
        heat *= 0.5 + 0.5 * abs(normalize(cross(dFdx(vSurface), dFdy(vSurface))).z);
        gl_FragColor = vec4(heat, 1.0);`);
  };
  material.customProgramCacheKey = () => 'bone-weight';
  return material;
};

/** While on, draws each skinned mesh over again by the picked bone's weights. */
const WeightView: React.FC<{ root: THREE.Object3D; selectedBone: string | null }> = ({ root, selectedBone }) => {
  const holder = useRef<THREE.Group>(null);
  const shaded = useRef<{ mesh: THREE.SkinnedMesh; standIn: THREE.SkinnedMesh; pickedBone: { value: number } }[]>([]);
  useEffect(() => {
    const group = holder.current;
    if (!group) return undefined;
    const picks = new Map<THREE.SkinnedMesh, { value: number }>();
    const standIns = skinnedStandIns(root, (mesh) => {
      const pickedBone = { value: -1 };
      picks.set(mesh, pickedBone);
      return weightMaterial(pickedBone);
    });
    shaded.current = standIns.map(({ mesh, standIn }) => {
      standIn.renderOrder = WEIGHT_ORDER;
      standIn.raycast = NOTHING;
      group.add(standIn);
      return { mesh, standIn, pickedBone: picks.get(mesh)! };
    });
    return () => {
      for (const { standIn } of standIns) {
        group.remove(standIn);
        (standIn.material as THREE.Material).dispose();
      }
      shaded.current = [];
    };
  }, [root]);
  useFrame(() => {
    for (const { mesh, standIn, pickedBone } of shaded.current) {
      // Looked up each frame: painting can give a mesh a bone it did not have.
      pickedBone.value = selectedBone ? mesh.skeleton.bones.findIndex((bone) => bone.name === selectedBone) : -1;
      let shown = true;
      for (let node: THREE.Object3D | null = mesh; node && shown; node = node.parent) shown = node.visible;
      standIn.visible = shown;
    }
  });
  return <group ref={holder} />;
};

/** The Skeleton panel's view of the selected model in the viewport: its bones, and what the picked one moves. */
export const SkeletonOverlay: React.FC<{ root: THREE.Object3D }> = ({ root }) => {
  const view = useSkeletonView();
  const brush = view.showWeights && view.selectedBone !== null && view.brush !== 'off' ? view.brush : null;
  return (
    <>
      {view.showSkeleton && <SkeletonLines root={root} selectedBone={view.selectedBone} pickable={!brush} />}
      {view.showWeights && <WeightView root={root} selectedBone={view.selectedBone} />}
      {brush && <SkinPaintBrush root={root} boneName={view.selectedBone!} mode={brush} size={view.brushSize} strength={view.brushStrength} />}
    </>
  );
};
