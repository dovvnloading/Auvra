import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..', '..');
const ignoredDirectories = new Set(['dist', 'node_modules', 'scripts', 'tests']);
const generatedPrefixes = ['host/generated/'];

// These modules are intentionally observed through a parent boundary. The list
// is exact so a new runtime module cannot silently inherit an exemption.
const EXEMPT = new Map(Object.entries({
  'components/AnimationGraph/hooks/useAnimationMixer.ts': 'hot-loop',
  'components/AnimationGraph/GraphRuntime.tsx': 'hot-loop-controller',
  'components/AnimationGraph/hooks/useGraphAnimator.ts': 'hot-loop',
  'components/AnimationGraph/hooks/useGraphConnections.ts': 'pure-derived-state',
  'components/AnimationGraph/hooks/useGraphContext.ts': 'context-adapter',
  'components/AnimationGraph/hooks/useGraphLocomotion.ts': 'hot-loop',
  'components/AnimationGraph/hooks/useGraphNodeDrag.ts': 'input-adapter',
  'components/AnimationGraph/hooks/useGraphRuntime.ts': 'hot-loop',
  'components/AnimationGraph/hooks/useGraphViewport.ts': 'input-adapter',
  'components/AnimationGraph/hooks/useInputHandler.ts': 'input-adapter',
  'components/AnimationGraph/utils/graphMath.ts': 'pure-utility',
  'components/Environment/hooks/useEnvironmentHotkeys.ts': 'input-adapter',
  'components/Environment/AudioSystem.tsx': 'hot-loop-controller',
  'components/Environment/types.ts': 'data-model',
  'components/HUDEditor/types.ts': 'data-model',
  'components/Sandbox/AIController.tsx': 'hot-loop-controller',
  'components/Sandbox/CharacterCameraRig.tsx': 'hot-loop-controller',
  'components/Sandbox/PlayerController.tsx': 'hot-loop-controller',
  'components/Scene/AttachmentController.tsx': 'render-controller',
  'components/UI/GlobalLoader.tsx': 'deprecated-noop',
  'components/Sandbox/AI/AIConfig.ts': 'data-model',
  'components/Sandbox/AI/AISenses.ts': 'hot-loop',
  'components/Sandbox/AI/AIStateMachine.ts': 'hot-loop',
  'components/Sandbox/AI/useAIBrain.ts': 'hot-loop',
  'components/Sandbox/AI/useAILocomotion.ts': 'hot-loop',
  'components/Sandbox/hooks/useDamageFlash.ts': 'hot-loop',
  'components/Sandbox/hooks/useEntityHealth.ts': 'hot-loop',
  'components/Sandbox/hooks/usePlayerCombat.ts': 'input-adapter',
  'components/Sandbox/hooks/usePlayerControls.ts': 'input-adapter',
  'components/Sandbox/hooks/usePlayerPhysics.ts': 'hot-loop',
  'components/Sandbox/hooks/useSandboxConfiguration.ts': 'pure-derived-state',
  'data/blueprints/enemy.ts': 'data-model',
  'data/blueprints/index.ts': 'data-model',
  'data/blueprints/player.ts': 'data-model',
  'host/index.ts': 'protocol-model',
  'host/fakeHost.ts': 'development-host',
  'host/protocol.ts': 'protocol-model',
  'host/transport.ts': 'protocol-model',
  'host/webview2.d.ts': 'type-declaration',
  'types.ts': 'data-model',
  'hud-frame.tsx': 'sandbox-proxy',
  'renderer/capabilities.ts': 'renderer-child-boundary',
  'renderer/contracts.ts': 'data-model',
  'renderer/conventions.ts': 'renderer-child-boundary',
  'renderer/nativeReference.ts': 'renderer-child-boundary',
  'renderer/referenceScenes.ts': 'data-model',
  'renderer/registry.ts': 'renderer-child-boundary',
  'renderer/renderGraph.ts': 'renderer-child-boundary',
  'utils/animationBinding.ts': 'pure-utility',
  'utils/domainCascade.ts': 'event-boundary',
  'utils/editorSession.ts': 'pure-utility',
  'utils/editorState.ts': 'data-model',
  'utils/processing/ModelMaterials.ts': 'import-child-phase',
  'utils/processing/ModelTransforms.ts': 'import-child-phase',
  'utils/textureUtils.ts': 'pure-utility',
  'utils/thumbnailGenerator.ts': 'import-child-phase',
  'workers/fbxImport.worker.ts': 'worker-protocol',
}));

const files = [];
const walk = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(absolute);
  }
};
walk(root);

const REQUIRED_EVIDENCE = new Map([
  ['diagnostics/runtime.ts', ['startSpan(', 'wrap<T', 'instrumentClass(', 'traceActions<T', 'recordRenderCommit(']],
  ['diagnostics/RuntimeDiagnosticsBoundary.tsx', ['componentDidCatch(', '<React.Profiler']],
  ['context/OperationContext.tsx', ['spanId:', "startSpan('operation'", 'rootSpan.context']],
  ['host/nativeTransport.ts', ["startSpan('host'", 'span.finish(', 'span.fail(']],
  ['host/engine.ts', ["startSpan('engine'", 'withContext(diagnostics']],
  ['services/HostProviderService.ts', ["startSpan('provider'", 'withContext(span.context']],
  ['utils/projectService.ts', ["startSpan('project'", 'withContext(', 'span.context']],
  ['utils/useNativeProjectDocument.ts', ["startSpan('project_document'", 'span.context']],
  ['workers/fbxImport.worker.ts', ["report(0.12, 'fbx_structure_parse'", "report(0.64, 'runtime_asset_construction'", "type: 'error'"]],
  ['renderer/diagnostics.ts', ['renderer.context_lost', 'renderer.performance_degraded']],
]);

