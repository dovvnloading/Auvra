# Texture Suite M0.4 — GPU Capability Evidence

> **Status:** Source + passing **software-adapter CI** evidence. This is not a certification of the user's GPU, hardware drivers, or complete texture-node coverage.
>
> **Milestone:** [M0 #279](https://github.com/dovvnloading/Auvra/issues/279), [M0.4 issue #292](https://github.com/dovvnloading/Auvra/issues/292).
>
> **Evidence commit:** `fabb98ac5158ac9d6d34b6e0aff101893ecac1e6` ([PR #294](https://github.com/dovvnloading/Auvra/pull/294)), CI [Verify run #43411086653](https://github.com/dovvnloading/Auvra/actions/runs/43411086653), November 13, 2026.
>
> **Important:** A test that compares with a fixed renderer-specific screenshot does **not** establish exact cross-backend pixel equality. A test that only executes conditionally on a device feature cannot establish that the device had that feature unless the run logs prove it.

## 1. Definitions used in the capability matrix

- **Source-present:** implementation exists; not a passing device test.
- **Unit-verified:** executable tests cover code or mocks; not device-wide shader behavior.
- **Visual-verified (software):** GitHub Actions completed a scene on its selected SwiftShader/software adapter, and compared with that renderer's visual reference under the repository tolerance.
- **Conditional visual proof:** scene contains an embedded operation, but execution depends on a capability flag not independently logged in the cited run.
- **Unsupported/approximate:** a documented limitation/fallback; do not label as a pass.
- **Not tested:** no current evidence on the requested backend/device.

## 2. What CI actually demonstrated

| Reference | Backend requested | CI result | Reported scene metrics | Meaning |
|---|---|---|---|---|
| [Rendering pictures (WebGL2)](https://github.com/dovvnloading/Auvra/actions/runs/43411086653/job/131838089601) | WebGL2/software | **Success** | `texture-graph`: 342 ms scene load; 16.8 ms reported frame; ~2.7 MiB estimated GPU allocation | One fixed proof texture graph renders within the WebGL2 visual baseline |
| [Rendering pictures on WebGPU](https://github.com/dovvnloading/Auvra/actions/runs/43411086653/job/131838089595) | WebGPU/SwiftShader | **Success** | `texture-graph`: 1,129 ms scene load; 299.5 ms reported frame; ~132.6 MiB estimated GPU allocation | The WebGPU scene matched its reference. Individual graph operations and the cooking backend were not recorded in this run |
| Same WebGL2 job | WebGL2/software | **Success** | `physical-materials`: 5,229 ms load; 870.5 ms frame; `car-paint`: 2,467 ms load; 512.9 ms frame | Separate reference scenes for physical materials; **not** authoring-paint benchmarks |
| Same WebGPU job | WebGPU/SwiftShader | **Success** | `physical-materials`: 1,321 ms load; 664.3 ms frame; `car-paint`: 1,246 ms load; 588.2 ms frame | The renderer-specific physical material scenes matched their WebGPU references |

The WebGPU `texture-graph` comparison reported **0.220% differing pixels (worst channel difference 142)** under the harness's per-channel threshold and 0.5% allowed differing-pixel share. It was marked **same**, not identical. The corresponding WebGL2 comparison was 0.000% in this run.

**Do not compare the WebGL2 and WebGPU numbers above as an optimization result.** Software adapters, pipeline initialization, synchronization, memory estimators, and scene code paths differ. These are one-run provenance points, not p50/p95 measurements. They also predate subsequent code changes and do not certify current `main`.

## 3. Feature-by-feature evidence

| Operation/family | Editor WebGL2 | Player WebGPU texturing | Native renderer | Evidence and remaining gap |
|---|---|---|---|---|
| Base procedural texture graph, perlin/tiles/blend | Source-present; fixed scene visual-verified | Cooking backend not recorded | Not tested for feature equivalence | `tests/visual/textureGraphScene.tsx` proof graph; full per-node matrix not tested |
| Height-to-normal graph output | Visual-verified (software) | Cooking backend not recorded | Not tested | Fixed graph includes `normalFromHeight`; image output is encoded and displayed |
| Pixel processor function graph | Visual-verified (software) | Cooking backend not recorded | Not tested | Fixed graph uses `pixelProcessor` function with mix/sample |
| Instanced scatter and four layering modes | Source-present, embedded GPU reference | Included in fixture; execution not independently recorded | Not tested | `checkScatterParity` tests specific interior/edge pixels in `higher`, `over`, `max`, `add` |
| BC1 compressed texture input | Source and unit tests exist | **Verified on the #316 software adapter** | Not tested | Both feature flags were present and the fixture sampled the expected stripes; the whole graph separately fell back to WebGL2. [Windows job](https://github.com/dovvnloading/Auvra/actions/runs/43499845786/job/132142495087), [artifact](https://github.com/dovvnloading/Auvra/actions/runs/43499845786/artifacts/14072569068) |
| Applied paint-stack snapshot input | Source and visual fixture present | Included in fixture; execution not independently recorded | Not tested | `checkPaintSnapshotParity` tests base color, packed ORM channels and sample pixels; **not** all paint-stack modes or full layers |
| GLSL code-mode structures | WebGL2 shader path present | Unsupported/explicit translator rejection for affected structures | Not tested | `tests/frontend/textureWebGpu.test.ts` verifies intentional rejection; strict game cook falls back to WebGL2 |
| Full in-editor WebGPU graph cooking | Existing editor defaults to WebGL2 | Game-time device can use WebGPU | Not established | `texturing/gpu/cookingDevice.ts` and `runtime/materials/graphCooker.ts`; no editor UI-switch acceptance yet |
| Anisotropy, clearcoat, tint, sheen, flakes | Physical renderer features in source and reference scenes | Renderer-specific physical scene baseline passing; complete channel parity **not verified** | Not tested | No per-channel cross-renderer error budget or sampled texture-map round trip yet |
| Dynamic per-object materials, capture, 4K/UDIM | Source present in selected subsystems | Not tested end-to-end by this fixture | Not tested | Requires real-world game scenes, state transitions, memory/driver and export tests |
| WebGPU fallback diagnostics | Strict cook, WebGL2 fallback in source | Source/unit verified; displays stable node ID, type, name after [PR #294](https://github.com/dovvnloading/Auvra/pull/294) | Not relevant | Still need real device-loss and fallback playback fixture |

The native `wgpu` viewport is **not** the same thing as the established editor WebGL2 painting/graph toolchain. Avoid carrying a source capability across a renderer boundary without a test.

## 4. How to reproduce the proven tests

From `fbx-viewer (1)` on a machine with the project's required Node/browser dependencies:

```powershell
npm ci
npm run rendering:verify -- --only texture-graph
npm run rendering:verify -- --renderer webgpu --only texture-graph
npm test -- tests/frontend/textureWebGpu.test.ts
```

The visual harness is `scripts/rendering/run.mjs` and its graph scene lives at `tests/visual/textureGraphScene.tsx`. CI uses software adapters for deterministic reference images. Run with `--gpu` on a real GPU to gather machine-specific costs; that mode does not compare against software reference images.

For every new device-backed claim, record exact commit, OS/driver, browser version, GPU/adapter and capabilities, chosen renderer, graph hash and output size, test command, screenshots/PNG hashes and failure/recovery logs. Mark unexecuted conditional operations **not tested**, rather than treating a scene's success as proof of absent adapter features.

New WebGPU `texture-graph` captures write `bc1Parity` under `texture-graph` in `tests/visual/output/webgpu/numbers.json`. The report records `webgpuBC` from the active device and `webgl2S3TC` from the WebGL2 texturing context. A missing feature yields `not-tested` with a reason. With both features, `verified` means four sampled pixels from the BC1 fixture matched across both backends and reproduced the fixture’s red and green stripes within four byte levels per RGB channel. A drawing, readback or comparison error yields `failed` with the diagnostic and fails the rendering check. The historical CI run above predates this report.

### Saved material compression fixtures

The ordinary `texture-graph` capture also writes `materialCompression` to the scene's `numbers.json` entry. Run both rendering commands above to collect independent WebGL2 and WebGPU observations. Each capture records the cooking context's adapter information exposed by the browser and the feature checked for each saved material format.

| Saved format | WebGL2 extension | WebGPU device feature | Channels checked |
|---|---|---|---|
| BC4 signed | EXT_texture_compression_rgtc | texture-compression-bc | R data, zero G/B, opaque alpha |
| BC5 | EXT_texture_compression_rgtc | texture-compression-bc | R/G data, zero B, opaque alpha |
| BC7 | EXT_texture_compression_bptc | texture-compression-bc | RGBA |
| ETC2 RGB8 | WEBGL_compressed_texture_etc | texture-compression-etc2 | RGB, opaque alpha |
| ETC2 RGBA8 EAC | WEBGL_compressed_texture_etc | texture-compression-etc2 | RGBA |
| ASTC 4×4 | WEBGL_compressed_texture_astc | texture-compression-astc | RGBA |

For each supported format Auvra encodes an 8×8 two-stripe picture, loads it through the saved material texture path, samples the texture into an RGBA8 target, and compares all 64 pixels with the expected channels. The tolerance is four byte levels per component. A missing feature yields `not-tested`. A readback or assertion error yields `failed` with a diagnostic and fails the run. The six fixtures use a single mip level and a linear data texture. They run after the scene screenshot and timed frames. The opt-in benchmarks omit these extra draws.

### Clearcoat texture controls

In the ordinary `physical-materials` capture, `clearcoatMap` compares an opaque physical sphere at coat factors zero and one to the same sphere drawn with a texture in the clearcoat slot. The two 1×1 data maps use red values zero and one, with green and blue set to the opposite value. On each renderer the central sample region must contain at least 32 pixels where the two scalar controls differ by eight byte levels. Mean RGB error for each map against its own scalar must be at most one fourth of the scalar contrast. The report records the sample count, scalar contrast and both errors. WebGPU approximates coat by modifying roughness and albedo, so a match on these controls establishes map binding and red-channel sampling within each renderer. It does not compare the two renderers' BRDFs.

## 5. Gates still needed before M0.4 can close

- [ ] Generate or curate an explicit per-node-family WebGL2 vs WebGPU **code/capability** matrix. Unsupported and fallback must be recorded separately.
- [ ] Record device capabilities and **actual execution** of BC/ETC2/ASTC input tests; add representative compressed image visual fixtures.
- [ ] Compare coat/sheened/anisotropic/transparent materials with repeatable sampled texture inputs between backends, with accepted quantitative/visual tolerances.
- [ ] Prove device-loss recovery, interrupted cancellation, shader compile failure, image cache invalidation and reuse of GPU resources across scene transitions.
- [ ] Cover scan/capture, layered painting and a multi-UDIM authoring workflow, not just applied snapshots.
- [ ] Run and document actual hardware devices, not only SwiftShader, and store results alongside the historical scene and new M0.5 cook-benchmark reports.
- [ ] Define an editor WebGPU feature flag only once editor-specific integration and interaction tests pass; preserve default WebGL2 compatibility.

The ordinary WebGPU `texture-graph` capture runs a controlled device-loss fixture after the scene is unmounted. It draws red then green on a shared texture target pool, destroys that device, awaits its loss notification, and checks that the same green image can be drawn from scratch on a distinct replacement. A successful run records the sampled RGBA values and loss reason in `texture-graph.deviceLoss` in the WebGPU `numbers.json`. A mismatch fails the rendering job. This exercises explicit destruction and reacquisition. Physical driver resets, cancellation during a live graph cook and scene-wide isolation still require separate fixtures.

A separate `sourceEdit` fixture draws a Bitmap connected to a material output. It changes the source pixels under the same texture ID, cancels after the Bitmap finishes recooking, and reads the retained red output. Retrying must draw only the pending output, display green, and leave the externally retained old image red. The fixture also checks that a separate target stays cached and disposal returns live texture target bytes to their initial count. Both ordinary renderer jobs record this result after the captured frame.

**Completion rule:** A feature is only verified for the specific backend, fixture and adapter actually exercised. M0.4 stays open until those device-backed gates are met.
