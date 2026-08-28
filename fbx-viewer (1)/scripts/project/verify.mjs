import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as THREE from 'three';

const root = fileURLToPath(new URL('../..', import.meta.url));
const db = await readFile(resolve(root, 'utils/db.ts'), 'utf8');
const serializer = await readFile(resolve(root, 'utils/projectSerializer.ts'), 'utf8');
const service = await readFile(resolve(root, 'utils/projectService.ts'), 'utf8');
const header = await readFile(resolve(root, 'components/UI/Header.tsx'), 'utf8');
const modelManager = await readFile(resolve(root, 'hooks/useModelManager.ts'), 'utf8');
const persistence = await readFile(resolve(root, 'hooks/useScenePersistence.ts'), 'utf8');
const levels = await readFile(resolve(root, 'hooks/useLevelManager.ts'), 'utf8');
const projectManager = await readFile(resolve(root, 'hooks/useProjectManager.ts'), 'utf8');
const contentBrowser = await readFile(resolve(root, 'components/UI/Browser/ContentBrowser.tsx'), 'utf8');
const animationBinding = await readFile(resolve(root, 'utils/animationBinding.ts'), 'utf8');
const app = await readFile(resolve(root, 'App.tsx'), 'utf8');
const modelLoader = await readFile(resolve(root, 'utils/modelLoader.ts'), 'utf8');
const importWorker = await readFile(resolve(root, 'workers/fbxImport.worker.ts'), 'utf8');
const operationContext = await readFile(resolve(root, 'context/OperationContext.tsx'), 'utf8');
const operationCenter = await readFile(resolve(root, 'components/UI/OperationCenter.tsx'), 'utf8');
const nativeTransport = await readFile(resolve(root, 'host/nativeTransport.ts'), 'utf8');