const results = [];
const failures = [];
for (const [relative, evidence] of REQUIRED_EVIDENCE) {
  const sourceText = fs.readFileSync(path.join(root, relative), 'utf8');
  for (const token of evidence) {
    if (!sourceText.includes(token)) failures.push(`${relative}: missing required trace evidence ${JSON.stringify(token)}`);
  }
}
for (const absolute of files.sort()) {
  const relative = path.relative(root, absolute).replaceAll('\\', '/');
  if (relative === 'vite.config.ts' || relative === 'vitest.config.ts') continue;
  if (generatedPrefixes.some((prefix) => relative.startsWith(prefix))) {
    results.push([relative, 'generated']);
    continue;
  }
  const sourceText = fs.readFileSync(absolute, 'utf8');
  if (/\bconsole\.(?:log|info|warn|error|debug|trace)\s*\(/.test(sourceText)) {
    failures.push(`${relative}: production console logging bypasses diagnostics`);
  }
  const source = ts.createSourceFile(
    absolute,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    relative.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  if (source.parseDiagnostics.length) {
    failures.push(`${relative}: TypeScript parse failure`);
    continue;
  }
  if (relative === 'diagnostics/runtime.ts' || relative === 'diagnostics/RuntimeDiagnosticsBoundary.tsx') {
    results.push([relative, 'diagnostics-infrastructure']);
    continue;
  }
  const direct = /\bfrontendDiagnostics\b/.test(sourceText)
    || /\binstallRendererDiagnostics\b/.test(sourceText)
    || /\bworkerDiagnostic\b/.test(sourceText);
  if (direct) {
    results.push([relative, 'direct']);
    continue;
  }
  let hasJsx = false;
  const visit = (node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) hasJsx = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (relative.endsWith('.tsx') && hasJsx) {
    results.push([relative, 'react-boundary']);
    continue;
  }
  const exemption = EXEMPT.get(relative);
  if (exemption) {
    results.push([relative, exemption]);
    continue;
  }
  failures.push(`${relative}: no direct, React, generated, hot-loop, input, or pure classification`);
}

const unusedExemptions = [...EXEMPT.keys()].filter((relative) => !files.some(
  (absolute) => path.relative(root, absolute).replaceAll('\\', '/') === relative,
));
for (const relative of unusedExemptions) failures.push(`${relative}: stale diagnostics exemption`);

if (failures.length) {
  console.error(`diagnostics coverage failed (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const verifyRuntimeBehavior = async () => {
  const posted = [];
  const webviewListeners = new Map();
  const webview = {
    addEventListener: (name, callback) => webviewListeners.set(name, callback),
    removeEventListener: (name) => webviewListeners.delete(name),
    postMessage: (message) => posted.push(message),
  };
  globalThis.window = {
    chrome: { webview },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const runtimeSource = fs.readFileSync(path.join(root, 'diagnostics/runtime.ts'), 'utf8');
  const transpiled = ts.transpileModule(runtimeSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  const module = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`);
  const diagnostics = module.frontendDiagnostics;
  diagnostics.start();
  diagnostics.run('runtime_smoke', 'parent', () => {
    diagnostics.run('runtime_smoke', 'child', () => undefined);
  });
  try {
    diagnostics.wrap('runtime_smoke', 'failure', () => {
      throw new Error('private runtime value');
    })();
  } catch {
    // Expected: the diagnostic must contain only the stable error type.
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  diagnostics.stop();
  const records = posted.filter((message) => message?.type === 'event-batch').flatMap((message) => message.records);
  const starts = records.filter((record) => record.event === 'activity.started'
    && record.attributes?.subsystem === 'runtime_smoke');
  const parent = starts.find((record) => record.attributes.action === 'parent');
  const child = starts.find((record) => record.attributes.action === 'child');
  if (!parent || !child || parent.traceId !== child.traceId || child.parentSpanId !== parent.spanId) {
    failures.push('diagnostics/runtime.ts: executable parent/child span correlation failed');
  }
  if (!records.some((record) => record.event === 'activity.failed'
    && record.attributes?.errorType === 'Error')) {
    failures.push('diagnostics/runtime.ts: executable failure capture failed');
  }
  if (JSON.stringify(records).includes('private runtime value')) {
    failures.push('diagnostics/runtime.ts: executable trace retained an error message');
  }
};

await verifyRuntimeBehavior();

if (failures.length) {
  console.error(`diagnostics coverage failed (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const counts = new Map();
for (const [, classification] of results) counts.set(classification, (counts.get(classification) ?? 0) + 1);
console.log(`diagnostics coverage passed (${results.length} runtime modules)`);
console.log([...counts.entries()].sort().map(([name, count]) => `${name}=${count}`).join(', '));
