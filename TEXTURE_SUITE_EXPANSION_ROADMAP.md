# Auvra Texture Suite — Expansion Roadmap

> **Status:** Proposed engineering plan (not an implementation-status report)
>
> **Created:** 2026-11-12
>
> **Companion:** [MATERIAL_AND_TEXTURE_ROADMAP.md](MATERIAL_AND_TEXTURE_ROADMAP.md), which documents earlier work through round 10 and its then-open defects. This plan covers the **next expansion**, with milestone gates and an execution order. Recheck every claimed gap against current `main` before opening a feature PR.
>
> **Scope:** procedural texture graphs, physical materials, painting, mesh-aware weathering, capture, AI-assisted graph editing, GPU cooking, runtime material state, virtual textures, optimization, interchange, and production quality.

## 0. Vision, boundaries, and success criteria

**Vision:** Auvra becomes a complete, game-native material authoring system: an artist can create a physically credible surface from graphs, painting, or photographs; inspect and improve it non-destructively; package and export it; and make it react to gameplay and the surrounding world.

**This is not a node-count contest.** The decisive improvement is making the existing graph, paint, material, GPU, and game-runtime subsystems work as one reliable workflow.

### The baseline we must preserve

Auvra already has many of the foundational capabilities: GPU graphs, materials carried on graph wires, function graphs and image-level iteration, mesh-map baking, UDIMs, smart masks/materials, graph brushes, sparse painted pages, procedural game-time cooking, texture-memory estimates, photo-to-material conversion, multi-photo capture, material packages, glTF and MaterialX interchange, and extensive node families (including weathering, photo operations, curves, scatter, and SDFs). **Do not duplicate existing code or reintroduce solved problems.**

The companion roadmap's **Still open** list is an audit input, not proof that every entry remains open. In particular, validate the actual state of WebGPU support, the editor path, capture processing, parameter propagation, UV edges, and export before planning the implementation.

### Program-wide success criteria

1. **Physically complete authorship:** extended PBR properties can be edited and painted with explicit precision, semantics, and export compatibility.
2. **Surface intelligence:** geometry, gravity, moisture, material properties, and environmental data can drive credible weathering beyond noise overlays.
3. **Editable assistance:** capture and AI create reviewable graphs, parameters, and paint layers—not just flattened bitmaps.
4. **Predictable runtime cost:** every expensive graph, dynamic state, compressed texture, and streamed page has an observable budget and fallback.
5. **Asset portability:** supported information survives project save/reopen, `.auvramat` packaging, and documented interchange paths.
6. **Trustworthy operation:** no silent material-channel loss, private-asset upload, unbounded memory growth, or destructive graph mutation.

### Engineering rules

- Preserve **WebGL2 as the compatible editor path** until a verified alternate path is ready; WebGPU upgrades must be opt-in/capability-gated when experimental.
- Respect existing project authority, material assets, native host boundaries, and the repository's staged-refactor rules.
- Every edit must be undoable and survive save/reload; preserve unknown/newer document fields when safely possible.
- Keep sRGB versus linear data, bit depth, normal-map conventions, physical units, seed rules, and export limitations explicit.
- Remote AI/provider operations require an intentional user action and explicit route; never store credentials in project files.
- Each milestone ends in a demonstrated **artist workflow**, tests, metrics, and documentation—not merely a new shader or API.

## 1. Milestone map and release slices

Milestones are **dependency-based, not date promises**. P0–P3 show engineering priority, not feature readiness.

| ID | Priority | Milestone goal | Prerequisites | Release slice |
|---|---|---|---|---|
| **M0** | P0 | Verified baseline, regression fixes, shared contracts | None | Creator foundation |
| **M1** | P0 | Graph execution parity and GPU feature reporting | M0 | Creator foundation |
| **M2** | P1 | Full physical-channel painting | M0; M1 before broad WebGPU release | Creator foundation |
| **M3** | P1 | Material Doctor and quality diagnostics | M0; extends M1/M2 | Creator foundation |
| **M4** | P1 | Mesh-surface flow and physical weathering | M1, M2, M3 | Intelligent authoring |
| **M5** | P1 | Advanced capture and editable photo reconstruction | M0, M2; use M3 | Intelligent authoring |
| **M6** | P1 | AI Graph Copilot and generative graph nodes | M0, M3; consumes M5 | Intelligent authoring |
| **M7** | P2 | Gameplay-reactive, per-object material state | M1, M4 | Living materials |
| **M8** | P2 | Virtual textures and bounded GPU residency | M1, M3 | Living materials |
| **M9** | P2 | Target-aware optimization and better interchange | M2, M3, M8 | Living materials |
| **M10** | P3 | World-space environmental fields across objects | M4, M7, M8 | World surfaces |
| **M11** | P0 gate | End-to-end release, migration, and ecosystem review | All milestones selected for release | Every slice |

