// The material command line's work on a graphics card (Auvra/project/material_commands.py: cook, ball and
// bake-mesh-maps), done with the editor closed: the editor's own evaluator, ball renderer and baker run in a headless
// browser on its software GPU (scripts/materials/page), as the rendering pictures are drawn.
//
//   node scripts/materials/headless.mjs JOB.json
//
// JOB.json holds what the page takes (scripts/materials/page/main.ts MaterialJob: command, target, size, samples,
// intoProject and the project's documents), and where things are:
//   content  the project's Content folder, whose files the page reads by asset id
//   out      the folder the pictures are written to
//   result   the file the result is written to (what each picture is, and documents that keep them in the project)
// The page is built once for the editor's code as it is, and kept in the system's temporary folder until it changes.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOFTWARE_WEBGL, browserPath, closeBrowser, openPage, pageErrors, pageSaid, serve } from '../rendering/browser.mjs';

const JOB_LIMIT_MS = 1_800_000;
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pageDir = path.join(projectDir, 'scripts/materials/page');
const ASSET_ID = /^[0-9a-f]{64}$/;
const FILE_NAME = /^[\w.-]{1,160}\.png$/;
/** Folders the page's code is built from: a change in any of them builds it again. */
const SOURCES = ['components', 'context', 'diagnostics', 'host', 'renderer', 'runtime', 'scripts/materials/page', 'texturing', 'utils', 'workers', 'vendor', 'types.ts', 'package-lock.json'];

/** A signature of the editor's code as it is now: every source file's path, size and time of change. */
const sourceSignature = () => {
  const hash = createHash('sha256');
  const visit = (at) => {
    const info = statSync(at);
    if (info.isDirectory()) {
      for (const name of readdirSync(at).sort()) if (name !== 'node_modules') visit(path.join(at, name));
      return;
    }
    hash.update(`${path.relative(projectDir, at)}|${info.size}|${info.mtimeMs}\n`);
  };
  for (const source of SOURCES) if (existsSync(path.join(projectDir, source))) visit(path.join(projectDir, source));
  return hash.digest('hex').slice(0, 16);
};

/** The built page, made if the code changed since it was last built (and older builds removed). */
const builtPage = async () => {
  const signature = sourceSignature();
  const prefix = 'auvra-material-page-';
  const siteDir = path.join(tmpdir(), `${prefix}${signature}`);
  if (existsSync(path.join(siteDir, 'index.html'))) return siteDir;
  for (const name of readdirSync(tmpdir())) {
    if (name.startsWith(prefix)) rmSync(path.join(tmpdir(), name), { recursive: true, force: true });
  }
  const [{ default: react }, { build }] = await Promise.all([import('@vitejs/plugin-react'), import('vite')]);
  console.log('Building the material page for this version of the editor...');
  const building = `${siteDir}-building`;
  await build({
    configFile: false,
    root: pageDir,
    base: './',
    logLevel: 'error',
    plugins: [react()],
    resolve: { alias: { '@': projectDir } },
    build: { outDir: building, emptyOutDir: true, chunkSizeWarningLimit: 100000, minify: false },
  });
  rmSync(siteDir, { recursive: true, force: true });
  // Renamed once whole, so a build cut short is never taken for one.
  renameSync(building, siteDir);
  return siteDir;
};

const readManifest = (content) => {
  try {
    return JSON.parse(readFileSync(path.join(content, 'manifest.json'), 'utf8'));
  } catch {
    return {};
  }
};

const main = async () => {
  const jobFile = process.argv[2];
  if (!jobFile) throw new Error('Name the job file: node scripts/materials/headless.mjs JOB.json');
  // Whether the work can run here: a browser to run it in.
  if (jobFile === '--check') {
    browserPath();
    return;
  }
  const { content, out, result: resultFile, ...job } = JSON.parse(readFileSync(jobFile, 'utf8'));
  mkdirSync(out, { recursive: true });
  const manifest = readManifest(content);
  const siteDir = await builtPage();
  const profileDir = mkdtempSync(path.join(tmpdir(), 'auvra-material-profile-'));
  let browser = null;
  // The project's files by asset id, read only; pictures the page makes, written into `out` by plain file name.
  const server = await serve(siteDir, (request, response) => {
    const url = new URL(request.url, 'http://local');
    if (url.pathname.startsWith('/project/')) {
      const assetId = decodeURIComponent(url.pathname.slice('/project/'.length));
      const file = path.join(content, 'sha256', assetId);
      if (!ASSET_ID.test(assetId) || !existsSync(file)) response.writeHead(404).end();
      else response.writeHead(200, { 'content-type': manifest[assetId]?.mime ?? 'application/octet-stream' }).end(readFileSync(file));
      return true;
    }
    if (url.pathname.startsWith('/out/') && request.method === 'PUT') {
      const name = decodeURIComponent(url.pathname.slice('/out/'.length));
      if (!FILE_NAME.test(name)) {
        response.writeHead(400).end();
        return true;
      }
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        writeFileSync(path.join(out, name), Buffer.concat(chunks));
        response.writeHead(204).end();
      });
      return true;
    }
    return false;
  });
  try {
    const { address, port } = server.address();
    const page = await openPage({ profileDir, gpuFlags: SOFTWARE_WEBGL, url: `http://${address}:${port}/index.html` });
    browser = page.browser;
    const start = Date.now();
    while (!(await page.run('!!window.auvraMaterials', 60_000))) {
      if (Date.now() - start > 60_000) throw new Error(`The material page did not load:\n${pageErrors(page.client).join('\n')}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const from = page.client.events.length;
    const result = await page.run(`window.auvraMaterials.run(${JSON.stringify(job)})`, JOB_LIMIT_MS, 'The work took too long').catch((error) => {
      // What went wrong in plain words first; where in the code, and what the page warned of, after.
      const [said, ...where] = error.message.split('\n');
      const warned = pageSaid(page.client, from);
      throw new Error([said.replace(/^\w*Error: /, ''), ...(process.env.AUVRA_DEBUG ? where : []), ...(warned.length ? ['The page said:', ...warned.map((line) => `  ${line}`)] : [])].join('\n'));
    });
    writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
    page.client.close();
  } finally {
    server.close();
    await closeBrowser(browser, profileDir);
  }
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
