import path from 'path';
import { randomBytes } from 'node:crypto';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const editorDevCsp = (port: number, nonce: string) => `default-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'nonce-${nonce}'; connect-src 'self' blob: https://assets.auvra.local http://127.0.0.1:${port} ws://127.0.0.1:${port}; form-action 'none'; navigate-to 'self';`;
const editorPackagedCsp = `default-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' blob: https://assets.auvra.local; form-action 'none'; navigate-to 'self';`;
const hudPackagedCsp = `default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'none'; connect-src 'none'; media-src 'none'; form-action 'none'; navigate-to 'none';`;
const readinessToken = process.env.AUVRA_READY_TOKEN ?? null;

export default defineConfig(({ command }) => {
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
  },
  plugins: [
    react(),
    {
      name: 'auvra-csp-mode',
      transformIndexHtml(html: string, context) {
        let editorCsp = editorPackagedCsp;
        if (command === 'serve') {
          const address = context.server?.httpServer?.address();
          if (!address || typeof address === 'string' || !['127.0.0.1', '::ffff:127.0.0.1'].includes(address.address)) {
            throw new Error('Auvra development content must be served from exact IPv4 loopback');
          }
          if (!developmentNonce) throw new Error('Auvra development CSP nonce is unavailable');
          editorCsp = editorDevCsp(address.port, developmentNonce);
        }
        return html
          .replace('__AUVRA_EDITOR_CSP__', editorCsp)
          .replace('__AUVRA_HUD_CSP__', hudCsp);
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
  ],
  build: {
    rollupOptions: {
      input: {
        editor: path.resolve(__dirname, 'index.html'),
        hud: path.resolve(__dirname, 'hud-frame.html'),
      },
    },
  },
  ...(developmentNonce ? { html: { cspNonce: developmentNonce } } : {}),
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    }
  }
  });
});