**Delivery strategy:** ship creator foundations (M0–M3) first; add capture/weathering/AI (M4–M6) independently where possible; then ship dynamic state and streaming/optimization (M7–M9); finally enable world-coupled effects (M10). **M11 runs on every release slice**, not only at the very end.

## 2. Milestone stages and acceptance gates

### M0 — Audit, baseline, and safety contracts

**Goal:** know what exists, eliminate silent data loss, and establish metrics and schemas for later milestones.

**Work stages**

- [ ] **M0.1 — Capability audit:** inventory `texturing/`, `components/Texturing/`, `runtime/materials/`, renderer/backend paths, cooking/build code, and relevant tests. Mark each proposed feature **verified existing**, **incomplete**, **broken**, or **new**.
- [ ] **M0.2 — Defect triage:** revalidate the older roadmap's open issues: parameter rename propagation, curves across nested graphs, flood bounds, UDIM edge/mip handling, full-set glTF export, viewport lifecycle, export coverage, and fallback behavior.
- [ ] **M0.3 — Shared channel contract:** design a versioned descriptor for channel semantic, component count, default, precision, color space, physical units/range, blending, compression role, and target-export mapping.
- [ ] **M0.4 — GPU capability contract:** publish which graph/paint operations work on WebGL2, WebGPU cooking, editor previews, and native runtime; distinguish supported, fallback, and unavailable.
- [ ] **M0.5 — Baseline fixtures:** record cold/warm cooking, first preview, incremental changes, resident memory, shader failures, tiling seams, and export fidelity for reference graphs and real models.

**Exit gate**

- [ ] A reproducible feature matrix, benchmark report, fixtures, and documented test commands are committed.
- [ ] High-severity data-loss/incorrect-output defects are fixed with tests or explicitly release-blocked with clear diagnostics.
- [ ] Representative existing projects and `.auvramat` packages reopen without supported data loss.
- [ ] Unsupported GPU features are reported as unsupported, **not** counted as successful tests.

**Primary files:** `texturing/graph/types.ts`, `texturing/graph/evaluator.ts`, `texturing/paint/paintTypes.ts`, `texturing/materialX.ts`, `tests/frontend/`, `tests/visual/`.

### M1 — GPU texture execution parity

**Goal:** one predictable graph contract across supported execution backends.

**Work stages**

- [ ] **M1.1 — Audit actual gaps:** measure WebGPU coverage for scatter/instancing, compressed texture sources, paint stacks, function/code-mode structs, readback, and precision. Implement only verified gaps.
- [ ] **M1.2 — Backend-neutral execution:** keep graph semantics shared while isolating GLSL/WGSL and GPU resource creation.
- [ ] **M1.3 — Editor integration:** enable editor-side WebGPU cooking only behind an explicit capability gate, with working WebGL2 fallback.
- [ ] **M1.4 — Lifecycle and observability:** expose failing node/operation, fallback reason, cancellation state, device-loss recovery, and pooled-resource lifetime.
- [ ] **M1.5 — Parity testing:** compare output images and numeric intermediates with declared tolerances on identical fixtures; stress long iterative graphs.

**Exit gate**

- [ ] The approved feature matrix is exercised automatically for both backends.
- [ ] Each test graph either renders within established tolerance or produces a tested, non-destructive fallback with a reason.
- [ ] Device/context loss, cancellation, and repeated cooking do not leak resources or corrupt material documents.
- [ ] No regression to default WebGL2 editor stability.

