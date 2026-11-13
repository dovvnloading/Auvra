# Texture Suite M0 — Initial Source Audit and Baseline Plan

> **Status:** M0.1 source inspection **started**; all runtime, visual, performance, and hardware verification below is **pending**, unless explicitly marked as an existing test (the presence of a test is not proof it passed in this audit).
>
> **Audited repository revision:** `f8161a5eea25c80ef69e7be474799ef0ca254202` (merged [texture suite roadmap](../TEXTURE_SUITE_EXPANSION_ROADMAP.md))
>
> **Tracking:** [M0 milestone issue #279](https://github.com/dovvnloading/Auvra/issues/279)
>
> **Date:** 2026-11-12 (America/New_York)
>
> **Method:** static inspection of source, existing tests, docs and known issues; **no local GPU test execution or empirical benchmarks**. Do not interpret this document as a passed regression suite.

## 1. Objectives of this first pass

- Capture a truthful current implementation baseline before planning M1–M3 changes.
- Reconcile the 20 historically open items in `MATERIAL_AND_TEXTURE_ROADMAP.md` against the actual repository.
- Separate **code-confirmed** limitations from **partial/stale roadmap statements** and **unverified runtime behaviors**.
- Identify the shortest high-severity regression queue, required fixtures, and the contracts that M0.3/M0.4 must finalize.

**Deliverable boundary:** this document begins M0. It does not close M0 or implement features. Code fixes and visual validation require focused follow-up PRs.

## 2. Current architecture and capability inventory

Status definitions: **Present in source** = a concrete implementation exists; **Partial / gated** = available only for stated paths or incomplete; **Needs verification** = code/tests alone do not establish user-visible correctness.

| Subsystem | Evidence in source | Initial assessment / next proof |
|---|---|---|
| Procedural texture graph | `texturing/graph/registry.ts`, `evaluator.ts`, `iterate.ts`, `functionGraph.ts`; `tests/frontend/textureGraph.test.ts`, `textureIterate.test.ts` | **Present in source.** Re-evaluate complex nested graphs and cache invalidation under source/parameter changes. |
| Typed image, value, material and curve ports | `texturing/graph/types.ts`, `nodes/materials.ts`, `nodes/splines.ts`; `textureMaterial.test.ts`, `textureCurveWires.test.ts` | **Present in source.** Curve ports on ordinary nodes exist; nested graph boundary lacks matching curve IO (see #7). |
| Exposed parameters, presets and history | `texturing/graph/parameters.ts`; `components/Texturing/TextureGraphWorkspace.tsx`; `textureParameters.test.ts` | **Present in source.** Rename only changes its own graph+values; cross-asset references are not part of this function (#6). |
| Mesh weathering, iterative image operations | `texturing/graph/nodes/weathering.ts`, `graph/iterate.ts`, `graph/flood.ts` | **Present in source.** Weathering uses static masks; a topology-aware transport solver is not evident (#4). Flood-box approximation is explicit (#2). |
| Painting and sparse pages | `texturing/paint/paintTypes.ts`, `paintStack.ts`, `sparsePicture.ts`; `paintSeams.test.ts` and `paintSpeed.test.ts` | **Present in source.** Seven paint channels; M2 must map to physical surface features rather than assume paint support. |
| Physical shader surface | `runtime/materials/materialGraph.ts`, `physicalSurface.ts`; `physicalMaterial.test.ts` | **Present in source.** Coat, sheen, anisotropy, thin film, transmission etc. are in shader graph; not equivalent to paint-channel or GPU backend parity. |
| Mesh baking and UDIM UV | `texturing/bake/`, `texturing/uv/`, `paint/gltfExport.ts`; `paintGltf.test.ts`, `uvWork.test.ts` | **Present in source.** Need targeted edge-crossing triangles, mip/atlas and whole-model multi-set export fixtures (#9–10). |
| WebGL2 texture cooking | `texturing/gpu/textureGpu.ts`, `texturing/graph/evaluator.ts` | **Present in source.** Default editor cooking remains WebGL2 per `texturing/gpu/cookingDevice.ts`. |
| WebGPU texture cooking | `texturing/gpu/webgpuTexturing.ts`, `runtime/materials/graphCooker.ts`, `tests/frontend/textureWebGpu.test.ts` | **Partial / gated.** Source supports placement/instancing and compressed uploads by capabilities; strict fallback remains for unsupported GLSL and other operations. Full editor parity is not proven (#3). |
| Texture import, compression and budgets | `texturing/textureDecode.ts`, `texturePipeline.ts`, `textureSettings.ts`, `textureBudget.ts`, `utils/textureCompression/` | **Present in source.** Deep image formats and BC/ETC2/ASTC encoders exist; algorithm coverage and first-use residency require targeted testing (#13–14). |
| Photo material and capture | `texturing/paint/photoMaterial.ts`, `photometricStereo.ts`, `components/Texturing/Paint/captureImport.ts` | **Present but limited.** Capture import performs middle-square crop with a 1024-pixel cap; region picker returns one best square (#11–12). |
| Asset interchange and package | `texturing/paint/gltfExport.ts`, `texturing/materialX.ts`, `utils/materialPackage.ts` | **Partial.** Export supports multiple glTF physical **factors**; not necessarily texture-backed fields. Verify per-material and per-set round trips before claiming complete export fidelity. |
| Materials in built games | `runtime/materials/graphCooker.ts`, `materialCooking.ts`, `Auvra/project/game_build.py` | **Present in source.** On-device cooking, fallback pictures and resolution policies exist; first-use compression and caching still need profiling (#14). |
| Native GPU renderer | `README.md` and `native/` | **Not the editor's production material path.** The README identifies the native `wgpu` viewport as a scaffold; don't represent it as equivalent to WebGL2 rendering. |

Paths in `texturing/`, `components/`, `runtime/`, `utils/` and `tests/frontend/` above are relative to `fbx-viewer (1)/` except explicit repository-root paths.

## 3. Reconciliation of the 20 historical open items

These statuses are **triage, not closure**:

- **C — Code-confirmed limitation:** source directly exposes the constraint; still add regression or visual proof before marking it fixed.
- **P — Partly outdated / narrower than claimed:** some listed restrictions already have source support; isolate remaining failures.
- **R — Requires reproduction / further code trace:** no safe verdict from the inspected code alone.

| Old # | Classification | Current source evidence | Next reproducible check |
|---|---|---|---|
| **1** Mesh-reading nodes use stand-ins for generic material updates | **R** | `graph/nodes/weathering.ts` explicitly uses stand-ins without a mesh; separate mesh maps exist for painting/cooking | Apply one graph to two differently curved models; compare preview, applied maps and in-game cook |
| **2** Large tiling-island flood bounding is approximate | **C** | `graph/flood.ts` samples four fixed seam offsets (`FLOOD_SEAMS`) and comments on quarter-width gaps | Reproduce >75% wrapping islands with exact CPU bounding reference, then test GPU output |
| **3** Editor WebGPU and scatter/compressed/paint-stack/struct fallback | **P** | `gpu/cookingDevice.ts` still documents editor WebGL2; `gpu/webgpuTexturing.ts` supports instanced placement and compressed inputs; `textureWebGpu.test.ts` tests both; `struct` translation explicitly rejects unsupported shaders | Build a per-node/backend matrix and actually render scatter, compressed sources, paint-stack and struct fixtures on supported hardware |
| **4** Rust/leaks are noise/slope rather than physical flow | **C** | `graph/nodes/weathering.ts` exposes `meshLeaks` and `drippingRust` as masks; no geometry-following mass transport in inspected implementation | M4 solver prototype with continuity and mass-accounting fixtures |
| **5** Read-around filters rely on shader reasoning for tiling | **R** | `textureNodeLibrary.test.ts` has CPU seam-edge twins for several library nodes; comprehensive GPU wrap verification for every read-around filter is not established | Capture GPU pixel edges for blur/warp/filter variants in each tiling mode |
| **6** Parameter rename does not propagate to graph consumers/objects | **C** | `graph/parameters.ts::renameParameter` only returns changed current `graph` and `values`; `textureParameters.test.ts` tests its local edits | Rename a parameter used by another graph and an instance; verify references and values before/after project reload |
| **7** Curve wires cannot cross graph-as-node boundaries | **C** | `graph/registry.ts::subgraphDefinition` builds only image/material boundary ports; evaluator carries curves on ordinary nodes | Add nested curve input/output fixture and typed-port migration design |
| **8** Paint viewport's smoothing marks render target as XR | **C** | `texturing/paint/paintViewTarget.ts` isolates the Three r164 screen-colour behavior. The WebGL rendering check compares tone-mapped and raw colours to the default framebuffer at two sizes, checks resolved edge coverage and releases each target. | Check physical devices, restoration after context loss and future Three revisions before replacing the screen-target behavior. |
| **9** UDIM-crossing triangles may use too-coarse mip | **R** | `PaintViewport.tsx` uses mipmapped preview targets; no edge-crossing visual reference established | Render triangle spanning UDIM boundary at near/far camera, compare with unambiguous atlas reference |
| **10** Whole-model glTF other sets and integer UV edge cases | **P** | `paint/gltfExport.ts` has `atlasMesh` (triangle-aware) and `withPaintedMaterials` (whole-model substitution), but also `atlasUvs` (vertex-wise floor of integer UV) | Whole-model multi-painted-set export including skin/animation and an integer-edge shared vertex |
| **11** Capture center crop, 1024 limit and synchronous processing | **C** | `components/Texturing/Paint/captureImport.ts` defines `LARGEST = 1024` and draws middle square; processing is in the frontend call path | Measure UI responsiveness and cancellation during capture; assess worker migration |
| **12** Photo region picks one square | **C** | `paint/photoRegion.ts::RegionPick` has singular `square` returned via `bestSquare` | Multi-patch selection/compositing reference for M5 |
| **13** ETC2 encoder writes only initial modes | **C** | `utils/textureCompression/etc2Encoder.ts` header explicitly states first two modes (ETC1-compatible) | Quality/bitrate comparison on difficult blocks; add decoder reference cases |
| **14** Never-previewed texture is compressed on first game use | **R** | `utils/projectPictures.ts` and build/runtime cooking paths distinguish stored but not yet loaded pictures; cache paths exist | Fresh imported texture → unopened editor → built game first load; profile cache and transient allocations |
| **15** My Library is local; limited painted/preset support | **P** | `utils/userMaterialLibrary.ts` explicitly uses editor machine storage; `MyLibrary.tsx` and material package flows exist | Test painted copies, paint presets, and re-import on a new machine; distinguish allowed shared vs owned copies |
| **16** MaterialX zip/tiled-image behavior | **P** | `texturing/materialX.ts` recognizes `tiledimage` and resolves file paths, but its `pictureOf` ignores `uvtiling`; `materialX.test.ts` includes a tiledimage fixture | Import packaged archive and verify actual UV transform against source document |
| **17** WebGPU anisotropy/specular/coat limitations | **R** | Historical roadmap and `docs/assets.md` document approximation; current physical graph supports the features but no recent side-by-side result was inspected | Compare brushed metal, weak specular dielectric and tinted coat in both renderers with reference images |
| **18** Cross-scene raytraced contamination | **R** | Historical roadmap reports a local visual issue, no reproducer established in this audit | Repeat reference-render sequence A→B and B alone on same device; hash compare and isolate resource lifetime |
| **19** Flakes and coat tint in glTF/Overrides | **P** | `paint/gltfExport.ts` writes physical glTF extension factors but no proprietary flake/coat-tint equivalents; `materialGraph.ts` has those features | Confirm loss warning in glTF exporter and inspect whether Overrides expose all needed values |
| **20** Command-line bake lacks high-poly/cage and uses reversed row convention | **C** | `Auvra/project/material_commands.py` exposes `bake-mesh-maps` size/sample/output arguments and documents bottom-row-first maps | Run CLI and Paint baker on identical mesh/settings; compare orientation and high-poly options |

### What is newly clear

1. **Do not label WebGPU scatter/compression as completely missing.** Concrete WebGPU code and unit fixtures exist. The correct question is supported GPU/hardware coverage and fallback semantics.
2. **Do not label MaterialX tiled images as entirely unsupported.** `tiledimage` parsing exists; the UV tiling transform is the gap to isolate.
3. **Do not label glTF physical-material support as absent.** Several KHR extension *factors* are written; texture-backed maps, multi-set export and custom coat/flake semantics need separate review.
4. **Three narrow integrity repairs have direct code evidence:** external parameter rename propagation (#6), curve IO through nested graphs (#7), and XR-target-based view smoothing (#8). Their runtime severity still needs measured reproductions.

## 4. Prioritized M0 defect and test queue

### Integrity first (propose focused PRs)

| Order | Follow-up | Why it matters | Required regression |
|---|---|---|---|
| A | **Graph parameter rename across dependents** (#6) | Existing references/overrides can silently use old names | Nested graph plus per-instance override after save/reload; atomic update/undo across affected assets |
| B | **Curve IO through subgraphs** (#7) | Reusable authoring graphs cannot preserve all typed ports | Typed input/output curve graph, nested evaluation, bypass, and versioned migration |
| C | **Whole-model glTF + UDIM edges** (#9–10) | Export fidelity and wrong sampling at tile boundaries | 2 painted sets, shared integer-edge vertices, nonuniform textures, skin/animation round trip |
| D | **Paint viewport XR-target hack** (#8) | Upgrade/resilience risk in renderer lifecycle | Smooth preview, context loss, resize, device upgrade, and disposal |
| E | **GPU backend support/fallback matrix** (#3, #17–18) | Incorrect assumptions create invisible quality loss | End-to-end hardware image tests and scene isolation ordering |
| F | **MaterialX transform + package** (#16) | External materials can import with wrong scale | `tiledimage` with non-unit scale and rotation where supported, plus packaged image resolution |

**Important:** prioritization is provisional until M0 test fixtures quantify severity. Do not fix all in one PR.

### Capability matrix seed for M0.4

| Operation | Editor WebGL2 | Runtime WebGPU texture cooking | Native renderer | Evidence confidence |
|---|---|---|---|---|
| General texture graph passes | Present | Implemented for translatable passes; fallback for others | Not equivalent to editor PBR | Source confirmed; runtime parity pending |
| Scatter/instance placement | Present | Code and unit tests exist | Not established | Source confirmed; device test pending |
| BC/ETC2/ASTC compressed sources | Present through texture pipeline | Upload support gated by device features | Not established | Source confirmed; format matrix pending |
| Paint stack as graph node | Present | Partly dependent on baked inputs/stack kind | Not established | Needs full scene fixture |
| Custom GLSL structs | WebGL2 shader path may support them | Translator explicitly rejects some structs | Not established | Unit-test confirmed rejection, fallback to verify |
| Physical coat, sheen, anisotropy | Material graph renderer path exists | Approximate/partly limited; see #17 | Native README describes scaffold | Feature parity needs visual fixture |
| Editor-preview WebGPU texture cooking | Editor uses WebGL2 by default | N/A (game cook distinct) | N/A | Source confirmed |

These rows describe **potential capabilities**, not passing end-to-end tests. Fill in driver, browser, adapter, supported feature flags, and actual failures before M0.4 is complete.

### M0.4 — Device capability snapshot (implementation follow-up)

`texturing/gpu/cookingDevice.ts::textureCookingCapabilities()` supplies a serializable diagnostic snapshot with the selected runtime cooking backend, device-reported maximum texture dimension, BC/ETC2/ASTC and float32-filterable flags, and current per-material fallback reasons. On WebGL2 or without a valid WebGPU device, feature support is **unknown** (`null`), not wrongly reported as unsupported. Stored fallback reasons are cleared when the runtime cooking device changes, including device loss and WebGL2 fallback. Late asynchronous cooks from a previously active device are fenced: they cannot publish a new fallback reason or clear a valid reason belonging to the replacement device.

This is **a hardware feature-reporting primitive, not a verified node/backend matrix**. Real image comparisons, format uploads, cancellation, device loss and per-node fallback fixtures remain required for M0.4.

### M0.2 flood-box oracle (historical defect #2)

`texturing/graph/flood.ts::exactIslandSpan` is a **CPU-only correctness oracle**, computing the minimum covering interval on a cyclic axis from the complement of the largest unoccupied run of pixels. It handles full occupancy, 1-pixel islands, wrap-boundary roots, and deterministic gap ties.

The adversarial test explicitly demonstrates that the current four-quarter-seam `islandSpan` approximation can return **100 pixels** for an island whose exact width is **95 pixels**, when the only empty gap lies away from the tested seams. The **GPU shader is unchanged**; a bounded exact implementation with WebGL2/WebGPU image comparisons remains open under [#305](https://github.com/dovvnloading/Auvra/issues/305).

## 5. Proposed M0.3 channel-descriptor decisions

The paint document currently declares seven channels at `texturing/paint/paintTypes.ts::PAINT_CHANNELS`, while `runtime/materials/materialGraph.ts` exposes additional physical-surface features. Before adding channels, specify one metadata-driven contract that can describe:

- Stable channel identifier and version; optional alias for legacy migrations.
- Semantic type and components (scalar/color/normal/tangent/direction), linear/sRGB role and default.
- Valid physical range/units and precision; normal handling and blending.
- Supported paint tools, masks and sparse-page encoding.
- Shader surface input binding and WebGL2/WebGPU capability flags.
- Export/import mapping to glTF extensions and MaterialX, with explicit unsupported-field warnings.
- Compression role and mip/normal handling per target platform.

**Design gate:** one coated-metal and one fabric-sheen migration/round-trip fixture must be specified before modifying the paint stack. Preserve the existing seven-channel document when possible; do not redefine legacy channel meanings to add new ones.

## 6. Baselines to measure in M0.5 (not yet measured)

**Hardware/environment metadata for every run:** OS, GPU, driver, browser/WebView2 version, selected backend, shader precision, project commit, test graph hash, target size, and cold/warm cache state.

| Fixture | Measurements and expected artifacts |
|---|---|
| 512/2K/4K representative graph | Initial preview latency; full cook; incremental edit; p50/p95 interactions; comparison images |
| 300+ node graph with subgraphs/iteration | Peak resident CPU/GPU memory, cancellation, orphaned allocations, cache-hit behavior |
| Multi-UDIM paint set | Recompose after small stroke, seam coverage, mip/edge visual comparisons, save/reload |
| Physical coated metal and fabric | WebGL2/WebGPU channel and 3D appearance comparisons; supported interchange loss report |
| Multi-photo capture | Blocking time, max temporary memory, cancellation and source-provenance checks |
| Game-time material cooker | Per-object seeds, stale cook cancellation, first-use compression, WebGPU fallback and device-loss recovery |
| Whole-model glTF/MaterialX/`.auvramat` | Supported-channel export/reimport, dependencies, painted sets, UV transform and orientation |

### Existing automated commands to run

From the repository root and the frontend directory as appropriate:

```powershell
python -m unittest discover -s tests -t . -v
cd "fbx-viewer (1)"
npm ci
npm run typecheck
npm run typecheck:strict
npm test -- tests/frontend/textureParameters.test.ts tests/frontend/textureCurveWires.test.ts tests/frontend/textureFlood.test.ts tests/frontend/paintGltf.test.ts tests/frontend/textureWebGpu.test.ts
npm run renderer:verify
npm run rendering:verify
```

For rendering verification, use the repo's documented software GPU and pinned visual fixtures. These commands are a **proposed verification queue; they have not been executed as part of this audit**.

## 7. Progress and handoff

| M0 workstream | State after this PR | Next required artifact |
|---|---|---|
| **M0.1** Capability inventory | **Started — static code audit** | Runtime-backed matrix with exact tested device and commit |
| **M0.2** Regression triage | **Started — all 20 historical items initially classified** | High-severity repro tests and per-item issue decisions |
| **M0.3** Surface channel contract | **Draft questions only** | Versioned TypeScript contract + migration tests and design signoff |
| **M0.4** GPU capability contract | **Source-based seed matrix** | Automated backend capability and fallback reporting |
| **M0.5** Performance baseline | **Fixture plan only** | Actual measurements and visual references on documented hardware |

**Stop rule:** M0 is **not complete** until reproducible tests and measured baselines back the declarations in [issue #279](https://github.com/dovvnloading/Auvra/issues/279). The next engineering PR should tackle a single test-backed integrity issue or contract; avoid broad node-library additions before these gates.
