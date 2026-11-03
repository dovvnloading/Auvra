// Rendering pictures: draws the fixed scenes in tests/visual/ in a headless browser, on its software GPU so that the
// result depends on the engine and not the machine, and compares them with the pictures kept beside them.
//
//   node scripts/rendering/run.mjs            compare, and write what each scene cost to tests/visual/output/
//   node scripts/rendering/run.mjs --update   keep the new pictures as the ones to compare with
//   node scripts/rendering/run.mjs --gpu      draw on the machine's real GPU, for its numbers (the pictures will differ)
//   node scripts/rendering/run.mjs --only a,b just those scenes
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { build } from 'vite';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const visualDir = path.join(projectDir, 'tests/visual');
const referenceDir = path.join(visualDir, 'references');
const outputDir = path.join(visualDir, 'output');

const args = process.argv.slice(2);
const updating = args.includes('--update');
const realGpu = args.includes('--gpu');
const onlyAt = args.indexOf('--only');
const only = onlyAt >= 0 ? new Set(args[onlyAt + 1].split(',')) : null;

/** A pixel differs when a channel is further off than this: software GPUs round a little differently between machines. */
const PIXEL_TOLERANCE = 10;
/** The share of a picture that may differ. */
const MOST_DIFFERING = 0.005;
const SCENE_LIMIT_MS = 600_000;

const browserPath = () => {
  const candidates = [
    process.env.AUVRA_BROWSER,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ];
  const found = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!found) throw new Error('No browser found: set AUVRA_BROWSER to one');
  return found;
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.json': 'application/json' };

const serve = (root) => new Promise((resolve) => {
  const server = createServer((request, response) => {
    const file = path.join(root, decodeURIComponent(new URL(request.url, 'http://local').pathname));
    if (!file.startsWith(root) || !existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    response.end(readFileSync(file));
  });
  server.listen(0, '127.0.0.1', () => resolve(server));
});

const waitForFile = async (file, limitMs) => {
  const start = Date.now();
  while (!existsSync(file) || !readFileSync(file, 'utf8').includes('\n')) {
    if (Date.now() - start > limitMs) throw new Error('The browser did not start');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return readFileSync(file, 'utf8');
};

/** Just enough of the browser's debugging protocol: one page, and running script in it. */
const connect = async (url) => {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Could not reach the browser')), { once: true });
  });
  let nextId = 1;
  const waiting = new Map();
  const events = [];
  socket.addEventListener('message', (message) => {
    const data = JSON.parse(message.data);
    if (data.id && waiting.has(data.id)) {
      const { resolve, reject } = waiting.get(data.id);
      waiting.delete(data.id);
      if (data.error) reject(new Error(data.error.message));
      else resolve(data.result);
    } else if (data.method) {
      events.push(data);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  return { send, events, close: () => socket.close() };
};

const main = async () => {
  const siteDir = mkdtempSync(path.join(tmpdir(), 'auvra-visual-site-'));
  const profileDir = mkdtempSync(path.join(tmpdir(), 'auvra-visual-profile-'));
  let browser = null;
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

    const gpuFlags = realGpu ? ['--ignore-gpu-blocklist'] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
    browser = spawn(browserPath(), [
      '--headless=new',
      `--user-data-dir=${profileDir}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-background-timer-throttling',
      '--force-device-scale-factor=1',
      '--force-color-profile=srgb',
      '--window-size=800,600',
      ...(process.env.CI ? ['--no-sandbox'] : []),
      ...gpuFlags,
      'about:blank',
    ], { stdio: 'ignore' });
    const portLines = await waitForFile(path.join(profileDir, 'DevToolsActivePort'), 30_000);
    const [port, browserPathPart] = portLines.split('\n');
    const client = await connect(`ws://127.0.0.1:${port}${browserPathPart}`);
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => client.send(method, params, sessionId);
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    const { address, port: sitePort } = server.address();
    await send('Page.navigate', { url: `http://${address}:${sitePort}/index.html` });

    const run = async (expression) => {
      const result = await Promise.race([
        send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
        new Promise((_, reject) => { setTimeout(() => reject(new Error('A scene took too long')), SCENE_LIMIT_MS).unref(); }),
      ]);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };
    const start = Date.now();
    while (!(await run('!!window.auvraVisual'))) {
      if (Date.now() - start > 60_000) throw new Error(`The test page did not load:\n${client.events.filter((event) => event.method === 'Runtime.exceptionThrown').map((event) => event.params.exceptionDetails.exception?.description).join('\n')}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const names = (await run('window.auvraVisual.names')).filter((name) => !only || only.has(name));
    mkdirSync(outputDir, { recursive: true });
    mkdirSync(referenceDir, { recursive: true });
    const failures = [];
    const numbers = {};
    const rows = [];
    for (const name of names) {
      const { png, numbers: cost } = await run(`window.auvraVisual.capture(${JSON.stringify(name)})`);
      numbers[name] = cost;
      const bytes = Buffer.from(png.split(',')[1], 'base64');
      const referenceFile = path.join(referenceDir, `${name}.png`);
      writeFileSync(path.join(outputDir, `${name}.actual.png`), bytes);
      let verdict = 'kept';
      let shareText = '-';
      if (updating) {
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
            failures.push(`${name}: ${shareText} of the picture differs`);
            if (result.diff) writeFileSync(path.join(outputDir, `${name}.diff.png`), Buffer.from(result.diff.split(',')[1], 'base64'));
          }
        }
      }
      rows.push({ name, verdict, differs: shareText, 'load ms': Math.round(cost.loadMs), 'frame ms': +cost.frameMs.toFixed(1), draws: cost.calls, triangles: cost.triangles, programs: cost.programs, 'GPU MB': +(cost.gpuBytes / 1048576).toFixed(1) });
      console.log(`${name}: ${verdict}`);
    }
    console.table(rows);
    writeFileSync(path.join(outputDir, 'numbers.json'), `${JSON.stringify(numbers, null, 2)}\n`);
    if (updating && !only) {
      for (const file of readdirSync(referenceDir)) {
        if (!names.includes(path.basename(file, '.png'))) rmSync(path.join(referenceDir, file));
      }
    }
    client.close();
    if (failures.length) {
      console.error(`Rendering has changed:\n  ${failures.join('\n  ')}\nThe pictures are in tests/visual/output/. If the change is meant, keep them with: npm run rendering:verify -- --update`);
      process.exitCode = 1;
    }
  } finally {
    server?.close();
    browser?.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
    rmSync(siteDir, { recursive: true, force: true });
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
};

await main();