**Primary files:** `texturing/gpu/webgpuTexturing.ts`, `texturing/gpu/texturingGpu.ts`, `texturing/gpu/glslModule.ts`, `texturing/graph/evaluator.ts`, `tests/frontend/textureWebGpu.test.ts`.

### M2 — Extended PBR painting and unified material semantics

**Goal:** artists can paint the physical surface the renderer supports instead of stopping at the legacy seven channels.

**Work stages**

- [ ] **M2.1 — Channel registry and migration:** extend the current base color/roughness/metallic/height/normal/emissive/opacity document through the M0 descriptors without breaking existing projects.
- [ ] **M2.2 — Physical channels:** prioritize coat weight/roughness/tint, sheen, anisotropy strength/direction, transmission, subsurface properties, and thin-film controls based on actual renderer support.
- [ ] **M2.3 — Painting and previews:** support new channel masks, blend rules, brush/fill/filter behavior, sparse storage, 2D/3D isolation, and relevant half-float precision.
- [ ] **M2.4 — One material document:** preserve manual shader-graph edits across painting, applying, material instances, and generated painted copies.
- [ ] **M2.5 — Portability:** improve glTF extension and MaterialX mappings; show loss reports when a target cannot represent a channel. Make eligible paint presets/materials reusable through project/My Library workflows.

**Exit gate**

- [ ] A coated automotive surface, anisotropic metal, sheened fabric, and transmissive surface can be authored/painted end-to-end in the supported backend.
- [ ] Supported channel values survive edit → save → reopen → export → reimport within declared tolerances.
- [ ] Unsupported export features show explicit, reviewable warnings; no silent physical-channel stripping.
- [ ] Legacy projects render the same after migration, absent intentional user changes.

**Primary files:** `texturing/paint/paintTypes.ts`, `texturing/paint/paintStack.ts`, `texturing/paint/exportTemplates.ts`, `texturing/paint/gltfExport.ts`, `texturing/materialX.ts`, `runtime/materials/`.

### M3 — Material Doctor and production diagnostics

**Goal:** catch defects while the artist can still fix them, with evidence tied to the responsible graph or texture.

**Work stages**

- [ ] **M3.1 — Static checks:** graph cycles/invalid values, missing assets, unsupported backend features, unknown node types, PBR outliers, and export loss.
- [ ] **M3.2 — Pixel/mesh checks:** measure tile-edge discontinuity, UV seam artifacts, invalid float values, normal conventions, alpha coverage, and data/sRGB misuse.
- [ ] **M3.3 — Cost checks:** identify expensive nodes, unnecessary resolution/precision, recompute hotspots, GPU residency, compression artifacts, and fallback churn.
- [ ] **M3.4 — Developer/artist UX:** add **Analyze Material**, severity/evidence, jump-to-node, source-versus-cooked heatmaps, and repair preview.
- [ ] **M3.5 — Build integration:** provide machine-readable warnings/blockers and optionally fail headless builds on selected defect classes.

**Exit gate**

- [ ] At least **12 deliberately defective fixtures** trigger the expected warning category, including seams, normal-map inversion, wrong colorspace, NaN/Inf, missing assets, and unsupported export fields.
- [ ] Reference clean materials do not produce release-blocking false positives; tolerance exceptions are documented.
- [ ] Automatic fixes are undoable, opt-in, and previewable; reports link to responsible nodes/settings when possible.
- [ ] CI can produce the same diagnostic report from a saved project.

**Primary files:** `texturing/graph/evaluator.ts`, `texturing/textureBudget.ts`, `texturing/textureSettings.ts`, `components/Texturing/TextureView2D.tsx`, `components/Texturing/TextureView3D.tsx`.

### M4 — Surface-aware weathering and physical transport

**Goal:** rain, deposits, corrosion, and dirt follow the actual mesh instead of merely appearing as directional noise.

**Work stages**

