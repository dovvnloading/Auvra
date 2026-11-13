// Run the same planner as the parameter inspector without a browser or GPU.
// Only this checkout's source enters esbuild. Project JSON is plain input.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

try {
    const built = await build({
        absWorkingDir: fileURLToPath(new URL('../../', import.meta.url)),
        stdin: { resolveDir: fileURLToPath(new URL('../../', import.meta.url)), contents: `
            export { readTextureRenameInventory } from './texturing/graph/renameSnapshot';
            export { planTextureParameterRename } from './texturing/graph/renameProjectParameter';
        ` },
        bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
    });
    const { readTextureRenameInventory, planTextureParameterRename } = await import(
        'data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].contents).toString('base64')
    );
    const { snapshot, sourceMaterialId, from, to } = JSON.parse(readFileSync(0, 'utf8'));
    const inventory = readTextureRenameInventory(snapshot, null, snapshot);
    const { impact, changes, undoChanges } = planTextureParameterRename({ ...inventory, sourceMaterialId, from, to });
    process.stdout.write(JSON.stringify({ impact, changes, undoChanges }));
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
