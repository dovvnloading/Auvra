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
const attachments = await readFile(resolve(root, 'hooks/useAttachmentManager.ts'), 'utf8');
const sockets = await readFile(resolve(root, 'hooks/useSocketManager.ts'), 'utf8');
const levelContext = await readFile(resolve(root, 'context/LevelContext.tsx'), 'utf8');
const sceneContext = await readFile(resolve(root, 'context/SceneContext.tsx'), 'utf8');
const editorSessionSource = await readFile(resolve(root, 'utils/editorSession.ts'), 'utf8');
const projectManager = await readFile(resolve(root, 'hooks/useProjectManager.ts'), 'utf8');
const nativeDocument = await readFile(resolve(root, 'utils/useNativeProjectDocument.ts'), 'utf8');
const contentBrowser = await readFile(resolve(root, 'components/UI/Browser/ContentBrowser.tsx'), 'utf8');
const animationBinding = await readFile(resolve(root, 'utils/animationBinding.ts'), 'utf8');
const app = await readFile(resolve(root, 'App.tsx'), 'utf8');
const modelLoader = await readFile(resolve(root, 'utils/modelLoader.ts'), 'utf8');
const importWorker = await readFile(resolve(root, 'workers/fbxImport.worker.ts'), 'utf8');
const textureManager = await readFile(resolve(root, 'hooks/useTextureManager.ts'), 'utf8');
const operationContext = await readFile(resolve(root, 'context/OperationContext.tsx'), 'utf8');
const operationCenter = await readFile(resolve(root, 'components/UI/OperationCenter.tsx'), 'utf8');
const nativeTransport = await readFile(resolve(root, 'host/nativeTransport.ts'), 'utf8');
const diagnosticsRuntime = await readFile(resolve(root, 'diagnostics/runtime.ts'), 'utf8');
const environmentScene = await readFile(resolve(root, 'components/Environment/EnvironmentScene.tsx'), 'utf8');
const environmentEditor = await readFile(resolve(root, 'components/Environment/EnvironmentEditor.tsx'), 'utf8');
const environmentViewport = await readFile(resolve(root, 'components/Environment/EnvironmentViewport.tsx'), 'utf8');
const audioSystem = await readFile(resolve(root, 'components/Environment/AudioSystem.tsx'), 'utf8');
const blueprintRuntime = await readFile(resolve(root, 'hooks/useLevelBlueprintRuntime.ts'), 'utf8');

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
if (!/await projectService\.close\(contextFor\(handle\)\);\s*await resetScene\(\)/.test(projectManager)) failures.push('project close does not reset editor contexts in place');
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
if (/img\.onerror\s*=\s*\(\)\s*=>\s*\{[^}]*resolve\(\)/.test(textureManager)) failures.push('texture metadata decode failures are treated as successful imports');
if (!/request\.upload\.onprogress/.test(service) || !/XMLHttpRequest/.test(service)) failures.push('asset upload has no byte progress surface');
if (!/OperationProvider/.test(app) || !/OperationCenter/.test(app) || !/AbortController/.test(operationContext)) failures.push('global operation lifecycle is not mounted');
if (!/lockCancellation/.test(operationContext) || !/operation\.lockCancellation\(\)/.test(modelManager)) failures.push('safe import commit boundary is missing');
if (!/aria-live=["']polite["']/.test(operationCenter) || !/Cancel operation/.test(operationCenter)) failures.push('operation UI lacks accessible status or cancellation');
if (!/LONG_RUNNING_METHODS/.test(nativeTransport) || !/LONG_REQUEST_TIMEOUT_MS/.test(nativeTransport)) failures.push('long native operations retain the interactive request timeout');
if (!/hydrateSnapshot\(\s*snapshot,[\s\S]*?hydrationSignal,\s*activeDiagnostics/.test(persistence)) failures.push('project hydration does not propagate progress, cancellation, and trace context');
if (!/interface DetachedHydration/.test(persistence) || !/publishDetachedHydration/.test(persistence) || !/disposeDetachedHydration/.test(persistence)) failures.push('project hydration is not detached, atomically published, and stale-resource safe');
if (!/new AbortController\(\)/.test(persistence) || !/controller\.abort\(\)/.test(persistence) || !/editorSession\.beginTransition\(\)/.test(persistence)) failures.push('initial project hydration is not cancellable and transition-scoped');
if (!/transition \|\| undefined/.test(projectManager) || !/isTransitionCurrent\(transition\)/.test(projectManager)) failures.push('project-manager hydration does not carry exact transition identity through awaits');
if (!/expectedProjectId/.test(persistence) || !/expectedRevision/.test(persistence) || !/status\.projectId !== expectedProjectId/.test(persistence) || !/status\.revision !== expectedRevision/.test(persistence)) failures.push('hydration does not fence the exact project identity after awaits');
if (!/flushSync/.test(sceneContext) || !/commitHydration/.test(sceneContext)) failures.push('hydration replacement lacks an explicit atomic React commit');
if (!/useSyncExternalStore/.test(nativeDocument) || !/isCurrent\(lease\)/.test(nativeDocument) || !/status\.revision === lease\.revision/.test(nativeDocument)) failures.push('native document hydration/write lease is not exact and revision-scoped');
for (const phase of ['source_read', 'worker_creation', 'fbx_structure_parse', 'embedded_texture_decode', 'runtime_asset_construction', 'runtime_asset_transfer', 'viewport_materialization', 'material_optimization_normalization']) {
  if (!modelLoader.includes(`'${phase}'`) && !importWorker.includes(`'${phase}'`)) failures.push(`FBX diagnostic phase is missing from loader/worker: ${phase}`);
}
for (const phase of ['thumbnail_generation', 'animation_binding', 'project_upload', 'library_publication']) {
  if (!modelManager.includes(`'${phase}'`)) failures.push(`asset operation diagnostic phase is missing: ${phase}`);
}
if (!db.includes("'project_record_commit'")) failures.push('asset operation diagnostic phase is missing: project_record_commit');
if (!/assetDiagnosticAttributes/.test(modelManager) || !/nextAssetAlias/.test(modelManager) || !/traceId/.test(operationContext)) failures.push('asset aliases or operation trace identity are missing');
if (!/worker\.phase/.test(modelLoader) || !/worker\.failed/.test(modelLoader) || !/workerState/.test(modelLoader)) failures.push('worker lifecycle is not traced with stable state');
if (!/diagnostics:\s*traceAsset/.test(persistence) || !/animation_hydration_failed/.test(persistence)) failures.push('project-open FBX/animation hydration is not traced');
if (!/`\$\{traceId\}\.req-\$\{requestNumber\}`/.test(service)) failures.push('host request IDs are not correlated to the browser trace');
if (!/MAX_RECORDS\s*=\s*256/.test(diagnosticsRuntime) || !/MAX_BUFFER_BYTES\s*=\s*512\s*\*\s*1024/.test(diagnosticsRuntime) || !/MAX_BATCH_RECORDS\s*=\s*16/.test(diagnosticsRuntime)) failures.push('browser diagnostics bounds are missing');
if (!/HEARTBEAT_MS\s*=\s*1_000/.test(diagnosticsRuntime) || !/EVENT_LOOP_STALL_MS/.test(diagnosticsRuntime)) failures.push('browser heartbeat or event-loop stall detection is missing');
if (!/rotation:\s*\[o\.rotation\.x,\s*o\.rotation\.y,\s*o\.rotation\.z\]/.test(environmentScene)) failures.push('authored level rotation must persist as an exact Three.js XYZ Euler-radian tuple');
if (/rotation:\s*o\.rotation\.toArray\(\)/.test(environmentScene)) failures.push('Euler.toArray includes the order token and cannot be persisted as an exact-three rotation');
if (/rotation:\s*\[[\s\S]*?MathUtils\.radToDeg/.test(environmentScene)) failures.push('authored level rotation must not persist presentation degrees');
if (!/editorSession\.beginTransition\(\)/.test(projectManager) || !/editorSession\.(?:complete|close|fail)\(/.test(projectManager)) failures.push('project lifecycle is not fenced by the editor session transition');
const saveAsFlow = projectManager.match(/const saveProjectAs = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[[^\]]*\]\);/);
if (!saveAsFlow
  || !/projectService\.saveAs\([\s\S]*?isTransitionCurrent\(transition\)[\s\S]*?await hydrate\(handle,[^\n]*transition\)/.test(saveAsFlow[1])) {
  failures.push('Save As can publish a replacement project session without hydrating its working state');
}
if (!/requireWritable\(lease, projectService\.getStatus\(\)\)/.test(db)) failures.push('queued level persistence does not revalidate exact editor project identity');
if (!/dbOperations\.(?:add|update|delete)LevelObject\([^\n]*lease\)/.test(levels) || !/session\.beginTransition\(\)/.test(levels)) failures.push('level mutations or level changes bypass the editor session lease');
if (!/useSyncExternalStore\(editorSession\.subscribe/.test(environmentEditor) || !/Open a project to edit the world/.test(environmentEditor)) failures.push('World Editor does not remain mounted behind a visible session barrier');
if (!/getAllNativeLevelObjects/.test(db) || !/getAllNativeLevelObjects/.test(levels)) failures.push('native level switching does not read the complete authoritative objects domain');
if (!/interface LevelWorkingState/.test(levels) || !/setWorkingState\(prev => \(\{ \.\.\.prev, levelObjects:/.test(levels)) failures.push('level manager lacks one atomic working-state publication boundary');
if (/setLevelObjects/.test(levels) || /setLevelObjects/.test(levelContext) || /setLevelObjects:\s*level\.setLevelObjects/.test(sceneContext)) failures.push('redundant direct level-object setter remains exposed to hydration');
if (!/selectObjectsForLevel/.test(editorSessionSource) || !/isTransitionCurrent\(transition/.test(editorSessionSource)) failures.push('level transition lacks pure exact selection and token guards');
if (!/let assetFailureCount = 0/.test(persistence)
  || !/if \(assetFailureCount > 0\)[\s\S]*?throw new Error\(`Project hydration failed/.test(persistence)) {
  failures.push('project hydration still publishes success after partial asset failure');
}
for (const [source, label] of [[attachments, 'attachment'], [sockets, 'socket']]) {
  if (!/EditorSessionLease/.test(source) || !/captureReady\(\)/.test(source)
    || !/requireWritable\(editorSession\.captureReady\(\), projectService\.getStatus\(\)\)/.test(source)
    || !/isSameSession\(pending\.lease\)/.test(source)
    || !/pendingUpdatesRef\.current\.clear\(\)/.test(source)) {
    failures.push(`${label} debounced writes are not project-session fenced`);
  }
}
if (!/enableAudio\?: boolean/.test(environmentScene) || !/enableAudio && <AudioSystem/.test(environmentScene)
  || (environmentViewport.match(/enableAudio=\{false\}/g) || []).length !== 3
  || !/viewId="left"[\s\S]*?enableAudio/.test(environmentViewport)
  || !/sourcesRef\.current\.get\(obj\.id\) !== createdSound/.test(audioSystem)
  || !/sourceAssetIdMap\.current\.get\(obj\.id\) !== createdAssetId/.test(audioSystem)) {
  failures.push('quad environment view does not own exactly one identity-safe audio system');
}
if (!/MAX_BLUEPRINT_EVALUATION_DEPTH/.test(blueprintRuntime)
  || !/MAX_BLUEPRINT_EXECUTION_DEPTH/.test(blueprintRuntime)
  || !/path\.has\(pathKey\)/.test(blueprintRuntime)
  || !/path\.has\(nodeId\)/.test(blueprintRuntime)
  || !/const b = Number\(evaluate\([\s\S]*?\?\? 0\)/.test(blueprintRuntime)
  || !/b !== 0 \? a \/ b : 0/.test(blueprintRuntime)) {
  failures.push('blueprint runtime lacks bounded cycle-safe evaluation and execution');
}

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

const bundledSession = await build({
  entryPoints: [resolve(root, 'utils/editorSession.ts')],
  bundle: true,
  minify: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  write: false,
});
const sessionModule = await import(`data:text/javascript;base64,${Buffer.from(bundledSession.outputFiles[0].contents).toString('base64')}`);
const session = new sessionModule.EditorSessionOwner();
const sessionNotifications = [];
const unsubscribe = session.subscribe(() => sessionNotifications.push(session.getSnapshot()));
const firstTransition = session.beginTransition();
if (session.getSnapshot().phase !== 'transitioning' || session.getSnapshot().generation !== firstTransition.generation
  || !Object.isFrozen(session.getSnapshot()) || !Object.isFrozen(firstTransition)) {
  failures.push('editor session transition is not synchronous and generation-scoped');
}
const firstLease = session.complete(firstTransition, 'project-a', 'level-a', 7);
if (!firstLease || !session.isCurrent(firstLease) || !Object.isFrozen(firstLease)) failures.push('current editor session completion was not accepted as an immutable lease');
const advancedLease = session.advanceRevision('project-a', 8);
if (!advancedLease || advancedLease.revision !== 8 || !session.isCurrent(advancedLease)
  || session.advanceRevision('project-b', 9) !== null || session.advanceRevision('project-a', 7) !== null) {
  failures.push('ready editor session revision was not advanced only for the current project');
}
if (session.isCurrent(firstLease) || !session.isSameSession(firstLease)) failures.push('revision advance did not invalidate exact work while preserving session identity');
let staleWriteRejected = false;
try { session.requireWritable(firstLease, { projectId: 'project-a', revision: 8 }); } catch { staleWriteRejected = true; }
let replacementWriteRejected = false;
try { session.requireWritable(advancedLease, { projectId: 'project-b', revision: 8 }); } catch { replacementWriteRejected = true; }
if (!staleWriteRejected || !replacementWriteRejected
  || session.requireWritable(advancedLease, { projectId: 'project-a', revision: 8 }) !== advancedLease) {
  failures.push('editor session write gate accepted stale revision or replacement project identity');
}
const secondTransition = session.beginTransition();
if (session.isCurrent(firstLease) || session.complete(firstTransition, 'stale', 'stale', 8) !== null) failures.push('stale editor session lease/completion was accepted after transition');
if (session.complete({ generation: secondTransition.generation }, 'forged', 'level', 9) !== null) failures.push('forged editor session transition was accepted');
const secondLease = session.complete(secondTransition, 'project-b', 'level-b', 9);
if (!secondLease || !session.isCurrent(secondLease)) failures.push('current editor session completion was rejected');
if (session.isCurrent({ ...secondLease, projectId: 'wrong-project' })
  || session.isCurrent({ ...secondLease, generation: secondLease.generation - 1 })
  || session.isCurrent({ ...secondLease, levelId: 'wrong-level' })
  || session.isCurrent({ ...secondLease, revision: 10 })
  || session.isCurrent({ ...secondLease, phase: 'closed' })) failures.push('editor session accepted a lease identity mismatch');
let requireRejected = false;
try { session.requireCurrent({ ...secondLease, revision: 10 }); } catch { requireRejected = true; }
if (!requireRejected) failures.push('editor session requireCurrent accepted mismatched identity');
unsubscribe();
unsubscribe();
const notificationsBeforeUnsubscribedTransition = sessionNotifications.length;
session.beginTransition();
if (sessionNotifications.length !== notificationsBeforeUnsubscribedTransition) failures.push('editor session unsubscribe was not idempotent');
const failedTransition = session.beginTransition();
if (session.fail(failedTransition)?.phase !== 'closed' || session.getSnapshot().generation !== failedTransition.generation) failures.push('editor session failure did not close the current generation');
if (session.complete(failedTransition, 'resurrected', 'level', 11) !== null || session.getSnapshot().phase !== 'closed') failures.push('failed editor session resurrected stale identity');
const levelCycleSession = new sessionModule.EditorSessionOwner();
const levelObjects = [
  { id: 'shared', levelId: 'level-a1' },
  { id: 'a2-only', levelId: 'level-a2' },
  { id: 'a1-reused', levelId: 'level-a1' },
];
const a1Selection = sessionModule.selectObjectsForLevel(levelObjects, 'level-a1');
const a2Selection = sessionModule.selectObjectsForLevel(levelObjects, 'level-a2');
const a1AgainSelection = sessionModule.selectObjectsForLevel(levelObjects, 'level-a1');
const exactLevelCycle = [a1Selection, a2Selection, a1AgainSelection].map((objects) => objects.map(({ id, levelId }) => ({ id, levelId })));
if (a1Selection.map((object) => object.id).join(',') !== 'shared,a1-reused'
  || a2Selection.map((object) => object.id).join(',') !== 'a2-only'
  || a1AgainSelection.map((object) => object.id).join(',') !== 'shared,a1-reused'
  || JSON.stringify(exactLevelCycle) !== JSON.stringify([
    [{ id: 'shared', levelId: 'level-a1' }, { id: 'a1-reused', levelId: 'level-a1' }],
    [{ id: 'a2-only', levelId: 'level-a2' }],
    [{ id: 'shared', levelId: 'level-a1' }, { id: 'a1-reused', levelId: 'level-a1' }],
  ])
  || sessionModule.selectObjectsForLevel(levelObjects, 'empty').length !== 0) {
  failures.push('A1 to A2 to A1 did not restore the exact active object set');
}
const levelA1 = levelCycleSession.beginTransition();
const levelA1Lease = levelCycleSession.complete(levelA1, 'project-a', 'level-a1', 1);
const levelA2 = levelCycleSession.beginTransition();
const levelA2Lease = levelCycleSession.complete(levelA2, 'project-a', 'level-a2', 2);
const levelA1Again = levelCycleSession.beginTransition();
const levelA1AgainLease = levelCycleSession.complete(levelA1Again, 'project-a', 'level-a1', 3);
if (!levelA1Lease || !levelA2Lease || !levelA1AgainLease
  || levelA1.generation === levelA2.generation || levelA2.generation === levelA1Again.generation
  || levelA1AgainLease.levelId !== 'level-a1' || !levelCycleSession.isCurrent(levelA1AgainLease)) {
  failures.push('A1 to A2 to A1 did not create distinct truthful level generations');
}
const delayedSession = new sessionModule.EditorSessionOwner();
const delayedA = delayedSession.beginTransition();
const delayedALease = delayedSession.complete(delayedA, 'project-a', 'shared-level', 1);
let releaseDelayedWrite;
const delayedWriteGate = new Promise((resolve) => { releaseDelayedWrite = resolve; });
let delayedWritePublished = false;
let delayedWriteMutations = 0;
const delayedWrite = (async () => {
  await delayedWriteGate;
  delayedSession.requireWritable(delayedALease, { projectId: 'project-b', revision: 1 });
  delayedWriteMutations += 1;
  delayedWritePublished = true;
})();
const delayedB = delayedSession.beginTransition();
const delayedBLease = delayedSession.complete(delayedB, 'project-b', 'shared-level', 1);
releaseDelayedWrite();
await delayedWrite.catch(() => undefined);
if (!delayedBLease || delayedWritePublished || delayedWriteMutations !== 0) failures.push('delayed project-A write published into replacement project B with a reused level id');

// Exercise the detached hydration disposer itself.  The duplicate URL is
// intentional: ownership must be set-based, and every temporary resource must
// be released exactly once when the stale result is discarded.
const disposerMatch = persistence.match(/const disposeDetachedHydration = \(state: DetachedHydration\): void => \{([\s\S]*?)\};/);
if (!disposerMatch) failures.push('detached hydration disposer could not be exercised');
else {
  const disposalCalls = { models: 0, objects: 0, urls: [], textures: 0 };
  const disposeDetached = new Function('disposeModel', 'disposeObject', 'URL',
    `return (state) => {${disposerMatch[1].replaceAll('new Set<string>', 'new Set')}};`)(
      () => { disposalCalls.models += 1; },
      () => { disposalCalls.objects += 1; },
      { revokeObjectURL: (url) => disposalCalls.urls.push(url) },
    );
  const staleTexture = { dispose: () => { disposalCalls.textures += 1; } };
  const staleHydration = {
    models: [{}],
    attachments: [{ object: {}, url: 'blob:shared' }],
    ownedUrls: new Set(['blob:shared', 'blob:model']),
    standaloneTextures: new Set([staleTexture]),
  };
  let stalePublications = 0;
  const staleHydrationSession = new sessionModule.EditorSessionOwner();
  const staleTransition = staleHydrationSession.beginTransition();
  const staleLease = staleHydrationSession.complete(staleTransition, 'project-a', 'shared-level', 1);
  let releaseStaleHydration;
  const staleHydrationGate = new Promise((resolve) => { releaseStaleHydration = resolve; });
  const delayedSnapshot = (async () => {
    await staleHydrationGate;
    if (staleHydrationSession.isCurrent(staleLease)) stalePublications += 1;
    else disposeDetached(staleHydration);
  })();
  const replacementTransition = staleHydrationSession.beginTransition();
  staleHydrationSession.complete(replacementTransition, 'project-b', 'shared-level', 1);
  releaseStaleHydration();
  await delayedSnapshot;
  if (stalePublications !== 0 || disposalCalls.models !== 1 || disposalCalls.objects !== 1 || disposalCalls.textures !== 1
    || disposalCalls.urls.length !== 2 || new Set(disposalCalls.urls).size !== 2) {
    failures.push('stale snapshot/asset hydration published or failed exact-once temporary-resource disposal');
  }
}

// StrictMode performs setup/cleanup/setup synchronously.  The first setup's
// completion must be rejected after cleanup, while the second setup remains
// the only publishable generation.
const strictModeSession = new sessionModule.EditorSessionOwner();
const strictSetup = strictModeSession.beginTransition();
const strictCleanup = strictModeSession.fail(strictSetup);
const strictSetupAgain = strictModeSession.beginTransition();
if (strictCleanup?.phase !== 'closed'
  || strictModeSession.complete(strictSetup, 'strict-stale', 'shared-level', 1) !== null
  || !strictModeSession.complete(strictSetupAgain, 'project-a', 'shared-level', 2)
  || strictModeSession.getSnapshot().generation !== strictSetupAgain.generation
  || strictModeSession.getSnapshot().projectId !== 'project-a') {
  failures.push('StrictMode setup/cleanup/setup accepted stale hydration or lost the current generation');
}

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
