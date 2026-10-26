import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// The standalone player must not pull in the editor's host bridge, project
// persistence, or editor scene state. Bundle the real entry with esbuild and
// reject any forbidden module that reaches its import graph.
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const FORBIDDEN = [
  "host/bootstrap",
  "host/nativeTransport",
  "host/fakeHost",
  "utils/projectService",
  "utils/db",
  "context/SceneContext",
];
const forbiddenPattern = (name) => new RegExp(`(?:^|/)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\.[^/]+|/|$)`);
const patterns = FORBIDDEN.map((name) => [name, forbiddenPattern(name)]);

// Vite-only import suffixes (?worker, ?url, ?raw, ...) have no esbuild
// equivalent; keep them out of the graph instead of failing the bundle.
const viteQueryImports = {
  name: "vite-query-imports",
  setup(builder) {
    builder.onResolve({ filter: /\?[a-z-]+(?:&[a-z-]+)*$/ }, (args) => ({ path: args.path, external: true }));
  },
};

async function inputsOf(options) {
  const result = await build({
    absWorkingDir: root,
    bundle: true,
    write: false,
    metafile: true,
    outdir: "out",
    platform: "browser",
    format: "esm",
    logLevel: "silent",
    loader: {
      ".png": "file", ".jpg": "file", ".jpeg": "file", ".gif": "file", ".webp": "file", ".svg": "file",
      ".hdr": "file", ".exr": "file", ".glb": "file", ".gltf": "file", ".fbx": "file", ".ktx2": "file",
      ".wasm": "file", ".mp3": "file", ".ogg": "file", ".wav": "file", ".woff": "file", ".woff2": "file", ".ttf": "file",
    },
    plugins: [viteQueryImports],
    ...options,
  });
  return Object.keys(result.metafile.inputs).map((input) => input.replace(/\\/g, "/"));
}

const violationsIn = (inputs) => inputs.flatMap((input) => patterns
  .filter(([, pattern]) => pattern.test(input))
  .map(([name]) => `${name} (${input})`));

const failures = [];
try {
  // Control: the detector must recognize a forbidden module when one is present.
  const control = await inputsOf({ stdin: { contents: 'import "./host/fakeHost.ts";', resolveDir: root, loader: "ts" } });
  if (!violationsIn(control).some((violation) => violation.startsWith("host/fakeHost"))) {
    failures.push("forbidden-module detector did not flag a direct host/fakeHost import");
  }
  const inputs = await inputsOf({ entryPoints: ["player/main.tsx"] });
  if (!inputs.includes("player/main.tsx")) failures.push("player entry is missing from its own bundle graph");
  for (const violation of violationsIn(inputs)) failures.push(`player bundle includes forbidden module ${violation}`);
  if (!failures.length) console.log(`Player bundle isolation passed (${inputs.length} inputs checked)`);
} catch (error) {
  const detail = error?.errors?.length
    ? error.errors.map((entry) => `${entry.location?.file ?? "<unknown>"}: ${entry.text}`).join("\n")
    : error instanceof Error ? error.message : String(error);
  failures.push(`player bundle failed: ${detail}`);
}

if (failures.length) {
  console.error(failures.map((failure) => `FAIL: ${failure}`).join("\n"));
  process.exitCode = 1;
}