- [ ] **M4.1 — Surface fields:** calculate gravity projection, slope, curvature, obstruction, exposure, material absorption, and cross-triangle adjacency.
- [ ] **M4.2 — Seam continuity:** carry transport across triangles/UV islands, with explicit behavior at open and non-manifold boundaries.
- [ ] **M4.3 — Stable solver:** implement bounded timestep and iterative moisture flow, pooling, evaporation, sediment transport, and deposition.
- [ ] **M4.4 — Artist nodes:** add **Gravity Flow**, **Moisture Accumulation**, **Sediment Deposit**, **Erosion**, **Corrosion Growth**, and **Exposure Mask**. Keep existing stylized weathering nodes as fast alternatives.
- [ ] **M4.5 — Physical output:** affect roughness, base color, normal/height, coat, and wetness where applicable; support cacheable static bakes first.

**Exit gate**

- [ ] A multi-UDIM pipe and masonry model show runoff continuous across UV seams.
- [ ] Synthetic flow tests account for mass sources/sinks and avoid negative/unstable concentrations.
- [ ] Repeated static cooks with the same seed, geometry, and parameters are equivalent within GPU tolerance.
- [ ] A cheap artistic fallback is available for constrained hardware.

**Primary files:** `texturing/graph/nodes/weathering.ts`, `texturing/graph/iterate.ts`, `texturing/mesh/`, `texturing/paint/seams.ts`, `texturing/bake/`.

### M5 — Advanced capture and editable material reconstruction

**Goal:** turn real material photos into dependable, editable surfaces without blocking the UI.

**Work stages**

- [ ] **M5.1 — Calibration:** improve exposure/white-balance handling, light direction checks, alignment, and confidence visualization for photometric stereo.
- [ ] **M5.2 — Multi-patch selection:** capture and combine multiple representative source regions instead of only one best square.
- [ ] **M5.3 — High-resolution pipeline:** replace current limiting crops through bounded tiled processing, background work, cancellation, and visible progress.
- [ ] **M5.4 — Reconstruction:** improve delighting, seamless tiling, normal/height integration, physical-scale estimates, and uncertainty labels.
- [ ] **M5.5 — Editable results:** retain source maps, crop masks, provenance, graph parameters, and proper privacy/packaging choices.

**Exit gate**

- [ ] Brick, bark, concrete, and painted metal fixtures create editable, tileable material graphs with estimated-versus-measured outputs identified.
- [ ] Higher-resolution inputs are processed in bounded work units without blocking normal editor interaction.
- [ ] Cancellation leaves no committed partial material or orphaned resources.
- [ ] Source photos are never bundled into a shared material without the user's explicit choice.

**Primary files:** `texturing/paint/photometricStereo.ts`, `texturing/paint/captureMaterial.ts`, `texturing/paint/photoRegion.ts`, `texturing/graph/nodes/photo.ts`.

### M6 — AI Graph Copilot and generative graph nodes

**Goal:** natural-language authoring produces editable operations rather than an opaque image or untrusted project mutation.

**Work stages**

- [ ] **M6.1 — Operation schema:** define allowlisted graph edits: create node, connect port, set parameter, expose control, insert a preset, group/rename, and scoped delete.
- [ ] **M6.2 — Validate and preview:** check node registry, pin compatibility, graph cycles, material semantics, resource limits, permissions, and schema versions; show a graph diff before apply.
- [ ] **M6.3 — Workflows:** create a material from description, modify the selected graph, explain its structure, suggest fixes, and fit parameters to a reference.
- [ ] **M6.4 — Generative nodes:** optionally introduce **Text/Image-to-Material**, **AI Tile**, and **AI Variation** with seeds, provider/model identifiers, provenance, masks, and content-addressed caching.
- [ ] **M6.5 — Host/provider security:** reuse explicit provider selection; require intentional data sharing; never write credentials to material assets.
- [ ] **M6.6 — Evaluation:** build a fixed prompt suite and measure schema-validity, applied changes, performance, and artist review.

**Exit gate**

- [ ] At least **10 authored tasks** result in valid operations or explicit rejection; malformed provider output never mutates the project.
- [ ] Accepted edits are shown before application and remain undoable and reloadable.
- [ ] Manual workflows remain fully functional with no AI provider configured.
- [ ] Remote asset transfer and identity of the provider are visible to the user.

**Primary files:** `texturing/graph/registry.ts`, `texturing/graph/types.ts`, `components/Texturing/TextureGraphWorkspace.tsx`, graph history/commands, Python provider boundary.

