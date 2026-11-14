# Garment engine development plan

## Starting point

The Garment component cooks measured polygon panels and directed seams into a fixed triangular mesh. A 120 Hz CPU solver handles anisotropic membrane strain, dihedral bending, progressive stitches, animated body proxies and contact between panels in one component. The editor, fitting worker and standalone player share the cooker and solver. Fixed-topology fitting clips have a versioned recipe and content digest. The current cooker permits 32 panels, 256 seams and 8,192 cooked vertices per component. The authoring guide includes two projects that can be imported and exported today. [Garment authoring guide](garments.md)

The stages below describe proposed work. Each stage identifies a scene or measurement that can reject the implementation. The two shipped projects remain regression inputs throughout.

## 1. Simulate complete outfits

A shirt and a coat attached as separate components currently advance independently. An outfit needs one clock and an agreed snapshot of character transforms, even when the garments have different object origins. The first vertical slice is a saved scene with a separately selectable shirt, jacket and animated wearer.

- Introduce a per-scene garment simulation coordinator. Register live instances by object and component identity. Advance each fixed tick once, after sampling the rig and before publishing render geometry. Split the existing step into prediction, internal constraints, coupled contact and velocity finalization. Keep the single-instance stepping API as a caller of those stages so offline bakes and existing scenes keep their meaning.
- Transform candidates to one declared collision space. Convert projected displacements back using the owning instance's transform. Specify supported scale with tests for uniform and nonuniform transforms. A singular transform needs an explicit diagnostic. Before adding authored outfit-wide ordering, define how panel ranks from different garments interact when both have a base layer.
- Build a broad phase across garment bounds, then triangle bounds for overlapping garment pairs. Solve thin feature pairs symmetrically using the inverse masses of both owners. Use stable pair ordering, per-pair work counts and an explicit policy for saturation. Preserve pins when the opposing garment moves or unloads.
- Exercise a jacket cuff sliding over a sleeve during elbow flexion, a shirt under a pinned waistband, reversed component registration, removal during contact and two independent viewports. Measure signed separation, penetrating face pairs, seam error and saturated ticks. A matched scene with the jacket removed should reproduce the single-shirt trajectory within a recorded tolerance.
- An outfit bake must include every participating pattern, fabric, binding, transform trajectory and solver revision in its recipe. Verify invalidation when a cuff changes, and round-trip the result through the host's build and import paths.

## 2. Establish a contact reference for difficult fits

Use an offline double-precision solver on a small corpus with feasible initial states. Start with crossing edges, a folded cuff, a closing armpit, a four-layer stack and a deliberately jammed pin. Track independent triangle intersection counts, minimum distance over the motion, maximum seam opening, residual force and retries. Retain input trajectories and output poses so the preview can be compared at the same physical time.

Evaluate thickness-offset barriers, conservative continuous collision detection and line search on these scenes. When a feasible step cannot be found, keep the last accepted state and record the offending pair and timestep. A separately labeled recovery path is needed for initially intersecting arrangements. Acceptance includes a real failure case, its diagnostic, and a successful retry with a smaller step. C-IPC provides an independently published formulation and test problems for this comparison. [Li, Kaufman and Jiang, Codimensional Incremental Potential Contact](https://ipc-sim.github.io/C-IPC/)

## 3. Fit and validate real fabrics

The current fitter accepts tensile, simple shear and mass measurements. Its examples use synthetic loads. Acquire repeated measurements from identified cloth samples, with unloaded dimensions, grain orientation, units, loading direction and instrument uncertainty. Reserve some loads and a separate drape experiment for evaluation before fitting.

Extend the material representation only where repeatable residuals justify it. Candidate extensions include warp–weft coupling, nonlinear tensile and shear response, direction-dependent bending and loading/unloading curves. Fit positive material parameters, check energy and derivative consistency numerically, and exercise extrapolation beyond the measured interval. Use bending measurements to identify bending parameters independently. Compare held-out load errors and draped geometry against both the present model and experimental repeatability. Store raw measurements, units, fitted parameters and the model version together. [Clyde, Teran and Tamstorf, Modeling and Data-Driven Parameter Estimation for Woven Fabrics](https://doi.org/10.1145/3099564.3099577)

## 4. Edit production patterns and preserve sewn detail

Introduce stable curve and sewing-interval IDs for Bézier edges, internal lines, darts, notches, ease and partial or multi-segment seams. The editable chart owns dimensions and grain. Tessellation should consume an arc-length correspondence so splitting a curve or changing mesh resolution preserves paired stitch locations. Verify physical length and ease on differently sampled curved edges, reversed sewing directions and a closed dart. Undo, save, reopen and export the complete edit sequence.

Separate simulation topology from the render mesh. Bind render vertices in pattern space, keeping panel and seam identity at discontinuities. First verify a fixed high-resolution surface against a coarse simulation. Then evaluate adaptive refinement around bent edges and near contacts. Transfer rest coordinates, density-weighted mass, momentum, pin attachments and seam correspondence across refinement. Compare a folded sleeve against a uniformly refined reference and check conservation at every topology change. Playback needs a topology-aware cache or a fixed render-mesh recording before adaptive bakes can ship. [Narain, Samii and O’Brien, Adaptive Anisotropic Remeshing for Cloth Simulation](https://graphics.berkeley.edu/papers/Narain-AAR-2012-11/Narain-AAR-2012-11.pdf)

## 5. Qualify interactive performance and delivery

Benchmark end-to-end frames at several mesh densities with one top, one layered outfit and several characters. Capture cold asset load, pattern cooking, skinning, broad and narrow phases, solving, normals, geometry upload and rendering separately. Report p50/p95/p99 frame times, memory, hardware, browser, backend, simulated ticks and dropped simulation time. Keep quality metrics beside timing results so reducing collision work cannot masquerade as a speedup.

Prototype parallel constraint coloring or vertex block descent and compare at matched seam, strain and contact error. On WebGPU, keep positions resident for rendering, measure readbacks required by editing and export, and handle device loss and cancellation. The CPU path supplies repeatable comparisons and a playback fallback. Select a backend only after profiling the complete frame on a declared target device. [Chen, Liu, Yang and Yuksel, Vertex Block Descent](https://graphics.cs.utah.edu/research/projects/vbd/)

Release evidence should include the original pattern and measured inputs, solver and cache versions, the comparison scene, output measurements and a recording from the actual player. Repeat the same workload after project import, standalone export, cold load and playback seek. Publish supported device and garment sizes alongside the measured results.
