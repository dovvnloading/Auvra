# M0.4 — CI WebGL2 and WebGPU Visual Smoke Evidence

> **Status:** Verified CI **visual-smoke** results, not complete backend/node coverage or real-device performance benchmarking.
>
> **Tracking:** [M0.4 #292](https://github.com/dovvnloading/Auvra/issues/292), [M0 parent #279](https://github.com/dovvnloading/Auvra/issues/279).
>
> **GitHub Actions run:** [Verify #43411086653](https://github.com/dovvnloading/Auvra/actions/runs/43411086653), commit [`fabb98ac5158ac9d6d34b6e0aff101893ecac1e6`](https://github.com/dovvnloading/Auvra/commit/fabb98ac5158ac9d6d34b6e0aff101893ecac1e6), source branch of merged [PR #294](https://github.com/dovvnloading/Auvra/pull/294). Both `Rendering pictures` and `Rendering pictures on WebGPU` jobs finished **successfully**.
>
> **Artifact IDs:** WebGL2 `14030101869` (`rendering-pictures`), WebGPU `14030730044` (`rendering-pictures-webgpu`). Both include eleven `*.actual.png` screenshots and one `numbers.json` per backend.
>
> **Method:** We read the `numbers.json` file from each uploaded GitHub Actions artifact, not the historical `rendering-history` branch. These numbers were measured in the CI test harness under its software-GPU configuration. They are **single-run observations**, not medians or performance guarantees.

## 1. What the CI run verified

The runner reports successful image/reference comparisons on both renderers for:

`materials`, `lighting`, `shadows`, `reflections`, `bounce-light`, `post-lit`, `post-grade`, `crowd`, `physical-materials`, `car-paint`, and `texture-graph`.

This establishes **two complete renderer smoke suites passing for one captured commit**, including three physically/texture-focused scenes. It does **not** establish that every procedural graph node is supported by WebGPU texture *cooking*. The visual WebGPU renderer and the WebGPU texture graph evaluator are distinct subsystems.

The artifacts provide the following targeted scene numbers:

| Scene | WebGL2 load ms | WebGL2 reported frame ms | WebGPU load ms | WebGPU reported frame ms |
|---|---:|---:|---:|---:|
| `materials` | 2628.1 | 672.2 | 3731.8 | 632.8 |
| `physical-materials` | 5228.7 | 870.5 | 1321.1 | 664.3 |
| `car-paint` | 2467.4 | 512.9 | 1245.8 | 588.2 |
| `texture-graph` | 342.2 | 16.8 | 1128.5 | 299.5 |

**Do not read the table as a hardware performance contest.** The backends use different software adapter implementations, shader compilation paths, reporting scopes, and resource accounting. A single sample per scene is not a reliable speed comparison. In particular, WebGL2 `calls` and `triangles` are recorded while the WebGPU run reports those fields as `null`, so they are not comparable here.

### Memory-reporter caveat

In the same `texture-graph` smoke scene, `numbers.json` reported `gpuBytes` of `2,814,304` for WebGL2 and `139,038,312` for WebGPU. This is the harness's **estimated allocation counter**, not measured physical VRAM occupancy, and each backend accounts for a different set of resources. These values must **not** be treated as directly comparable GPU-memory regressions.

## 2. Reproducing the check

From a checkout at the commit above, with the frontend dependencies installed:

```powershell
cd "fbx-viewer (1)"
npm ci
node scripts/rendering/run.mjs
node scripts/rendering/run.mjs --renderer webgpu
```

The script uses a browser's software GPU and compares each fixed scene against its backend-specific reference picture. Generated screenshots and `numbers.json` live under `tests/visual/output/` and `tests/visual/output/webgpu/`. Use the CI workflow run's artifacts for the exact tested output and provenance.

For a real adapter rather than the software-GPU reference, the harness offers `node scripts/rendering/run.mjs --gpu` and `node scripts/rendering/run.mjs --gpu --renderer webgpu`, but results on a real adapter require an explicit GPU/browser/driver record and a *different* visual comparison policy. These commands have **not** been executed here on a real adapter.

## 3. M0.4 coverage classification after this evidence

| Capability | Evidence | Status |
|---|---|---|
| WebGL2 fixed visual scenes | Successful rendering/picture job, 11 output scenes | **CI verified on this commit** |
| WebGPU fixed visual scenes | Successful rendering/picture job, 11 output scenes | **CI verified on this commit** |
| Basic physical materials and car paint smoke | Both reference scenes present and their jobs passed | **CI verified as visual smoke** |
| Entire texture node registry under WebGL2 | `tests/frontend/textureNodeLibrary.test.ts` and other fixtures exist | **Not covered by this rendering smoke alone** |
| WebGPU procedural texture cooking parity | `tests/frontend/textureWebGpu.test.ts` covers mock passes/translation and supported compressed images | **Hardware/runtime execution matrix still required** |
| WebGPU code-mode custom structs and unsupported nodes | Known translator refusals and fallback path | **Fallback exists; actual end-to-end per-node examples pending** |
| WebGPU texture cooking with Paint stacks and UDIMs | Selective baked sources and fallback paths | **Needs targeted reference fixture** |
| Real hardware and device-loss recovery | No real adapter named in this report | **Not tested here** |
| Authoring latency at 512/2K/4K, cache and sparse paint memory | Existing scene captures are not authoring workload benchmarks | **M0.5 remains open** |

## 4. Next acceptance work

- [x] Preserve exact source commit, workflow run, two artifact IDs and smoke pass statuses.
- [x] Record a reproducible single-run materials/texture-graph evidence table with accuracy caveats.
- [ ] Build a graph-operation support matrix, not just renderer-scene screenshots.
- [ ] Capture named node failures and WebGPU→WebGL2 fallbacks from actual graph cooks, using [PR #294](https://github.com/dovvnloading/Auvra/pull/294)'s improved stable-node diagnostics.
- [ ] Execute field/reference comparisons for scatter, compressed sources, paint stacks, custom GLSL structs and nested curve graphs.
- [ ] Exercise backend recovery on device loss, rendering order A→B vs B alone, and repeated project reload.
- [ ] Repeat benchmarks on defined **real hardware tiers** with GPU/driver/browser metadata and multiple samples; then define cost/error thresholds.

**M0.4 remains open.** A successful visual smoke run establishes that the current scene fixtures render consistently, not that all promised backend features or performance targets are complete.
