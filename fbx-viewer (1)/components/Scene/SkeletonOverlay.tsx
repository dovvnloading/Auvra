import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { skeletonBones, useSkeletonView } from '../../utils/skeletonView';

const BONE_COLOR = new THREE.Color('#c7ccd6');
const SELECTED_COLOR = new THREE.Color('#ff9a3d');

const NOTHING = (): void => undefined;

/** Bones drawn over the model as lines from each joint to its parent, the picked bone in the accent colour. */
const SkeletonLines: React.FC<{ root: THREE.Object3D; selectedBone: string | null }> = ({ root, selectedBone }) => {
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

  const point = useRef(new THREE.Vector3());
  useFrame(() => {
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
    </>
  );
};

/** A mesh shaded by how much the picked bone moves it: blue where not at all, through green, to red where fully. */
const weightMaterial = (boneIndex: number): THREE.MeshBasicMaterial => {
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.pickedBone = { value: boneIndex };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float pickedBone;\nvarying float vBoneWeight;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vBoneWeight = 0.0;
        #ifdef USE_SKINNING
          if (abs(skinIndex.x - pickedBone) < 0.5) vBoneWeight += skinWeight.x;
          if (abs(skinIndex.y - pickedBone) < 0.5) vBoneWeight += skinWeight.y;
          if (abs(skinIndex.z - pickedBone) < 0.5) vBoneWeight += skinWeight.z;
          if (abs(skinIndex.w - pickedBone) < 0.5) vBoneWeight += skinWeight.w;
        #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vBoneWeight;')
      .replace('#include <opaque_fragment>', `
        vec3 heat = vBoneWeight < 0.004 ? vec3(0.05, 0.07, 0.16)
          : mix(mix(vec3(0.05, 0.25, 0.85), vec3(0.1, 0.85, 0.4), smoothstep(0.0, 0.5, vBoneWeight)), vec3(0.95, 0.15, 0.1), smoothstep(0.5, 1.0, vBoneWeight));
        gl_FragColor = vec4(heat, 1.0);`);
  };
  material.customProgramCacheKey = () => 'bone-weight';
  return material;
};

/** While on, draws each skinned mesh by the picked bone's weights, and puts its own materials back afterwards. */
const WeightView: React.FC<{ root: THREE.Object3D; selectedBone: string | null }> = ({ root, selectedBone }) => {
  useEffect(() => {
    const restore: (() => void)[] = [];
    root.traverse((node) => {
      const mesh = node as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh) return;
      const original = mesh.material;
      const index = selectedBone ? mesh.skeleton.bones.findIndex((bone) => bone.name === selectedBone) : -1;
      const material = weightMaterial(index);
      mesh.material = material;
      restore.push(() => {
        mesh.material = original;
        material.dispose();
      });
    });
    return () => { for (const undo of restore) undo(); };
  }, [root, selectedBone]);
  return null;
};

/** The Skeleton panel's view of the selected model in the viewport: its bones, and what the picked one moves. */
export const SkeletonOverlay: React.FC<{ root: THREE.Object3D }> = ({ root }) => {
  const view = useSkeletonView();
  return (
    <>
      {view.showSkeleton && <SkeletonLines root={root} selectedBone={view.selectedBone} />}
      {view.showWeights && <WeightView root={root} selectedBone={view.selectedBone} />}
    </>
  );
};
