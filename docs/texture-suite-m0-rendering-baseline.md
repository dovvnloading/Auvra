# Texture Suite M0.5 — Historical Rendering Baseline

> **Status:** First **historical, software-GPU reference**, not a measured benchmark of current `main`, production hardware, or graph authoring operations.
>
> **Tracking:** [M0 #279](https://github.com/dovvnloading/Auvra/issues/279), [M0.5 issue #289](https://github.com/dovvnloading/Auvra/issues/289).
>
> **Source:** [`rendering-history/history.jsonl`](https://github.com/dovvnloading/Auvra/blob/rendering-history/history.jsonl), branch revision [`0aac949ef51f`](https://github.com/dovvnloading/Auvra/commit/0aac949ef51f2fd6398617fef7316e3e72afa540).
>
> **Data range:** 2026-10-31T21:38:18.604Z through 2026-11-12T16:00:10.267Z, **115 historical records**. Most recent stored scene revision `2096c310f18d236358426387b05e7077bdc6f736`.
>
> **Method:** read the history JSONL, select the most recent 30 available measurements **independently for each scene**, compute p50 (nearest-rank median) and p95 (nearest rank, rank = `ceil(n*0.95)`), and convert latest scene `gpuBytes / 1,048,576` to MiB. The underlying CI uses the software GPU path described in `fbx-viewer (1)/scripts/rendering/run.mjs`.

## 1. Observed historical values

All times in milliseconds. **`frameMs` is the scene capture's reported rendering metric; do not infer 60 FPS from it.** Latest GPU MiB reflects the reporter's allocation estimate, **not** physically measured VRAM occupancy.

| Scene | Total records | Recent samples | p50 load ms | p95 load ms | p50 frame ms | p95 frame ms | Latest estimated GPU MiB |
|---|---:|---:|---:|---:|---:|---:|---:|
| `materials` | 115 | 30 | 2815.0 | 3375.9 | 572.3 | 702.0 | 97.9 |
| `physical-materials` | 47 | 30 | 5299.4 | 6666.1 | 836.3 | 884.4 | 104.8 |
| `car-paint` | 44 | 30 | 2277.0 | 2823.1 | 504.7 | 529.9 | 97.5 |
| `texture-graph` | 44 | 30 | 346.4 | 382.4 | 16.8 | 20.9 | 2.7 |

**Most recent scene measurements** (from the last stored revision, not current HEAD):

| Scene | Load ms | Frame ms | Draw calls | Triangles | Estimated GPU MiB |
|---|---:|---:|---:|---:|---:|
| `materials` | 2828.5 | 702.0 | 45 | 116414 | 97.9 |
| `physical-materials` | 5230.3 | 836.3 | 31 | 68524 | 104.8 |
| `car-paint` | 2263.1 | 522.1 | 14 | 72206 | 97.5 |
| `texture-graph` | 348.1 | 17.2 | 2 | 722 | 2.7 |

### Interpretation

- The **`texture-graph` scene** already has historical image-based rendering coverage. That is not the same as benchmarking arbitrary texture graphs at 2K or 4K; it is one fixed visual scene.
- The **`physical-materials`** and **`car-paint`** scenes help track physically layered surface rendering, but they do not measure paint-layer recomposition, UDIM streaming or authoring responsiveness.
- Timing variation across commits may include changes to CI environment, GPU driver/software renderer, scene content, caching or compilation; the historical series is **reference context**, not a controlled performance experiment.
- GPU-byte counts are per-scene estimates reported by the test harness. Real hardware residency may differ.
- WebGPU reference pictures can be verified separately, but this particular history format has **no explicit backend field**, so **do not infer a WebGPU performance baseline from it**.

## 2. How to reproduce and refresh the history report

Use the historical branch and a known script revision; record the Git SHA of the data and the script. From a local checkout:

```powershell
git fetch origin rendering-history
git show origin/rendering-history:history.jsonl > history.jsonl
```

Compute the same quantities from JSONL. For each named scene independently:

1. Parse each nonempty line as JSON, retaining `commit`, `date`, and `scenes[sceneName]`.
2. Keep rows that have the named scene; select their **last 30** available values in file order.
3. Sort numeric `loadMs` and `frameMs` values, and pick zero-based array indices `ceil(0.5*n)-1` and `ceil(0.95*n)-1`.
4. Take the latest recorded scene's `gpuBytes` as an estimate of GPU allocation, converting to MiB by dividing by `1048576`.
5. Use one decimal place for the table.

Run the renderer's existing reference scenes:

```powershell
cd "fbx-viewer (1)"
npm ci
npm run rendering:verify
npm run rendering:verify -- --renderer webgpu
# For measurements on your actual GPU (not the software-GPU reference):
node scripts/rendering/run.mjs --gpu
```

The renderer script writes output pictures and `numbers.json` under `tests/visual/output/` (the WebGPU reference has its own subdirectory). Visual baseline updates are **not** an appropriate way to accept an unintended visual regression.

## 2A. Real-clock 512px cook measurement in regular visual verification

The standard `texture-graph` scene now records `graphCook` in `tests/visual/output/numbers.json` after its 512×512 procedural graph has evaluated and its base-color and normal PNG maps have been encoded. Its `milliseconds` is real elapsed browser wall-clock time (not the harness's virtual scene clock), and `pixels`, `backend` and `fallback` identify the completed bake. These values are distinct from renderer frame times.

This is recorded only during ordinary visual verification, with no extra graph evaluations or screenshot/reference threshold changes. Use `npm run rendering:verify` or `npm run rendering:verify -- --renderer webgpu` to collect it. The opt-in `texture:benchmark` added later measures cold/cache/incremental stages at 512/2048/4096 under the separate `textureCook` key. Historical archived scene measurements predate `graphCook` and are not retroactive evidence.

## 3. The missing M0.5 measurement set

**These are still required and are not represented by the table above:**

| Fixture | Measurements | Acceptance preparation |
|---|---|---|
| Deterministic graph at 512, 2048 and 4096 | First preview, full cook, incremental edit, warm signature-cache hit | Build a fixed JSON graph/seed and capture p50/p95 across repeated runs |
| Nested/Iterate graph at ≥300 nodes | Peak retained images, canceled-work cleanup, CPU/GPU transient bytes | Separate graph growth from normal scene rendering |
| Sparse 4K painting and multi-UDIM seams | Stroke-to-preview, dirty-page recomposition, changing tiles and mip quality | Record frame pacing and page allocations |
| Full physical paint | Coat/sheened fabric capture and interactive edits | Verify channel accuracy before timings are compared |
| GPU backend parity | WebGL2 vs supported WebGPU cooking, fallback count and compiler errors | Record adapter capabilities, actual backend and reference hash |
| Game-time recook | Per-object variation, cached/reused seeds, first-use compression, device loss | Record frame budget, memory and GPU upload stalls |
| Large scanned image capture | Delighting/height/normal time, temporary allocations, UI responsiveness | Include cancellation and failure cleanup |
| glTF/MaterialX package | Export and reimport wall time, bytes, compatibility warnings | Performance is secondary to correctness and fidelity |

For **each** new run, record OS, browser/WebView2 version, GPU/adapter and driver, backend, device features, relevant library/Three version, output resolution, graph/material hash, cold/warm cache state, run count and specific time measurement scope. Exclude metrics that cannot be reproduced or whose units are ambiguous.

## 3A. Live editor graph-cook timing (new M0.5 instrumentation)

`texturing/graph/cookTiming.ts` provides a **bounded 64-sample** window of successful authoring graph-evaluation timings. `TextureGraphSession` records elapsed wall-clock time through evaluation and preview/thumbnail update; the graph editor reports p50/p95 after at least five successful runs that actually recomputed nodes.

These are **local observations**, not cross-machine benchmark results, GPU hardware timestamps, or game-frame times. A run that only hits the graph cache (zero recomputed nodes) is counted separately and **excluded from the latency percentiles**. A changed graph topology or evaluation resolution resets the comparison window to avoid mixing unrelated workloads.

The existing visual software-GPU scene values in Section 1 are distinct from these live-editor measurements. To meet the M0.5 exit gate, a benchmark run must still export reproducible values, record hardware/browser/driver settings, control cold/warm caches, and compare the specified 512/2K/4K fixtures on selected machines.

## 4. Performance gate policy

- Set numeric budgets **only after** controlled reference runs across chosen device tiers. A 10% p50/p95 regression is a **review trigger**, not a universal automatic failure threshold.
- Distinguish GPU memory estimates from actual residency and CPU staging allocations; quote both if they are measurable.
- When a backend is unsupported, **record the fallback and its cost** instead of comparing empty/non-equivalent scenes.
- When M1/M2 changes visual outputs, update reference pictures only after artist and reviewer signoff; keep old/new pictures with the PR.
- Preserve independent WebGL2 editor compatibility tests even while WebGPU is extended.

**M0.5 is still open:** a historic software-GPU scene table is useful evidence, but it is insufficient for texture authoring latency, real-GPU budgets or runtime streaming gates.

## 5. Opt-in current texture-graph cook benchmark

The visual harness includes an **opt-in GPU texture cooking benchmark** using the existing brick/noise/normal/Pixel Processor proof graph. It runs at 512, 2048, or 4096 pixels and measures:

- Cold evaluation wall time and number of nodes actually executed.
- A separately timed one-pixel GPU synchronization readback.
- Packing/encoding the base-color and normal PNG maps.
- An identical request's evaluation time and cache hit (cached nodes must equal zero).
- Evaluation and GPU synchronization after changing one upstream noise parameter, including recomputed-node count.

Measurements appear in `tests/visual/output/numbers.json` under `texture-graph.textureCook`. The `_benchmark` section records the request's renderer, hardware/software selection, user agent, OS, architecture and resolution. These are **separate authoring-workload measurements**, not part of the historic scene-render table.

Run from `fbx-viewer (1)`:

```powershell
npm ci
npm run texture:benchmark -- --texture-size 9
npm run texture:benchmark -- --texture-size 11
npm run texture:benchmark -- --texture-size 12
npm run texture:benchmark -- --texture-size 11 --renderer webgpu
# Ask for actual hardware instead of software SwiftShader on supported machines:
npm run texture:benchmark -- --texture-size 11 --gpu
```

The size argument is log2: 9 = 512, 11 = 2048, 12 = 4096. This mode runs only the `texture-graph` scene and **does not compare** an intentionally resized screenshot with the fixed visual reference or modify reference PNGs. Run `npm run rendering:verify` separately for image parity.

**Provenance:** Requested GPU mode and user agent **do not establish the actual GPU vendor/driver**. Record adapter details independently before describing these results as hardware-specific. Repeat each configuration on a controlled device and report p50/p95 for each phase, holding resolution, OS, browser, backend, driver, graph hash and cache conditions constant. The benchmark's cold evaluation is **not** an editor's full first-preview latency; UI mount, upstream project loading and texture presentation must be measured separately.

This opt-in mode adds graph evaluations only when requested. M0.5 remains incomplete until 300-node/iteration workloads, paint-stack and UDIM updates, capture, true GPU residency and real-device comparisons are measured.

### Reproducing an opt-in graph cook

Each opt-in `numbers.json` records the checkout commit and whether the working tree had changes in `_benchmark`. The scene's `textureCook` entry records the backend that actually cooked the graph, the adapter details it exposed, and SHA-256 hashes of the normalized graph before and after the incremental edit. Compute the hashes over the UTF-8 JSON representation. Resolution is part of each graph. Missing Git or adapter information appears as `null`.

Compare runs with the same input and edited hashes, resolution, backend and adapter. Use a clean checkout when attributing a measurement to a commit. A hardware comparison also needs the driver version from the test machine if its browser does not report one.

### Repeated samples and allocation peaks

From the editor directory, run `npm run texture:benchmark -- --texture-size 11 --renderer webgl2 --samples 30` for a 30-sample, 2048-pixel series. Use `--texture-size 12` for 4096 pixels. The manual workflow offers the same sample choices on its software adapters. For a selected hardware tier, add `--gpu` locally and retain the reported cooking adapter and the machine's driver details.

The runner builds the proof page once and starts a fresh browser process and profile for each sample. Each cold phase begins with an empty graph evaluator. WebGPU parity probes run before the measured cook. OS and driver caches can persist across browser launches. The unchanged and edited phases reuse the evaluator from the cold phase. The expected cold, cache-hit and edited node counts are five, zero and four respectively.

Multiple samples produce one numbered directory per capture under a new `samples-*` directory. Each contains the raw `numbers.json` and final scene image. A completed series contains `summary.json` with nearest-rank p50/p95 in milliseconds for each phase. The runner rejects invalid durations, fallback, and changes in graph hashes, renderer, adapter, reported browser devices or source metadata. A failed series retains the samples already written. Single samples continue to write the usual `numbers.json`.

`textureCook.allocationBytes` records the estimated bytes at cook entry, the highest estimated allocation reached, and the bytes before evaluator disposal. The WebGL2 counter follows the cooking context's tracked buffers, textures and renderbuffers. The WebGPU counter follows all tracked buffers and textures on the page, including renderer activity on the shared device. These counters describe API allocations. CPU process memory and physical GPU residency still require a device profiler. Chromium's `browserGpuDevices` lists the devices and driver strings it exposes, which can include adapters other than the one in `textureCook.adapter`.

A maintainer can apply the `texture-benchmark` label to a same-repository pull request to request two independent software samples in each of four configurations (WebGL2 and WebGPU at 2K and 4K). The run checks out the labeled head commit. Its artifacts contain the raw samples and summary for each configuration. Reapply the label to measure a new commit. Two samples exercise the protocol and provide initial observations. Use the longer manual series on a controlled machine to establish latency budgets.
