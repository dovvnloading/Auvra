// Run from fbx-viewer (1) with node scripts/rendering/rigging.mjs.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { build } from 'vite';
import { SOFTWARE_WEBGL, openPage, closeBrowser, serve, pageErrors, pageSaid } from './browser.mjs';

const frontend = path.resolve(import.meta.dirname, '../..');
const fixture = path.join(frontend, 'tests/visual/rigging');
const output = path.join(frontend, 'tests/visual/output/rigging');
const work = mkdtempSync(path.join(tmpdir(), 'auvra-rigging-'));
let server, page;
try {
  const site = path.join(work, 'site');
  await build({
    root: fixture, configFile: false, plugins: [react()], logLevel: 'error', base: './',
    resolve: { alias: [{ find: /^\.\.\/\.\.\/\.\.\/context\/SceneContext$/, replacement: path.join(fixture, 'project.ts') }] },
    build: { outDir: site, minify: false, target: 'es2022', chunkSizeWarningLimit: 10000 },
  });
  server = await serve(site);
  page = await openPage({
    profileDir: path.join(work, 'profile'), url: `http://127.0.0.1:${server.address().port}/index.html`,
    windowSize: '1280,900', gpuFlags: SOFTWARE_WEBGL,
  });
  mkdirSync(output, { recursive: true });
  const script = expression => page.run(expression, 130_000, 'Rigging workflow timed out');
  const deadline = Date.now() + 60_000;
  while (!await script('Boolean(window.rigWorkflow)')) {
    if (Date.now() > deadline || pageErrors(page.client).length) throw new Error('Rigging fixture did not start');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  for (const step of ['fit', 'bind', 'pose', 'apply']) {
    const result = await script(`window.rigWorkflow.then(workflow => workflow.${step}())`);
    if (result) console.log(step, result);
    if (step !== 'apply') {
      const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(output, `${step}.png`), Buffer.from(data, 'base64'));
    }
  }
  const errors = pageErrors(page.client);
  if (errors.length) throw new Error(errors.join('\n'));
} catch (error) {
  if (page) console.error(...pageErrors(page.client), ...pageSaid(page.client));
  throw error;
} finally {
  page?.client.close();
  await closeBrowser(page?.browser, path.join(work, 'profile'));
  server?.close();
  rmSync(work, { recursive: true, force: true });
}