### M7 — Gameplay-reactive materials and per-object state

**Goal:** footprints, scorch, snow, rain, heat, and damage evolve during play without mutating shared authored assets.

**Work stages**

- [ ] **M7.1 — State contract:** separate material source graph, instance parameters, temporary fields, and deliberately persisted world state.
- [ ] **M7.2 — Gameplay events:** expose bounded wetness, footprint, damage, deposit, and heat events with artist-defined channel responses.
- [ ] **M7.3 — Partial updates:** recook only affected regions/LODs where supported; reuse graph signatures, cached fields, and update throttling.
- [ ] **M7.4 — Blueprint/script binding:** validate parameters and event scopes; define reset, save/load, and scene-unload behavior.
- [ ] **M7.5 — Quality/performance:** set budgets for simulation frequency, dirty area, retained buffers, and game frame time.

**Exit gate**

- [ ] Multiple objects sharing one material can have independent wetness, damage, and footprints.
- [ ] Save/reload and reset behavior match documented state-persistence rules.
- [ ] Hidden/distant objects throttle updates; over-budget scenes degrade gracefully instead of allocating without limit.
- [ ] Static material rendering does not change when dynamic features are disabled.

**Primary files:** `texturing/graph/animation.ts`, `texturing/gpu/cookingDevice.ts`, `runtime/materials/`, gameplay scripting/blueprint integration.

### M8 — Virtual textures and bounded GPU residency

**Goal:** large UDIM/procedural surfaces use GPU memory in proportion to visible detail, not total source size.

**Work stages**

- [ ] **M8.1 — Prototype:** evaluate a tile atlas/page table and visibility/mip feedback on a representative large-UDIM scene.
- [ ] **M8.2 — Source isolation:** reuse sparse painting concepts but keep authoring page storage and runtime page residency as distinct responsibilities.
- [ ] **M8.3 — Streaming:** implement asynchronous page requests, graph-tile cooking, mip hierarchy, generation-based invalidation, tile borders, and predictable filtering.
- [ ] **M8.4 — Budgets:** bound CPU, GPU, staging, and disk caches; prioritize visible pages and evict safely.
- [ ] **M8.5 — Fallback/diagnostics:** render a coarse resident mip while detail loads; offer normal-texture fallback on unsupported backends; expose cache misses and residency.

**Exit gate**

- [ ] Near/far camera movement over a large multi-UDIM fixture keeps resident memory inside a configured budget plus documented transient headroom.
- [ ] Rapid camera changes and graph edits do not show stale, wrong-material, or uninitialized tiles.
- [ ] LOD transitions are acceptable under an agreed visual reference.
- [ ] Unsupported devices render a validated fallback without data loss.

**Primary files:** `texturing/paint/sparsePicture.ts` (design reference), `texturing/textureBudget.ts`, `texturing/gpu/`, asset cooker, renderer resource management.

### M9 — Automatic optimization, compression, and interchange

**Goal:** generate target-aware game assets with explainable tradeoffs and reliable round trips.

**Work stages**

- [ ] **M9.1 — Platform profiles:** establish high-end desktop, mainstream desktop, and constrained/mobile profiles backed by actual capability checks.
- [ ] **M9.2 — Quality analyzer:** inspect per-channel spatial detail, normal errors, alpha coverage, mip behavior, and texel density.
- [ ] **M9.3 — Suggestions:** offer resolution, precision, compression, packed-channel, and mip-count recommendations without altering the master asset.
- [ ] **M9.4 — Preview:** show original versus optimized rendering, memory/cook-time estimates, and artifact heat maps with reversible selection.
- [ ] **M9.5 — Export:** improve verified gaps in glTF plus KTX2, MaterialX images/tiling, `.auvramat` dependencies, and BC/ETC2/ASTC encoding.
- [ ] **M9.6 — Headless reproducibility:** integrate optimizer reports into the build pipeline and version/hash relevant inputs.

**Exit gate**

- [ ] Three target profiles give different justified cooking plans from one source material.
- [ ] A selected budget is satisfied **or** a visible report explains why the quality floor makes it impossible.
- [ ] Supported glTF/MaterialX target-viewer tests and package round trips pass; incompatible channels are reported, not silently discarded.
- [ ] Optimization never irreversibly changes the editable source.

