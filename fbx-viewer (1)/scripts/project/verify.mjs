import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const db = await readFile(resolve(root, 'utils/db.ts'), 'utf8');
const serializer = await readFile(resolve(root, 'utils/projectSerializer.ts'), 'utf8');
const service = await readFile(resolve(root, 'utils/projectService.ts'), 'utf8');
const header = await readFile(resolve(root, 'components/UI/Header.tsx'), 'utf8');
const modelManager = await readFile(resolve(root, 'hooks/useModelManager.ts'), 'utf8');
const persistence = await readFile(resolve(root, 'hooks/useScenePersistence.ts'), 'utf8');
const levels = await readFile(resolve(root, 'hooks/useLevelManager.ts'), 'utf8');
const projectManager = await readFile(resolve(root, 'hooks/useProjectManager.ts'), 'utf8');

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
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('frontend project boundary verification passed');
