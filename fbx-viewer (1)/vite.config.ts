import path from 'path';
import { createHash, randomBytes } from 'node:crypto';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { collectThirdPartyNotices } from './scripts/licenses/notices.mjs';
import { classicSandboxFrames } from './scripts/frames/classicFrames.mjs';

// Chromium (and so WebView2) dropped CSP navigate-to and logs every page that sends it; the desktop
// host's frame policy is what keeps navigation on the app origin.
// Play-in-editor multiplayer reaches a relay on this machine at its default port (Auvra/net/relay.py).
const LOCAL_RELAY = 'ws://127.0.0.1:7777 ws://localhost:7777';
const editorDevCsp = (port: number, nonce: string) => `default-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'; connect-src 'self' blob: https://assets.auvra.local http://127.0.0.1:${port} ws://127.0.0.1:${port} ${LOCAL_RELAY}; form-action 'none';`;
const editorPackagedCsp = `default-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' blob: https://assets.auvra.local ${LOCAL_RELAY}; form-action 'none';`;
const hudPackagedCsp = `default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'none'; connect-src 'none'; media-src 'none'; form-action 'none';`;
const playerPackagedCsp = `default-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' blob:; form-action 'none'`;
const playerDevCsp = (port: number, nonce: string) => playerPackagedCsp
  .replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`)
  .replace("connect-src 'self' blob:", `connect-src 'self' blob: http://127.0.0.1:${port} ws://127.0.0.1:${port}`);
const readinessToken = process.env.AUVRA_READY_TOKEN ?? null;

// The standalone player is a relocatable static bundle: its HTML entry is
// published as index.html and every emitted file is recorded, with its size
// and SHA-256, in player-template.json so packagers can verify the template.
const playerTemplatePlugin = (): Plugin => ({
  name: 'auvra-player-template',
  apply: 'build',
  enforce: 'post',
  generateBundle: {
    // Run after every other generateBundle hook so the recorded hashes match
    // the bytes Rollup writes.
    order: 'post',
    handler(_options, bundle) {
      const entry = bundle['player.html'];
      if (!entry || entry.type !== 'asset') throw new Error('Auvra player build did not emit player.html');
      if (bundle['index.html'] || bundle['player-template.json']) throw new Error('Auvra player build output names are already taken');
      delete bundle['player.html'];
      this.emitFile({ type: 'asset', fileName: 'index.html', source: entry.source });
      const files = Object.values(bundle).map((output) => {
        const bytes = Buffer.from(output.type === 'chunk' ? output.code : output.source);
        return { path: output.fileName, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
      }).sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
      if (!files.some((file) => file.path === 'index.html')) throw new Error('Auvra player template is missing index.html');
      this.emitFile({
        type: 'asset',
        fileName: 'player-template.json',
        source: `${JSON.stringify({ schema: 1, entry: 'index.html', files }, null, 2)}\n`,
      });
    },
  },
});

// Editor and player builds both ship the license texts of their npm dependencies. This runs
// in the normal generateBundle phase, before the player template records every file's hash.
const thirdPartyNoticesPlugin = (): Plugin => ({
  name: 'auvra-third-party-notices',
  apply: 'build',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES.txt', source: collectThirdPartyNotices(__dirname) });
  },
});

export default defineConfig(({ command, mode }) => {
  const isPlayer = mode === 'player';
  const editorInput: Record<string, string> = {
    editor: path.resolve(__dirname, 'index.html'),
    hud: path.resolve(__dirname, 'hud-frame.html'),
    script: path.resolve(__dirname, 'script-frame.html'),
  };
  const playerInput: Record<string, string> = {
    index: path.resolve(__dirname, 'player.html'),
    hud: path.resolve(__dirname, 'hud-frame.html'),
    script: path.resolve(__dirname, 'script-frame.html'),
  };
  // Vite's development preamble is inline and receives a per-server nonce.
  // Production contains external scripts only, so it needs no static nonce and
  // consecutive builds remain byte-for-byte reproducible.
  const developmentNonce = command === 'serve' ? randomBytes(18).toString('base64') : null;
  const hudCsp = developmentNonce
    ? hudPackagedCsp.replace("script-src 'self'", `script-src 'self' 'nonce-${developmentNonce}'`)
    : hudPackagedCsp;
  return ({
  server: {
    port: 3000,
    host: '127.0.0.1',
    strictPort: true,
    open: false,
    // Transform the editor's whole import graph as soon as the server starts, rather than module
    // by module as the window first asks for them: the window then boots from a warm server.
    warmup: { clientFiles: ['./index.tsx'] },
  },
  plugins: [
    react(),
    thirdPartyNoticesPlugin(),
    {
      name: 'auvra-csp-mode',
      transformIndexHtml(html: string, context) {
        let editorCsp = editorPackagedCsp;
        let playerCsp = playerPackagedCsp;
        if (command === 'serve') {
          const address = context.server?.httpServer?.address();
          if (!address || typeof address === 'string' || !['127.0.0.1', '::ffff:127.0.0.1'].includes(address.address)) {
            throw new Error('Auvra development content must be served from exact IPv4 loopback');
          }
          if (!developmentNonce) throw new Error('Auvra development CSP nonce is unavailable');
          editorCsp = editorDevCsp(address.port, developmentNonce);
          playerCsp = playerDevCsp(address.port, developmentNonce);
        }
        // The gameplay script sandbox shares the HUD sandbox's policy: evaluation, but no network.
        return html
          .replace('__AUVRA_EDITOR_CSP__', editorCsp)
          .replace('__AUVRA_PLAYER_CSP__', playerCsp)
          .replace('__AUVRA_HUD_CSP__', hudCsp)
          .replace('__AUVRA_SCRIPT_CSP__', hudCsp);
      },
    },
    {
      name: 'auvra-readiness-identity',
      configureServer(server) {
        server.middlewares.use('/__auvra_ready__', (request, response, next) => {
          if (request.method !== 'GET' || !readinessToken) {
            next();
            return;
          }
          response.statusCode = 200;
          response.setHeader('Cache-Control', 'no-store');
          response.setHeader('Content-Type', 'text/plain; charset=utf-8');
          response.setHeader('X-Auvra-Ready-Token', readinessToken);
          response.end('auvra-ready\n');
        });
      },
    },
    // The sandbox frames load their code as classic scripts: an opaque-origin frame's module loads are refused.
    classicSandboxFrames({ root: __dirname, frameCsp: hudCsp }),
    ...(isPlayer ? [playerTemplatePlugin()] : []),
  ],
  ...(isPlayer ? { base: './' } : {}),
  build: {
    ...(isPlayer ? { outDir: 'dist/player', emptyOutDir: true } : {}),
    rollupOptions: {
      input: isPlayer ? playerInput : editorInput,
    },
  },
  ...(developmentNonce ? { html: { cspNonce: developmentNonce } } : {}),
  // Packages imported only by workers: the dependency scan does not follow workers, so without these
  // the first import of a model found them, re-optimized and reloaded the editor. The Basis and
  // Draco decoders are also CommonJS, which only this conversion makes importable.
  optimizeDeps: {
    include: [
      'three/examples/jsm/loaders/FBXLoader.js',
      'three/examples/jsm/loaders/OBJLoader.js',
      'three/examples/jsm/exporters/GLTFExporter.js',
      'three/examples/jsm/libs/basis/basis_transcoder.js',
      'three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js',
      '@recast-navigation/wasm',
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    }
  }
  });
});
