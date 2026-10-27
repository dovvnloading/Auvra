import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Loaded when a frame is bundled, so the page helpers import without it.
const esbuild = () => import('esbuild');

/**
 * The HUD and gameplay-script sandboxes are iframes with an opaque origin (sandbox="allow-scripts").
 * A module script or a crossorigin stylesheet is a CORS request from origin "null", which the Vite
 * dev server, the packaged editor's virtual host (DenyCors) and ordinary web hosts all refuse, so the
 * frame would never start. Each frame therefore loads its code as one classic script and its
 * stylesheet without crossorigin: plain no-cors loads that every host serves, still checked by the
 * frame's own CSP.
 */
export const SANDBOX_FRAMES = [
  { page: 'hud-frame.html', entry: 'hud-frame.tsx', name: 'hud-frame', stylesheet: true },
  { page: 'script-frame.html', entry: 'script-frame.ts', name: 'script-frame', stylesheet: false },
];

/** Where the dev server serves a frame's classic bundle. */
export const devFrameScript = (frame) => `/@auvra-frame/${frame.name}.js`;

/** The browsers Vite's default build target covers. */
const TARGET = ['es2020', 'chrome87', 'edge88', 'firefox78', 'safari14'];

const bundleOptions = (root, frame, production) => ({
  absWorkingDir: root,
  entryPoints: [path.resolve(root, frame.entry)],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: TARGET,
  jsx: 'automatic',
  // The stylesheet is linked by the page; the bundle carries code only.
  loader: { '.css': 'empty' },
  define: { 'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development') },
  minify: production,
  legalComments: 'none',
  write: false,
  logLevel: 'silent',
});

const escapeAttribute = (value) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const script = (src) => `<script src="${escapeAttribute(src)}"></script>`;

/**
 * The frame page with its module script and module preloads removed, its stylesheets loaded
 * without crossorigin, and `src` (a classic bundle) run at the end of the body.
 */
export const classicFramePage = (html, src, stylesheet = null) => {
  let page = html
    .replace(/[ \t]*<script\b[^>]*\btype=["']module["'][^>]*>[\s\S]*?<\/script>[ \t]*\r?\n?/gi, '')
    .replace(/[ \t]*<link\b[^>]*\brel=["']modulepreload["'][^>]*>[ \t]*\r?\n?/gi, '')
    .replace(/(<link\b[^>]*\brel=["']stylesheet["'][^>]*?)\s+crossorigin(?:=["'][^"']*["'])?/gi, '$1');
  // New tags take the closing tag's indentation, one level deeper.
  if (stylesheet) {
    page = page.replace(/([ \t]*)<\/head>/i, (_match, indent) => `${indent}  <link rel="stylesheet" href="${escapeAttribute(stylesheet)}">\n${indent}</head>`);
  }
  if (!/<\/body>/i.test(page)) throw new Error('Auvra sandbox frame page has no body');
  return page.replace(/([ \t]*)<\/body>/i, (_match, indent) => `${indent}  ${script(src)}\n${indent}</body>`);
};

/** Chunks only the given entries reach, which no other entry needs once they are replaced. */
const chunksOnlyReachedFrom = (bundle, entryFileNames) => {
  const reach = (start, seen) => {
    const stack = [...start];
    while (stack.length) {
      const name = stack.pop();
      const chunk = bundle[name];
      if (seen.has(name) || !chunk || chunk.type !== 'chunk') continue;
      seen.add(name);
      stack.push(...chunk.imports, ...chunk.dynamicImports);
    }
    return seen;
  };
  const others = Object.values(bundle)
    .filter((output) => output.type === 'chunk' && output.isEntry && !entryFileNames.includes(output.fileName))
    .map((output) => output.fileName);
  const neededElsewhere = reach(others, new Set());
  return [...reach(entryFileNames, new Set())].filter((name) => !neededElsewhere.has(name));
};

/**
 * Vite plugin: serves (dev) and emits (build) the sandbox frames as classic-script pages.
 * `frameCsp` is the policy the frame pages carry in place of their placeholder.
 */
export const classicSandboxFrames = ({ root, frameCsp }) => {
  const contexts = new Map();
  let base = '/';
  return {
    name: 'auvra-classic-sandbox-frames',
    enforce: 'post',
    configResolved(config) {
      base = config.base;
    },
    configureServer(server) {
      // Ahead of Vite's own HTML handling, so the frames get no dev client or module scripts.
      server.middlewares.use(async (request, response, next) => {
        const url = (request.url ?? '').split('?')[0];
        const frame = SANDBOX_FRAMES.find((item) => url === `/${item.page}` || url === devFrameScript(item));
        if (!frame || request.method !== 'GET') {
          next();
          return;
        }
        try {
          let body;
          let type;
          if (url === devFrameScript(frame)) {
            let bundler = contexts.get(frame.name);
            if (!bundler) {
              bundler = await (await esbuild()).context(bundleOptions(root, frame, false));
              contexts.set(frame.name, bundler);
            }
            const result = await bundler.rebuild();
            body = result.outputFiles[0].text;
            type = 'text/javascript; charset=utf-8';
          } else {
            const html = (await readFile(path.resolve(root, frame.page), 'utf8')).replace(/__AUVRA_(?:HUD|SCRIPT)_CSP__/, frameCsp);
            body = classicFramePage(html, devFrameScript(frame), frame.stylesheet ? '/styles.css' : null);
            type = 'text/html; charset=utf-8';
          }
          response.statusCode = 200;
          response.setHeader('Content-Type', type);
          response.setHeader('Cache-Control', 'no-store');
          response.end(body);
        } catch (error) {
          next(error);
        }
      });
      server.httpServer?.once('close', () => {
        contexts.forEach((bundler) => bundler.dispose());
        contexts.clear();
      });
    },
    generateBundle: {
      // After Vite has written the frame pages, before the player template records every file.
      order: 'post',
      async handler(_options, bundle) {
        const frames = SANDBOX_FRAMES.filter((frame) => bundle[frame.page]?.type === 'asset');
        if (!frames.length) return;
        const replaced = frames.map((frame) => Object.values(bundle)
          .find((output) => output.type === 'chunk' && output.isEntry && output.facadeModuleId?.split(path.sep).join('/').endsWith(`/${frame.page}`))?.fileName)
          .filter(Boolean);
        for (const frame of frames) {
          const result = await (await esbuild()).build(bundleOptions(root, frame, true));
          const code = result.outputFiles[0].contents;
          const hash = createHash('sha256').update(code).digest('base64url').slice(0, 8).replace(/[-_]/g, 'x');
          const fileName = `assets/${frame.name}-${hash}.js`;
          this.emitFile({ type: 'asset', fileName, source: code });
          const page = bundle[frame.page];
          page.source = classicFramePage(String(page.source), `${base}${fileName}`);
        }
        // The frames' module chunks are no longer loaded by anything.
        for (const name of chunksOnlyReachedFrom(bundle, replaced)) delete bundle[name];
      },
    },
  };
};
