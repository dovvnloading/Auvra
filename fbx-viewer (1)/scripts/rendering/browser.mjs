// A headless browser on a software GPU, driven over its debugging protocol: what the rendering pictures
// (scripts/rendering/run.mjs) and the material command line's page (scripts/materials/headless.mjs) both use.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

export const browserPath = () => {
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

export const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.json': 'application/json' };

/**
 * Serves `root` on a free port of this machine only. `route(request, response)` sees each request first and returns
 * true when it answered it.
 */
export const serve = (root, route = () => false) => new Promise((resolve) => {
  const server = createServer((request, response) => {
    if (route(request, response)) return;
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

// On Windows a file the browser is still writing cannot be opened at all (EBUSY): it is read again, as one not there yet.
const readIfReady = (file) => {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  } catch (error) {
    if (error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'EACCES') return '';
    throw error;
  }
};

const waitForFile = async (file, limitMs) => {
  const start = Date.now();
  let text = readIfReady(file);
  while (!text.includes('\n')) {
    if (Date.now() - start > limitMs) throw new Error('The browser did not start');
    await new Promise((resolve) => setTimeout(resolve, 100));
    text = readIfReady(file);
  }
  return text;
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

/** WebGL2 on the processor, through GL's SwiftShader, the same on every machine. */
export const SOFTWARE_WEBGL = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

/**
 * Starts a headless browser with its own profile in `profileDir` and opens one page at `url`. Returns the browser's
 * process, the protocol client (with every event it heard), `send` for the page, and `run`, which evaluates script in
 * the page and hands back its value (a promise's, once settled), failing after `limitMs` or on a thrown error.
 */
export const openPage = async ({ profileDir, gpuFlags, url, windowSize = '800,600' }) => {
  const browser = spawn(browserPath(), [
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
    `--window-size=${windowSize}`,
    ...(process.env.CI ? ['--no-sandbox'] : []),
    ...gpuFlags,
    'about:blank',
  ], { stdio: 'ignore' });
  try {
    const portLines = await waitForFile(path.join(profileDir, 'DevToolsActivePort'), 30_000);
    const [port, browserPathPart] = portLines.split('\n');
    const client = await connect(`ws://127.0.0.1:${port}${browserPathPart}`);
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => client.send(method, params, sessionId);
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await send('Page.navigate', { url });
    const run = async (expression, limitMs, tooLong = 'The page took too long') => {
      const result = await Promise.race([
        send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
        new Promise((_, reject) => { setTimeout(() => reject(new Error(tooLong)), limitMs).unref(); }),
      ]);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };
    return { browser, client, send, run };
  } catch (error) {
    browser.kill();
    throw error;
  }
};

/** Errors the page threw so far (while it loads, the reason it never got ready). */
export const pageErrors = (client) => client.events
  .filter((event) => event.method === 'Runtime.exceptionThrown')
  .map((event) => event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text);

/** What the page warned of since event `from`: its own trouble is reported there. */
export const pageSaid = (client, from = 0) => client.events
  .slice(from)
  .filter((event) => event.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(event.params.type))
  .map((event) => event.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '))
  .slice(-30);

/** Stops the browser and removes its profile. */
export const closeBrowser = async (browser, profileDir) => {
  if (browser && browser.exitCode === null) {
    // A browser still closing holds its profile's files on Windows: it is waited for, a few seconds at most.
    const exited = new Promise((resolve) => browser.once('exit', resolve));
    browser.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  }
  try {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (error) {
    // What is left is in the system's temporary folder.
    console.warn(`Could not remove the browser profile ${profileDir}: ${error.message}`);
  }
};
