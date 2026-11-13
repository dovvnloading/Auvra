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

## 2A. Real-clock cook measurement from the existing visual scene

The `texture-graph` visual scene now reports a `graphCook` object in `tests/visual/output/numbers.json` for each completed run. It measures real browser wall-clock time from immediately before calling its 512×512 procedural graph cook until the GPU pictures are encoded, with fields `milliseconds`, `pixels`, `backend` (actual cook backend), and `fallback` (whether it used a compatibility route).

**This is not the 20-frame rendering metric**, and its clock is deliberately independent of the fixed virtual clock used for deterministic reference pictures. The existing PNG references and image-difference thresholds do not change.

To collect current samples, use the existing visual verifier on software GPUs and optionally `--gpu` on actual hardware; retain its `numbers.json`, browser version, adapter identity and revision. The archived 115-record history shown above **predates this field**, so its table must not be retroactively treated as graph-cook timings. Only 512×512 is covered by the new visual-scene measurement; 2K/4K and cold/warm editor fixtures remain open.

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

## 4. Performance gate policy

- Set numeric budgets **only after** controlled reference runs across chosen device tiers. A 10% p50/p95 regression is a **review trigger**, not a universal automatic failure threshold.
- Distinguish GPU memory estimates from actual residency and CPU staging allocations; quote both if they are measurable.
- When a backend is unsupported, **record the fallback and its cost** instead of comparing empty/non-equivalent scenes.
- When M1/M2 changes visual outputs, update reference pictures only after artist and reviewer signoff; keep old/new pictures with the PR.
- Preserve independent WebGL2 editor compatibility tests even while WebGPU is extended.

**M0.5 is still open:** a historic software-GPU scene table is useful evidence, but it is insufficient for texture authoring latency, real-GPU budgets or runtime streaming gates.