const failures = [];
const mustNotContain = (text, pattern, label) => { if (pattern.test(text)) failures.push(`${label}: forbidden ${pattern}`); };
mustNotContain(db, /readwrite|createObjectStore|deleteObjectStore|deleteDatabase|\.put\(|\.clear\(/, 'legacy IndexedDB adapter');
mustNotContain(serializer, /jszip|file-saver|saveAs|new Blob|<input/i, 'project serializer');
mustNotContain(header, /accept=["']\.forge|type=["']file|FileSaver|saveAs/i, 'project controls');
mustNotContain(service, /beginAssetUpload\(assetId|sha256\s*[,}]/, 'asset upload precomputed identity');
mustNotContain(service, /fetch\([^)]*assets\.auvra\.local[^)]*\{[^}]*method:\s*['"](?!GET|PUT)/i, 'asset transport method');
for (const method of ['project.create', 'project.open', 'project.openRecent', 'project.close', 'project.getSnapshot', 'project.applyChanges', 'project.save', 'project.saveAs', 'project.exportPack', 'project.importPack', 'project.importLegacy', 'asset.beginUpload', 'asset.resolve']) {
  if (!service.includes(`'${method}'`)) failures.push(`project service: missing ${method}`);
}
for (const token of ['expectedRevision', 'documentId', 'blob', 'data', 'file']) {
  if (!service.includes(token)) failures.push(`project service: missing boundary check ${token}`);
}
if (!/auvra\\\.local/.test(service)) failures.push('project service: missing asset origin check');
if (!/X-Auvra-Asset-Sha256/.test(service)) failures.push('project service: missing host-issued asset identity');
if (!/getSnapshotAll/.test(service) || !/page\.hasMore/.test(service)) failures.push('project service: missing bounded snapshot pagination');
if (/canonicalChange\(['"]levelObjects/.test(db)) failures.push('native project writes must use the objects domain; levelObjects is legacy-only');
if (!/v1\\\/get\\\//.test(service) || !/recoveryPoints/.test(service)) failures.push('project service: missing exact resolve/recovery handling');
if (!/requestQueue/.test(service) || !/performCall/.test(service)) failures.push('project service: host calls must be serialized');
if (/class\s+Sha256|hashBlob|readAsDataURL/.test(service)) failures.push('project service: browser-side asset hashing or encoding remains');
if (!/addModelTextureOverride/.test(db) || !/textureOverrides\[materialName\]\s*=\s*textureId/.test(db)) failures.push('material overrides must reference native texture documents');
if (/newOverrides\[m\.name\]\s*=\s*textureUrl|textureOverrides[^\n]*Base64/.test(modelManager)) failures.push('model manager still persists temporary texture URLs');
if (!/textureAssetUrls/.test(persistence) || !/loadProjectAssetUrl/.test(persistence)) failures.push('native texture overrides are not hydrated through asset tickets');
if (!/getSnapshotAll\(\)/.test(db) || !/record\.levelId === id/.test(db)) failures.push('referential delete cascades are missing');
if (!/migrateLegacyDatabase/.test(db) || !/readOnlyStorePages/.test(db) || !/requires an empty native project/.test(db)) failures.push('read-only paged browser migration bridge is missing');
if (!/Browser data/.test(header) || !/migrateLegacyBrowserProject/.test(header)) failures.push('browser migration is not exposed through native project controls');
for (const domain of ['metadata', 'worlds', 'scenes', 'levels', 'objects', 'environment', 'models', 'animations', 'attachments', 'sockets', 'textures', 'audio', 'materials', 'blueprints', 'graphs', 'hud']) {
  if (!persistence.includes(`'${domain}'`)) failures.push(`native hydration inventory is missing ${domain}`);
}
if (!/!projectService\.getStatus\(\)\.projectId/.test(levels)) failures.push('level manager can still replace native state from legacy storage');
if (!/await projectService\.close\(\);\s*await resetScene\(\)/.test(projectManager)) failures.push('project close does not reset editor contexts in place');
if (!/category === 'Animation'[\s\S]*selectAnimationTarget\(models, selectedModelId\)[\s\S]*addAnimations\(files, target\.id\)/.test(contentBrowser)) failures.push('Library animation import is not routed to the selected skeletal model');
if (!/prepareAnimationClips\(targetModel\.object, loaded\.object, loaded\.animations\)/.test(modelManager)) failures.push('animation import bypasses target skeleton binding');
if (!/prepareAnimationClips\(loaded\.object, animationModel\.object, animationModel\.animations\)/.test(persistence)) failures.push('native project hydration bypasses target skeleton binding');
if (!/setActiveClip\(selectedAnimations\[0\] \|\| null\)/.test(app)) failures.push('valid imported animation is not selected for preview');
if (!/retargetClip/.test(animationBinding) || !/clipBindsDirectly/.test(animationBinding)) failures.push('animation binding lacks direct and retargeted paths');
if (/clip\.duration > 0\.1/.test(modelLoader) || !/clip\.duration > 0/.test(modelLoader)) failures.push('valid short animation clips are still discarded');
if (!/new Worker\(new URL\(['"]\.\.\/workers\/fbxImport\.worker\.ts['"]/.test(modelLoader)) failures.push('FBX import is not isolated in a module worker');
if (/import\s*\{\s*FBXLoader\s*\}/.test(modelLoader)) failures.push('renderer model loader still imports FBXLoader directly');
if (!/new FBXLoader\(\)\.parse/.test(importWorker) || !/new GLTFExporter\(\)\.parseAsync/.test(importWorker)) failures.push('FBX worker does not own parse and transient runtime conversion');
if (!/signal\?\.addEventListener\(['"]abort/.test(modelLoader) || !/worker\.terminate\(\)/.test(modelLoader)) failures.push('FBX worker cancellation or teardown is missing');
if (!/request\.upload\.onprogress/.test(service) || !/XMLHttpRequest/.test(service)) failures.push('asset upload has no byte progress surface');
if (!/OperationProvider/.test(app) || !/OperationCenter/.test(app) || !/AbortController/.test(operationContext)) failures.push('global operation lifecycle is not mounted');
if (!/lockCancellation/.test(operationContext) || !/operation\.lockCancellation\(\)/.test(modelManager)) failures.push('safe import commit boundary is missing');
if (!/aria-live=["']polite["']/.test(operationCenter) || !/Cancel operation/.test(operationCenter)) failures.push('operation UI lacks accessible status or cancellation');
if (!/LONG_RUNNING_METHODS/.test(nativeTransport) || !/LONG_REQUEST_TIMEOUT_MS/.test(nativeTransport)) failures.push('long native operations retain the interactive request timeout');
if (!/hydrateSnapshot\(snapshot,[\s\S]*?\}, report, signal\)/.test(persistence)) failures.push('project hydration does not propagate progress and cancellation');

const bundledBinding = await build({
  entryPoints: [resolve(root, 'utils/animationBinding.ts')],
  bundle: true,
  minify: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  write: false,
});
const bindingModule = await import(`data:text/javascript;base64,${Buffer.from(bundledBinding.outputFiles[0].contents).toString('base64')}`);

const rig = (names) => {
  const root = new THREE.Group();
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  const rigBones = names.map((name) => { const bone = new THREE.Bone(); bone.name = name; return bone; });
  for (let index = 1; index < rigBones.length; index += 1) rigBones[index - 1].add(rigBones[index]);
  mesh.add(rigBones[0]);
  mesh.bind(new THREE.Skeleton(rigBones));
  root.add(mesh);
  root.updateMatrixWorld(true);
  return root;
};
const quaternionValues = [0, 0, 0, 1, 0, 0, Math.SQRT1_2, Math.SQRT1_2];
const exactTarget = rig(['Hips', 'Spine']);
const exactSource = rig(['Hips', 'Spine']);
const directClip = new THREE.AnimationClip('Direct', 1, [
  new THREE.QuaternionKeyframeTrack('Hips.quaternion', [0, 1], quaternionValues),
]);
const direct = bindingModule.prepareAnimationClips(exactTarget, exactSource, [directClip]);
if (direct.mode !== 'direct' || direct.clips.length !== 1 || direct.clips[0] === directClip) failures.push('exact skeleton clips are not cloned through direct binding');

const prefixedSource = rig(['mixamorigHips', 'mixamorigSpine']);
const prefixedClip = new THREE.AnimationClip('Retargeted', 1, [
  new THREE.QuaternionKeyframeTrack('mixamorigHips.quaternion', [0, 1], quaternionValues),
  new THREE.QuaternionKeyframeTrack('mixamorigSpine.quaternion', [0, 1], quaternionValues),
]);
const retargeted = bindingModule.prepareAnimationClips(exactTarget, prefixedSource, [prefixedClip]);
if (retargeted.mode !== 'retargeted' || retargeted.clips.length !== 1 || retargeted.clips[0].tracks.length < 2) failures.push('compatible namespaced skeletons are not retargeted');

const targetModel = { id: 'target', name: 'Target', category: 'Character', object: exactTarget };
if (bindingModule.selectAnimationTarget([targetModel], null) !== targetModel) failures.push('single skeletal model is not selected as the animation target');
let ambiguousTargetRejected = false;
try { bindingModule.selectAnimationTarget([targetModel, { ...targetModel, id: 'other', name: 'Other', object: rig(['Hips']) }], null); }
catch { ambiguousTargetRejected = true; }
if (!ambiguousTargetRejected) failures.push('ambiguous animation target was silently selected');

let incompatibleRejected = false;
try {
  const incompatible = rig(['Wing']);
  const incompatibleClip = new THREE.AnimationClip('Invalid', 1, [new THREE.QuaternionKeyframeTrack('Wing.quaternion', [0, 1], quaternionValues)]);
  bindingModule.prepareAnimationClips(exactTarget, incompatible, [incompatibleClip]);
} catch { incompatibleRejected = true; }
if (!incompatibleRejected) failures.push('incompatible animation skeleton was accepted');

if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('frontend project boundary verification passed');
