// A headless browser on a software GPU, driven over its debugging protocol: what the rendering pictures
// (scripts/rendering/run.mjs) and the material command line's page (scripts/materials/headless.mjs) both use.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline';

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

// Chromium announces its debugger endpoint on stderr. Keep the last messages when it fails:
// a startup timeout alone does not distinguish a slow CI runner from a Chromium crash.
const waitForDebugger = (browser, limitMs) => new Promise((resolve, reject) => {
  const recent = [];
  const lines = createInterface({ input: browser.stderr });
  let settled = false;
  const timer = setTimeout(() => finish(new Error('The browser did not start within ' + limitMs + ' ms')), limitMs);
  function finish(error, url) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    browser.off('error', onError);
    lines.off('close', onClose);
    lines.close();
    browser.stderr.resume();
    if (error) {
      const detail = recent.length ? '\nChromium stderr:\n' + recent.join('\n') : '';
      reject(new Error(error.message + detail));
    } else resolve(url);
  }
  const onError = (error) => finish(error);
  const onClose = () => finish(new Error('The browser closed before its debugger was ready'));
  browser.once('error', onError);
  lines.once('close', onClose);
  lines.on('line', (line) => {
    if (line.trim()) {
      recent.push(line);
      if (recent.length > 12) recent.shift();
    }
    const match = /^DevTools listening on (ws:\/\/(?:127\.0\.0\.1|\[::1\]):\d{1,5}\/devtools\/browser\/[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i.exec(line);
    if (match) finish(null, match[1]);
  });
});

// Retry only the browser's launch, not tests or page work. Each attempt has its own profile,
// so a crashed or slow first Chromium cannot lock the retry's profile.
export const launchBrowser = async ({ executable, argsForProfile, profileDir, attempts = process.env.CI ? 2 : 1, timeoutMs = 30_000 }) => {
  const failures = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const browser = spawn(executable, argsForProfile(path.join(profileDir, 'launch-' + attempt)), {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    try {
      const endpoint = await waitForDebugger(browser, timeoutMs);
      return { browser, endpoint };
    } catch (error) {
      browser.kill();
      failures.push('Attempt ' + attempt + ': ' + (error instanceof Error ? error.message : String(error)));
    }
  }
  throw new Error('Chromium failed to start after ' + attempts + ' attempt(s):\n' + failures.join('\n'));
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
  const { browser, endpoint } = await launchBrowser({
    executable: browserPath(),
    profileDir,
    argsForProfile: (launchProfile) => [
      '--headless=new',
      '--user-data-dir=' + launchProfile,
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
      '--window-size=' + windowSize,
      ...(process.env.CI ? ['--no-sandbox'] : []),
      ...gpuFlags,
      'about:blank',
    ],
  });
  try {
    const client = await connect(endpoint);
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
