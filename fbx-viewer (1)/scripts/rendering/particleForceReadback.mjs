// From the editor directory: node scripts/rendering/particleForceReadback.mjs
// Set AUVRA_BROWSER to a local Chromium executable when it is outside the standard locations.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { closeBrowser, openPage, pageErrors, serve, SOFTWARE_WEBGL } from './browser.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const site = mkdtempSync(path.join(tmpdir(), 'auvra-particle-readback-'));
let server;
try {
    await build({
        entryPoints: [path.join(root, 'tests/visual/particleForceReadback.js')],
        outfile: path.join(site, 'probe.js'), bundle: true, define: { 'process.env.NODE_ENV': '"production"' },
    });
    writeFileSync(path.join(site, 'index.html'), '<!doctype html><script src="./probe.js"></script>');
    server = await serve(site);
    const { port } = server.address();
    for (const backend of ['webgl2', 'webgpu']) {
        const profileDir = path.join(site, backend);
        const gpuFlags = backend === 'webgl2' ? SOFTWARE_WEBGL : [
            '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader',
            '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', ...(process.platform === 'linux' ? ['--use-angle=vulkan', '--disable-vulkan-surface'] : []),
        ];
        const page = await openPage({ url: `http://127.0.0.1:${port}/index.html`, profileDir, gpuFlags });
        try {
            const deadline = Date.now() + 15000;
            while (!(await page.run('typeof window.checkParticleForces === "function"', 2000))) {
                if (Date.now() >= deadline) throw new Error(`Failed to load particle fixture: ${pageErrors(page.client).join('\n')}`);
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            const cases = await page.run(`window.checkParticleForces(${JSON.stringify(backend)})`, 30000);
            console.log(`${backend}: ${cases.join(', ')}`);
        } finally {
            page.client.close();
            await closeBrowser(page.browser, profileDir);
        }
    }
} finally {
    server?.close();
    rmSync(site, { recursive: true, force: true });
}
