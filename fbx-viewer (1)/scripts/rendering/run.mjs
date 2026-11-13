// Rendering pictures: draws the fixed scenes in tests/visual/ in a headless browser, on its software GPU so that the
// result depends on the engine and not the machine, and compares them with the pictures kept beside them.
//
//   node scripts/rendering/run.mjs            compare, and write what each scene cost to tests/visual/output/
//   node scripts/rendering/run.mjs --update   keep the new pictures as the ones to compare with
//   node scripts/rendering/run.mjs --gpu      draw on the machine's real GPU, for its numbers (the pictures will differ)
//   node scripts/rendering/run.mjs --only a,b just those scenes
//   node scripts/rendering/run.mjs --renderer webgpu
//                                             the same on the WebGPU renderer, with pictures of its own in
//                                             tests/visual/references/webgpu/ and its output in tests/visual/output/webgpu/
//   node scripts/rendering/run.mjs --texture-bench --texture-size 11
//                                             measure cold/cache/incremental graph cook at 2K,
//                                             without comparing an intentionally resized image
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { build } from 'vite';
import { summarizeTextureSamples, validateTextureSample } from './textureBenchmark.mjs';
import { SOFTWARE_WEBGL, closeBrowser, openPage, pageErrors, pageSaid as saidSince, serve } from './browser.mjs';

const args = process.argv.slice(2);
const updating = args.includes('--update');
const realGpu = args.includes('--gpu');
const textureBench = args.includes('--texture-bench');
const samplesAt = args.indexOf('--samples');
const samples = samplesAt < 0 ? 1 : Number(args[samplesAt + 1]);
if (samplesAt >= 0 && (!textureBench || !Number.isSafeInteger(samples) || samples < 1)) {
  throw new Error('--samples requires --texture-bench and a positive integer.');
}
const textureSizeAt = args.indexOf('--texture-size');
const textureSize = textureSizeAt >= 0 ? Number(args[textureSizeAt + 1]) : 9;
if (textureBench && ![9, 11, 12].includes(textureSize)) throw new Error('Texture benchmark size must be 9, 11 or 12 (512/2048/4096 pixels).');
if (textureBench && updating) throw new Error('Benchmark mode cannot update visual reference pictures.');
const onlyAt = args.indexOf('--only');
const only = textureBench ? new Set(['texture-graph']) : onlyAt >= 0 ? new Set(args[onlyAt + 1].split(',')) : null;
const rendererAt = args.indexOf('--renderer');
const renderer = rendererAt >= 0 ? args[rendererAt + 1] : 'webgl2';
if (renderer !== 'webgl2' && renderer !== 'webgpu') throw new Error(`No renderer called ${renderer}: webgl2 or webgpu`);
const onWebGpu = renderer === 'webgpu';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const visualDir = path.join(projectDir, 'tests/visual');
const referenceDir = path.join(visualDir, 'references', ...(onWebGpu ? ['webgpu'] : []));
const outputDir = path.join(visualDir, 'output', ...(onWebGpu ? ['webgpu'] : []));

/** A pixel differs when a channel is further off than this: software GPUs round a little differently between machines. */
const PIXEL_TOLERANCE = 10;
/** The share of a picture that may differ. */
const MOST_DIFFERING = 0.005;
const SCENE_LIMIT_MS = 600_000;

