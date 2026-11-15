import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { fireEvent, screen, waitFor } from '@testing-library/dom';
import { AuvraCanvas } from '../../../renderer/AuvraCanvas';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { AutoRigPanel } from '../../../components/UI/Properties/AutoRigPanel';
import { RigMarkers } from '../../../components/Scene/RigMarkers';
import { RigPreview } from '../../../components/Scene/RigPreview';
import { getRigPreview, useRigSession, type RigSessionState } from '../../../utils/autoRig/rigSession';
import type { LoadedModelData } from '../../../types';
import { setTestProject } from './project';
import '../../../styles.css';

// Bake a skinless copy of the shipped Outpost Ranger. The rig under test never sees the authored bones.
async function characterFile(): Promise<File> {
  const location = new URL('../../../../Auvra/project/templates/outpost/assets/ranger.fbx', import.meta.url);
  const original = new FBXLoader().parse(await (await fetch(location)).arrayBuffer(), '');
  original.updateMatrixWorld(true);
  const flat = new THREE.Group();
  const point = new THREE.Vector3();
  original.traverse(node => {
    const mesh = node as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach((material, index) => {
      const positions: number[] = [];
      for (const group of mesh.geometry.groups.filter(group => group.materialIndex === index)) {
        for (let i = group.start; i < group.start + group.count; i++) {
          mesh.getVertexPosition(mesh.geometry.index?.getX(i) ?? i, point).applyMatrix4(mesh.matrixWorld).multiplyScalar(0.01);
          positions.push(point.x, point.y, point.z);
        }
      }
      const corners = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const geometry = mergeVertices(corners);
      geometry.computeVertexNormals();
      const part = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: (material as THREE.MeshPhongMaterial).color }));
      part.name = material.name;
      flat.add(part);
    });
  });
  const bytes = await new GLTFExporter().parseAsync(flat, { binary: true }) as ArrayBuffer;
  return new File([bytes], 'Ranger.glb', { type: 'model/gltf-binary' });
}

function skinStats(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  let vertices = 0, meshes = 0, influences = 0, weightError = 0, displacement = 0, colored = 0;
  const point = new THREE.Vector3(), rest = new THREE.Vector3();
  root.traverse(node => {
    const mesh = node as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    meshes++;
    const { position, skinWeight, color } = mesh.geometry.attributes;
    if (color && (mesh.material as THREE.MeshBasicMaterial).vertexColors) colored++;
    for (let i = 0; i < position.count; i++) {
      vertices++;
      mesh.getVertexPosition(i, point);
      displacement = Math.max(displacement, point.distanceTo(rest.fromBufferAttribute(position, i)));
      const weights = [skinWeight.getX(i), skinWeight.getY(i), skinWeight.getZ(i), skinWeight.getW(i)];
      influences = Math.max(influences, weights.filter(w => w > 0).length);
      weightError = Math.max(weightError, Math.abs(weights.reduce((a, b) => a + b) - 1));
    }
  });
  return { meshes, vertices, influences, weightError, displacement, colored };
}

const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
let session: RigSessionState;
function Observer() { session = useRigSession(); return null; }
const stage = async (value: RigSessionState['stage']) => waitFor(() => {
  check(session.stage === value, session.error ?? `Expected ${value}, current stage ${session.stage}`);
}, { timeout: 90_000, onTimeout: error => error });
const click = (name: string, role = 'button') => flushSync(() => fireEvent.click(screen.getByRole(role, { name })));
const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

async function start() {
  const file = await characterFile();
  const root = (await new GLTFLoader().parseAsync(await file.arrayBuffer(), '')).scene;
  const model: LoadedModelData = { id: 'ranger', name: file.name, url: '', category: 'Character', object: root, animations: [], isPlacedInScene: true };
  let saved: THREE.Object3D | undefined;
  setTestProject({
    readModelSource: async () => file, readModelSourceImages: async () => [], placeInScene: async () => {},
    reimportModel: async (id, result) => {
      check(id === model.id && result && !saved, 'Unexpected project write');
      saved = (await new GLTFLoader().parseAsync(await result!.arrayBuffer(), '')).scene;
      return true;
    },
  });
  createRoot(document.getElementById('root')!).render(
    <main className="editor-shell" style={{ display: 'grid', height: '100%', gridTemplateColumns: 'minmax(0,1fr) 336px' }}>
      <AuvraCanvas surfaceId={`visual-rig-${model.id}`} role="reference" backend="webgl2" camera={{ position: [0, 1, 3], fov: 42 }} dpr={1}>
        <color attach="background" args={['#24262c']} /><hemisphereLight intensity={2.2} /><directionalLight position={[2, 4, 3]} intensity={2} />
        <gridHelper args={[12, 48, '#515359', '#34363a']} />
        <primitive object={root} /><RigMarkers modelId={model.id} root={root} /><RigPreview modelId={model.id} root={root} />
        <OrbitControls makeDefault target={[0, 0.9, 0]} />
      </AuvraCanvas>
      <aside className="flex min-h-0 flex-col bg-panel"><AutoRigPanel model={model} /><Observer /></aside>
    </main>,
  );
  await screen.findByRole('button', { name: 'Analyze mesh' });
  const preview = () => getRigPreview(model.id, root)!.model.object;
  return {
    async fit() {
      click('Analyze mesh'); await stage('placing'); click('Cancel'); await stage('idle');
      click('Analyze mesh'); await stage('placing');
      flushSync(() => fireEvent.change(screen.getByLabelText('Selected guide'), { target: { value: 'leftWrist' } }));
      const height = screen.getByLabelText('Guide height') as HTMLInputElement;
      const before = Number(height.value);
      height.focus();
      flushSync(() => fireEvent.change(height, { target: { value: String(before + 0.025) } }));
      flushSync(() => height.blur());
      await waitFor(() => check(session.editedGuides.includes('rightWrist'), 'Mirrored guide did not move'));
      click('Undo guide edit'); await waitFor(() => check(!session.editedGuides.length, 'Undo did not restore guides'));
      click('Redo guide edit'); click('2', 'radio'); click('Soft', 'radio'); await nextFrame();
    },
    async bind() {
      click('Bind & preview'); await stage('review'); await nextFrame();
      const stats = skinStats(preview());
      check(!saved && !root.visible && stats.meshes === 8 && stats.vertices > 3000 && stats.influences === 2 &&
        stats.weightError < 1e-6 && stats.displacement < 1e-5, `Invalid preview: ${JSON.stringify(stats)}`);
      return stats;
    },
    async pose() {
      click('Flex', 'radio'); fireEvent.change(screen.getByLabelText('Inspect skin weights'), { target: { value: 'LeftForeArm' } });
      await nextFrame();
      const stats = skinStats(preview());
      check(stats.colored === stats.meshes && stats.displacement > 0.02, `Pose and weight display: ${JSON.stringify(stats)}`);
      return stats;
    },
    async apply() {
      click('Apply rig'); await stage('idle'); await nextFrame();
      const stats = skinStats(saved!);
      check(root.visible && stats.meshes === 8 && stats.vertices > 3000 && stats.influences === 2 &&
        stats.weightError < 1e-6 && stats.displacement < 1e-5 && !stats.colored, `Invalid saved GLB: ${JSON.stringify(stats)}`);
      return stats;
    },
  };
}
Object.assign(window, { rigWorkflow: start() });