**Primary files:** `texturing/textureBudget.ts`, `texturing/textureSettings.ts`, `utils/textureCompression/`, `texturing/paint/exportTemplates.ts`, `texturing/paint/gltfExport.ts`, `texturing/materialX.ts`.

### M10 — World-aware materials and environmental fields

**Goal:** materials behave consistently across nearby terrain, props, and shared environmental boundaries.

**Work stages**

- [ ] **M10.1 — Field contract:** define optional world-space sampling for rain, moisture, sun exposure, temperature, wind, altitude, biome, and contact.
- [ ] **M10.2 — Material inputs:** connect stable world-space coordinates and optional fields into graph/instance parameters.
- [ ] **M10.3 — Cross-object behavior:** support continuity where geometry permits, e.g. wall-to-pipe runoff, shaded moss, snow accumulation, and contact dirt.
- [ ] **M10.4 — Limits:** update fields in bounded cells/pages with LOD, world-streaming, persistence, and scene-unload rules.
- [ ] **M10.5 — Tooling:** visualize field values, flow continuity, influence masks, and simulation costs.

**Exit gate**

- [ ] A reference level shows consistent environmental effects across terrain and at least two adjacent props.
- [ ] Moved objects sample the correct world field and avoid unexplained seams.
- [ ] Turning the system off preserves each object's authored base material.
- [ ] Streaming and unload release field state; under-load hardware keeps a fast approximation option.

**Primary files:** world/terrain systems, environmental effects, `runtime/materials/`, `texturing/graph/nodes/weathering.ts`, runtime streaming interfaces.

### M11 — Integrated workflow and release-readiness gate

**Goal:** ship each slice as a complete, documented creation-to-game experience.

**Work stages**

- [ ] **M11.1 — Guided workflow:** procedural/photo authoring → physical painting → Material Doctor → package → game runtime → export.
- [ ] **M11.2 — Compatibility:** test legacy projects, unknown node preservation, migrations, recovery points, source asset changes, and project switching.
- [ ] **M11.3 — Visual and automation:** run unit/contract suites, representative scenes on supported backends, headless cooking, and relevant native/runtime tests.
- [ ] **M11.4 — Docs and samples:** publish artist tutorials, supported feature matrix, platform budgets, fallbacks, external-provider behavior, and release notes.
- [ ] **M11.5 — Signoff:** record known exceptions, screenshots, quantitative results, reviewer approvals, and relevant issue/PR links.

**Exit gate**

- [ ] At least **three reference materials** (e.g. weathered metal, coated paint, captured masonry) complete authoring → save/reload → preview/play → compatible export.
- [ ] No untracked release-blocking integrity, backend, migration, security, or privacy defects remain.
- [ ] Docs reflect shipped controls and current behavior, not only roadmap aspirations.
- [ ] Experimental capabilities are clearly labeled and disabled by default until their gates pass.

## 3. Shared quality bar and test matrix

| Dimension | Evidence needed for every applicable milestone |
|---|---|
| **Correctness** | Deterministic test seeds, known CPU/reference values where useful, documented numeric tolerances |
| **Editor usability** | Edit → preview → undo/redo → save/reload → edit again; visible cancellation/recovery |
| **Precision** | No unexpected down-conversion of 16-bit/float height and normals; linear and sRGB roles respected |
| **Tiling and mesh seams** | Quantitative wrap-edge checks and multi-UDIM/adjacency visual references |
| **GPU coverage** | WebGL2 and WebGPU image comparisons on supported paths; explicit unsupported/fallback states |
| **Performance** | Cold/warm cook, incremental update, median/p95 interaction, game frame cost on fixed hardware |
| **Memory and cleanup** | Peak GPU/CPU allocation, cancellation, source replacement, repeated project switching, cache eviction |
| **Export fidelity** | Supported-channel round trips and viewer tests, with explicit unsupported-field reports |
| **Security/privacy** | Bounded import/decoding, validated graph edits, provider permission/consent, no credential persistence |
| **Compatibility** | Versioned migrations, legacy asset reopen, preservation of unknown data, graceful capability downgrade |

