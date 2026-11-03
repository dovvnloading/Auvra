// Compiles the FBX importer to WebAssembly: vendor/fbxImporter/fbxImporter.wasm, which is committed so
// that nobody needs a C compiler to run or build the editor. Only changing the C sources needs this.
//
//   pip install ziglang==0.16.0
//   node vendor/fbxImporter/build.mjs
//
// Zig is used as a self-contained C compiler with a WebAssembly libc. The result imports nothing.

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const python = process.env.AUVRA_ZIG_PYTHON || 'python';
const output = path.join(here, 'fbxImporter.wasm');
const cache = path.join(process.env.AUVRA_FBX_BUILD_CACHE || path.join(here, '.build'));

const zig = (args) => {
  const result = spawnSync(python, ['-m', 'ziglang', ...args], { cwd: here, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

const COMMON = ['-target', 'wasm32-wasi', '-O2', '-std=c11', '-DNDEBUG', '-fno-sanitize=undefined', '-msimd128', '-mbulk-memory', '-mexec-model=reactor'];

// ufbx takes much the longest to compile and rarely changes, so its object file is kept.
const UFBX_FEATURES = ['-DUFBX_NO_STDIO', '-DUFBX_NO_SUBDIVISION', '-DUFBX_NO_TESSELLATION', '-DUFBX_NO_GEOMETRY_CACHE', '-DUFBX_NO_SCENE_EVALUATION', '-DUFBX_NO_SKINNING_EVALUATION', '-DUFBX_NO_ERROR_STACK'];

const fresh = (object, sources) => existsSync(object) && sources.every((source) => statSync(source).mtimeMs <= statSync(object).mtimeMs);

const compile = (source, object, extra = []) => {
  if (fresh(object, [path.join(here, source), fileURLToPath(import.meta.url)])) return;
  console.log(`compiling ${source}`);
  zig(['cc', ...COMMON, ...extra, '-c', source, '-o', object]);
};

import('node:fs').then(({ mkdirSync }) => {
  mkdirSync(cache, { recursive: true });
  const ufbx = path.join(cache, 'ufbx.o');
  const mikktspace = path.join(cache, 'mikktspace.o');
  const importer = path.join(cache, 'fbx_importer.o');
  compile('../ufbx/ufbx.c', ufbx, UFBX_FEATURES);
  compile('../mikktspace/mikktspace.c', mikktspace);
  compile('fbx_importer.c', importer, UFBX_FEATURES);
  console.log('linking');
  zig(['cc', ...COMMON, ufbx, mikktspace, importer, '-lm', '-o', output,
    '-Wl,--gc-sections', '-Wl,-z,stack-size=8388608', '-Wl,--initial-memory=33554432', '-Wl,--max-memory=4294901760', '-s']);
  console.log(`${path.relative(process.cwd(), output)}: ${(statSync(output).size / 1024).toFixed(0)} KB`);
});