const captureScenes = async (server, outputDir) => {
  const profileDir = mkdtempSync(path.join(tmpdir(), 'auvra-visual-profile-'));
  let browser = null;
  try {
    // WebGPU on the processor goes through Vulkan's SwiftShader, which the browser brings along. Asking for GL's
    // SwiftShader as well leaves the browser with no WebGPU adapter at all.
    // A headless Linux browser has no window surface for Vulkan, and loses its device without being told not to want one.
    const linuxVulkan = process.platform === 'linux' ? ['--use-angle=vulkan', '--disable-vulkan-surface'] : [];
    const softwareGpu = onWebGpu
      ? ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', ...linuxVulkan]
      : SOFTWARE_WEBGL;
    const gpuFlags = realGpu ? ['--ignore-gpu-blocklist', ...(onWebGpu ? ['--enable-unsafe-webgpu'] : [])] : softwareGpu;
    const { address, port: sitePort } = server.address();
    const benchQuery = textureBench ? `&textureBench=1&textureSize=${textureSize}` : '';
    const page = await openPage({ profileDir, gpuFlags, url: `http://${address}:${sitePort}/index.html?renderer=${renderer}${benchQuery}` });
    browser = page.browser;
    const { client } = page;
    const run = (expression) => page.run(expression, SCENE_LIMIT_MS, 'A scene took too long');
    const start = Date.now();
    while (!(await run('!!window.auvraVisual'))) {
      if (Date.now() - start > 60_000) throw new Error(`The test page did not load:\n${pageErrors(client).join('\n')}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const names = (await run('window.auvraVisual.names')).filter((name) => !only || only.has(name));
    mkdirSync(outputDir, { recursive: true });
    mkdirSync(referenceDir, { recursive: true });
    const failures = [];
    const numbers = {};
    const rows = [];
    let paintPreview;
    if (!onWebGpu && !textureBench && names.includes('texture-graph')) {
      // Exercise the actual viewport target separately so its allocations do not enter scene timings.
      paintPreview = await run('window.auvraVisual.verifyPaintViewTarget()');
    }
    // What the page itself warned of since `from`: the renderer reports its own trouble there.
    const pageSaid = (from) => saidSince(client, from);
    const said = (lines) => (lines.length ? `\nThe page said:\n  ${lines.join('\n  ')}` : '');
    for (const name of names) {
      const sceneStart = client.events.length;
      const { png, numbers: cost } = await run(`window.auvraVisual.capture(${JSON.stringify(name)})`).catch((error) => {
        throw new Error(`${name}: ${error.message}${said(pageSaid(sceneStart))}`);
      });
      if (name === 'texture-graph' && paintPreview) cost.paintPreview = paintPreview;
      numbers[name] = cost;
      if (onWebGpu && name === 'texture-graph') {
        if (!textureBench && (cost.graphCook?.backend !== 'webgpu' || cost.graphCook.fallback)) {
          failures.push(`${name}: expected the proof graph to cook on WebGPU: ${cost.graphCookProblem ?? 'missing WebGPU result'}`);
        }
        if (!cost.bc1Parity) failures.push(`${name}: no BC1 parity result was returned`);
        else if (cost.bc1Parity.status === 'failed') failures.push(`${name}: ${cost.bc1Parity.reason}`);
      }
      if (name === 'texture-graph' && !textureBench) {
        const matrix = cost.materialCompression;
        if (matrix?.backend !== renderer) failures.push(`${name}: missing ${renderer} material compression report`);
        else for (const [format, result] of Object.entries(matrix.formats)) {
          if (result.status === 'failed') failures.push(`${name}: ${renderer} ${format}: ${result.reason}`);
        }
      }
      const bytes = Buffer.from(png.split(',')[1], 'base64');
      const referenceFile = path.join(referenceDir, `${name}.png`);
      writeFileSync(path.join(outputDir, `${name}.actual.png`), bytes);
      let verdict = 'kept';
      let shareText = '-';
      if (textureBench) {
        verdict = 'BENCHMARK (not reference-compared)';
        try {
          validateTextureSample(cost, renderer, 2 ** textureSize);
        } catch (error) {
          failures.push(`${name}: ${error.message}`);
        }
      } else if (updating) {
        writeFileSync(referenceFile, bytes);
      } else if (!realGpu) {
        if (!existsSync(referenceFile)) {
          failures.push(`${name}: no picture to compare with`);
          verdict = 'MISSING';
        } else {
          const reference = `data:image/png;base64,${readFileSync(referenceFile).toString('base64')}`;
          const result = await run(`window.auvraVisual.compare(${JSON.stringify(png)}, ${JSON.stringify(reference)}, ${PIXEL_TOLERANCE})`);
          shareText = `${(result.share * 100).toFixed(3)}% worst ${result.worst}`;
          verdict = result.sameSize && result.share <= MOST_DIFFERING ? 'same' : 'DIFFERENT';
          if (verdict !== 'same') {
            failures.push(`${name}: ${shareText} of the picture differs${said(pageSaid(sceneStart))}`);
            if (result.diff) writeFileSync(path.join(outputDir, `${name}.diff.png`), Buffer.from(result.diff.split(',')[1], 'base64'));
          }
        }
      }
      rows.push({ name, verdict, differs: shareText, 'load ms': Math.round(cost.loadMs), 'frame ms': +cost.frameMs.toFixed(1), 'graph cook ms': cost.graphCook ? +cost.graphCook.milliseconds.toFixed(1) : '-', draws: cost.calls, triangles: cost.triangles, programs: cost.programs, 'GPU MB': +(cost.gpuBytes / 1048576).toFixed(1) });
      console.log(`${name}: ${verdict}`);
    }
    if (!textureBench && !onWebGpu && names.includes('texture-graph')) {
      numbers['texture-graph'].photoCapture = await run('window.auvraVisual.verifyPhotoCaptureWorker()');
    }
    console.table(rows);
    if (textureBench) {
      const cooked = numbers['texture-graph']?.textureCook;
      if (cooked && failures.length === 0) {
        console.table([{
          backend: cooked.backend,
          resolution: `${cooked.resolution}×${cooked.resolution}`,
          'cold evaluation ms': +cooked.coldEvalMs.toFixed(1),
          'cold GPU sync ms': +cooked.coldSyncMs.toFixed(1),
          'PNG encoding ms': +cooked.encodeMs.toFixed(1),
          'cached evaluation ms': +cooked.cachedEvalMs.toFixed(1),
          'incremental evaluation ms': +cooked.editEvalMs.toFixed(1),
          'incremental GPU sync ms': +cooked.editSyncMs.toFixed(1),
          'cold nodes': cooked.firstNodes,
          'cached nodes': cooked.cachedNodes,
          'incremental nodes': cooked.editNodes,
        }]);
      }
    }
    if (textureBench) {
      // Source archives can run the harness even when Git metadata is unavailable.
      const git = (...args) => spawnSync('git', args, { cwd: projectDir, encoding: 'utf8' });
      const head = git('rev-parse', '--verify', 'HEAD');
      const status = git('status', '--porcelain', '--untracked-files=normal', '--', ':/');
      const system = await client.send('SystemInfo.getInfo').catch(() => null);
      numbers._benchmark = {
        sourceCommit: head.status === 0 ? head.stdout.trim() : null,
        workingTreeDirty: status.status === 0 ? Boolean(status.stdout.trim()) : null,
        createdAt: new Date().toISOString(),
        rendererRequested: renderer,
        gpuSelection: realGpu ? 'hardware-requested' : 'software-requested',
        resolution: 2 ** textureSize,
        // Chromium can list multiple devices. Keep the list distinct from the adapter that cooked the graph.
        browserGpuDevices: system?.gpu?.devices?.map(({ vendorId, deviceId, vendorString, deviceString, driverVendor, driverVersion }) =>
          ({ vendorId, deviceId, vendorString, deviceString, driverVendor, driverVersion })) ?? null,
        browserUserAgent: await run('navigator.userAgent'),
        operatingSystem: process.platform,
        architecture: process.arch,
        note: 'textureCook.adapter describes the cooking context. Unavailable adapter fields are null. Evaluation and readback are timed independently.',
      };
    }
    writeFileSync(path.join(outputDir, 'numbers.json'), `${JSON.stringify(numbers, null, 2)}\n`);
    if (updating && !only) {
      for (const file of readdirSync(referenceDir)) {
        if (file.endsWith('.png') && !names.includes(path.basename(file, '.png'))) rmSync(path.join(referenceDir, file));
      }
    }
    client.close();
    if (failures.length) {
      const again = onWebGpu ? ' --renderer webgpu' : '';
      if (textureBench) console.error(`Texture benchmark failed on ${renderer}:\n  ${failures.join('\n  ')}`);
      else console.error(`Rendering has changed on ${renderer}:\n  ${failures.join('\n  ')}\nThe pictures are in ${path.relative(projectDir, outputDir)}/. If the change is meant, keep them with: npm run rendering:verify -- --update${again}`);
      process.exitCode = 1;
    }
    return { numbers, failures };
  } finally {
    await closeBrowser(browser, profileDir);
  }
};

const main = async () => {
  const siteDir = mkdtempSync(path.join(tmpdir(), 'auvra-visual-site-'));
  let server = null;
  try {
    console.log('Building the test page...');
    await build({
      configFile: false,
      root: visualDir,
      base: './',
      logLevel: 'error',
      plugins: [react()],
      resolve: { alias: { '@': projectDir } },
      build: { outDir: siteDir, emptyOutDir: true, chunkSizeWarningLimit: 100000, minify: false },
    });
    server = await serve(siteDir);

    if (samples === 1) {
      await captureScenes(server, outputDir);
      return;
    }
    mkdirSync(outputDir, { recursive: true });
    const seriesDir = mkdtempSync(path.join(outputDir, 'samples-'));
    console.log(`Writing ${samples} independent browser samples to ${seriesDir}`);
    const results = [];
    for (let index = 1; index <= samples; index++) {
      // Each process starts with a new profile, device and graph evaluator. Keep the built page identical.
      const { numbers, failures } = await captureScenes(server, path.join(seriesDir, String(index)));
      if (failures.length) throw new Error(`Sample ${index} failed: ${failures.join(', ')}`);
      results.push(numbers);
    }
    const summary = summarizeTextureSamples(results);
    writeFileSync(path.join(seriesDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.table(summary.phases);
  } finally {
    server?.close();
    rmSync(siteDir, { recursive: true, force: true });
  }
};

await main();