**Performance policy:** establish the baseline in M0 at 512, 2K, and 4K where supported. A tracked **greater-than-10% regression in median or p95 editor latency** requires documented review and explicit acceptance; do not claim that all 2K graphs must meet one universal latency threshold. Define hard first-preview, GPU peak-memory, and runtime frame budgets per reference hardware profile after measured baselines. Heavy 8K work may be asynchronous or headless.

**Reference content:** Khronos Sample Models, appropriately licensed Poly Haven scans, a multi-UDIM model, a UV edge-case mesh, a layered paint stack, extended-PBR surfaces, an animated texture graph, and a world-space runoff scene. Record actual licenses before putting assets in the repository.

**PR evidence:** before/after screenshots, exact test commands, renderer capabilities, device/hardware profiles, memory/timing deltas, migration/rollback notes, and a user-visible demo of the milestone's complete workflow.

## 4. Dependency strategy and ownership

Critical paths:

- **Simulation/runtime:** M0 → M1 → M4 → M7 → M10.
- **Physical painting/capture:** M0 → M2 → M5.
- **Diagnostics/AI:** M0 → M3 → M6.
- **Streaming/optimization:** M1 + M3 → M8; M2 + M3 + M8 → M9.

M2 and M3 can progress in parallel after M0. M6 should reuse M5 results when available, but manual material authoring must never depend on remote AI. Static M4 output must not require M7's runtime state. M8 must not become a prerequisite for normal WebGL2 painting.

**Issue protocol:** create one tracking issue per milestone once its prerequisites are ready; assign owner/reviewer; split implementation into focused PRs. Each issue tracks **Not started → Spec ready → In progress → Verified → Shipped**, plus implementation PRs, fixture links, accepted risks, and exit-gate evidence.

**Definition of Ready:** prerequisites passed; current source audited; version/data contracts and UX outlined; test fixtures, fallback, and resource budget identified.

**Definition of Done:** end-to-end demo, green tests on relevant backends, migration/undo correctness, memory and timing review, documentation, and merged PR. A successful isolated unit test does not by itself close a milestone.

## 5. Recommended first work queue

This is the smallest useful sequence for the **first creator-foundation release**:

1. **M0-A: inventory and classify.** Reconcile the companion roadmap's open items against current code and tests. Publish the GPU capability and material-channel matrices.
2. **M0-B: versioned surface-channel design.** Specify channel semantics, migrations, and render/export mapping before changing paint-stack types.
3. **M1-A: parity fixtures.** Verify scatter, paint stacks, compressed images, code structs, and editor GPU choices with visible fallback reasons.
4. **M3-A: Material Doctor prototype.** Start with high-confidence checks for seams, invalid float values, colorspace, normal conventions, texture budgets, and export loss.
5. **M2-A: prove two vertical workflows.** Build one extended coat-painted metal and one fabric sheen material; preserve source and export supported channels.
6. **M11-A: run the release gate.** Demonstrate those materials from creation through save/reload, play preview, and compatible export.

**First release goal:** an artist can open a material, paint extended physical properties, inspect it with Material Doctor, and publish it with clear quality and compatibility feedback. Do **not** begin broad AI automation, virtual texturing, or world-scale fields until the baseline slice is reliable.

## 6. Decisions to make before dependent work

- Which physical properties are truly texture-backed, and which remain uniforms in each renderer?
- Which WebGPU operations are stable enough for editor presentation rather than experimental GPU cooking only?
- What is the authoritative cache signature when source graphs, mesh maps, mutable game state, and world fields all contribute?
- How will authored paint pages differ from temporary game-runtime state pages and streamed texture pages?
- What source photo and AI-provenance data can a material package include, and how is consent recorded?
- What device tiers, GPU memory budgets, and export error tolerances will M0 establish as release gates?
- How should platform-specific material extension losses be shown during glTF/MaterialX interchange?

Put answers into the corresponding milestone's design issue. Avoid silently choosing defaults that affect saved projects or performance.

---

**Target outcome:** a coherent suite of **editable, physically aware, validated, efficient, and runtime-reactive materials** that improves the authoring experience and the shipped game together. Each milestone has an independent, measurable finish line and makes the next one safer.
