# Engine Completion Roadmap — Auvra

> **Scope:** whole engine: Rust native runtime, React/Three.js editor, gameplay runtime, Python host, release pipeline, tests and docs. **Mode:** documentation only. No code was changed, built or run.
> **Date:** 2026-10-26. **Revision:** `48d7d7c` (branch `codex/fix-stage9-foundation-blockers`).
> **Method:** five independent static audits (native runtime, editor core and rendering, gameplay framework, platform and shipping, and a repo-wide capability sweep). Each was paired with an adversarial verifier that tried to refute every blocker, major, missing and claim-mismatch gap, corrected its severity and added gaps the auditor missed. A sixth agent re-checked the status of every finding in `findings.md` and the ranked gaps in `CHARACTER_ANIMATION_UNREAL_GAP_AUDIT.md`. The headline claims were then spot-checked by hand (see §1).

## Progress (updated 2026-10-28)

| Phase | Status | Merged in |
|---|---|---|
| 0 — Fix what is broken now | Done | #18, #19, #20 |
| 1 — Make a game shippable | Done: standalone web player, Windows exe player, Build Game, game settings, title/pause/save/load | #21, #22 |
| 2 — Core engine model | Done: hierarchy, components, prefabs, gizmo for all objects, outliner tree, multi-select, copy/paste/duplicate, fly camera, surface placement, glTF/GLB/OBJ import, import options, reimport, folders, undo in all editors, migrations, faster edits | #23 |
| 3 — Game framework | Done: Rapier physics (collider/rigidBody components, raycasts), character controller, triggers and On Overlap, input actions + gamepad + rebinding, audio buses and audioSource component, particles, flow and world visual-scripting nodes, level variables, grid navigation for enemies, blueprint-driven AI and player stats, animation crossfades and exit time, material overrides, terrain paint layers, lighting panel, authored title/pause menus with button actions, localization | #24 |
| 4 — Release quality | In progress. Done: F3 performance overlay, third-party notices in builds, user docs (docs/), Starter, Arena, Courtyard and Outpost samples with a template picker (Outpost's characters and scenery are made in-repo, so it can be shared), first gameplay tests, the fixes from play-testing them in the editor and in built games, and the partly-fixed findings closed (F-009, F-070, F-077) with graph writes fenced to their project. Left: signed releases (needs the publisher's code-signing certificate) and the signed install/upgrade/rollback check that comes with them (F-072) | #24, #26–#29, #37–#39, #43, #46 |
| Beyond the bar | Done: animation, scripting, timeline and rendering components; play tools (pause, step, inspect); live prefabs; ragdolls; water; reflection probes; terrain LOD; level cameras and camera cuts; behavior trees; level streaming; NPC dialogue; online multiplayer through a relay server | #30–#36 |
| Character and animation depth | Done: Mixamo character pipeline (clip matching, jump/fall/land, upper-body fire and aim); natural-looking levels by default (sky, fog, ground, shadows that follow the view); animation LOD for distant characters; retargeting onto any humanoid rig (Unreal, Rigify, Biped and plain bone names, A-pose or T-pose); blend sync and sync groups; additive montages and hit reactions; nested state machines; animation curves; mirrored clips; over-the-shoulder aiming; Reach IK; conduit states; player weapons with magazines, reloads and switching | #39–#42, #44, #45 |

## 0. TL;DR

Auvra has a well-built editor platform but cannot ship a game. The launcher, host protocol, transactional project system, diagnostics, editor MSIX pipeline and CI are solid. Three things are missing:

1. **There is no path from an authored project to a player-facing build.** No export, build-player or cook-for-target step exists anywhere. The only release artifact is the editor.
2. **There is no general way to build gameplay.** Play mode is a hardcoded third-person-shooter template with two fixed entity types, about 20 visual-scripting node kinds, no physics engine, no text scripting, and no runtime UI. Authored HUDs are never shown in play.
3. **The native Rust/wgpu "production renderer" is a placeholder.** It draws one clip-space triangle per entity, with no camera, meshes or textures, and it cannot run without the editor host.

The first decision is which runtime ships games (§3). Everything after that is dependency-ordered work in five phases (§4). §7 lists all 125 verified gaps (22 blocker, 78 major, 25 minor) with evidence, a "done looks like" and the roadmap phase each one belongs to.

## 1. Completion bar and verification

**Bar.** "Complete" here means a small indie team can author a small-to-mid 3D game end to end in the Auvra editor and ship a standalone build that runs without the editor. That covers importing assets, building levels, scripting gameplay, adding physics, audio, UI and animation, and testing in play mode. The reference is Godot 4 or early Unity, not Unreal 5 parity. Severity follows that bar: **blocker** means a game cannot ship without it, **major** means a typical game needs it, and **minor** means it matters but does not gate shipping.

**Verification.** No gap was refuted outright. Many were marked *partial*: the gap is real but sits in reduced form elsewhere, or its severity was overstated against the bar. The most common correction was that a native-runtime gap is a blocker only if native becomes the shipped runtime, because the Three.js editor runtime already has the feature. Each entry in §7 shows the auditor's severity, the verifier's verdict and corrected severity, and the verifier's note when it changes the picture. Minor gaps that were not sent to a verifier are marked *unverified*.

**Hand spot-checks (confirmed).**

- Native vertex layout: 10 floats are written per vertex (`native/src/gpu.rs:950-962`), but the pipeline stride is 36 bytes, which is 9 floats (`gpu.rs:1231`, `gpu.rs:1263`), and draws divide by 9 (`gpu.rs:717`, `737`, `766`, `823`).
- Play-mode `DestroyActor` calls `removeLevelObject` (`fbx-viewer (1)/hooks/useLevelBlueprintRuntime.ts:240-244`), which persists `dbOperations.deleteLevelObject` through the host (`fbx-viewer (1)/hooks/useLevelManager.ts:482-491`). Playing a level can permanently delete authored objects.
- The host loads schemas from repo-root `protocol/v1` and `project/v1` (`Auvra/host/validation.py:15`, `Auvra/project/schemas.py:21`). The CI release job's host input copies only `Auvra/` (`.github/workflows/verify.yml:255-260`). The packaged editor therefore likely lacks those schemas. This was found by reading code, not by installing the package.

## 2. What is already solid (do not redo)

- **Development launcher:** locked uv environment bootstrap, `npm ci`, loopback Vite, port selection, process-tree ownership, `doctor`/`prepare`/`clean`/`support`, stable exit codes.
- **Versioned host protocol v1:** JSON Schema, generated TypeScript and Python bindings, conformance vectors, fake host.
- **Transactional project repository:** journaled atomic writes, writer lock with read-only fallback, manual and automatic recovery points, cross-domain reference validation, `.auvrapack` import/export, legacy `.forge` import.
- **Diagnostics:** local, bounded, redacted, with explicit support-bundle export and deletion.
- **Editor MSIX pipeline:** deterministic assembly, hashed release manifest, content and secret scanning, SBOM, offline packaged-startup verification. CI covers the editor on Node 22/24, Python 3.12/3.14 on Windows and Ubuntu, native build/test, and a real WebView2 project-lifecycle smoke.
- **Native foundations:** an authenticated framed IPC service with bounded errors, and a deterministic fixed-step world store (60 Hz accumulator, revision and generation checks, atomic transactions, verified replay log). These are good foundations for a future simulation core.
- **Earlier defects:** 75 of the 80 findings in `findings.md` are fixed in code. Five are partly open (§6).

## 3. Decision first: which runtime ships games

Auvra currently has two engines that share no gameplay data or simulation (NAT-M1, PLAT-M5, EDIT-01).

| | Three.js play runtime (in editor) | Native Rust/wgpu runtime |
|---|---|---|
| What runs today | All play mode: PBR materials, shadows, sky/IBL, skinned animation with a state machine and 2D blend, spatial audio, level blueprints, the HUD editor | One clip-space triangle per entity, a light-count "PBR" shader, placeholder shadows, IBL, picking and gizmos; simulation is `position += velocity`, and nothing in the host or frontend calls `world.advance` |
| Can it run without the editor? | No. It is bound to the editor's React tree and the WebView2 host transport | No. It exits without a host session token and has no project loader |
| Missing for a game runtime | Extraction into a standalone player, plus Phases 2–3 | Meshes, camera, materials and textures, skinning, hierarchy, components, game loop, input, audio, physics, scripting VM, UI, player packaging, plus Phases 2–3 |

**Recommendation:** ship games on the Three.js runtime first, extracted into a standalone player. A web export then becomes cheap, and a desktop player can reuse the existing WebView2 or an equivalent shell. Keep the native runtime experimental until gameplay exists. Its deterministic world can later become the simulation core, and wgpu can return once there is something real to draw. Making native the game runtime instead means rebuilding every runtime subsystem in Rust (§4, native-route list), which is a much larger body of work. This choice belongs to the project owner and sets the shape of Phases 1–3.

## 4. Roadmap

Gap IDs in parentheses refer to §7. Complexity is relative: S < M < L < XL.

### Phase 0 — Fix what is broken now

- **Play mode is not isolated from authored data.** Play-mode "Destroy Actor" permanently deletes the level object from the saved project, and play has no authored player start. Run play on a disposable copy of the level state. (GAME-06, CAPA-M01, EDIT-11)
- **BeginPlay re-runs on every play-mode render,** and the whole play tree re-renders every frame. (GAME-05)
- **Enemies deal no damage in level play mode.** (GAME-11)
- **Level-script actor references use display names,** so events hit every same-named instance and break on rename. (EDIT-M01)
- **The native vertex stride mismatch corrupts all native scene and gizmo geometry.** Tests only compare a frame hash with itself, so they cannot catch it. (NATI-03)
- **Native validation likely rejects editor-authored spawner, audio, sky and terrain objects** because their `modelId` is empty. Native extraction above 4,096 renderables terminates the native process. Native hydration failure closes the project even though the editor renders with WebGL2. (EDIT-12, NAT-M4, NATI-24)
- **The packaged editor likely lacks the protocol and project schemas** it loads at startup. (PLAT-08)
- **Level edits are lost.** Debounced edits are dropped on Save, close or project switch, and failed persists revert silently. Terrain heightfields exceed the 256 KiB host message limit, so sculpted terrain fails to save, or saves but cannot be reopened. (EDIT-09, EDIT-10, PLAT-M2)
- **Documentation overclaims.** README/REFACTOR still describe native PBR, shadows, IBL, animation, picking and gizmos as a production baseline. Correct the claims, and remove misleading or dead scaffolding. (NATI-20, CAPA-11, GAME-22, EDIT-20)
- **Open items from `findings.md`:** the signed install/upgrade/rollback smoke never runs in CI (F-072); it needs the code-signing certificate. F-009 and F-077 are fixed. See §6.

### Phase 1 — Make a game shippable

- **Standalone player runtime.** Extract the play runtime from the editor's React tree and host transport so a game runs without editor UI, Python, AI providers or a session token. Make it the single designated shipping runtime, and render authored HUDs in it. (GAME-01, PLAT-02, CAPA-01, NATI-01, EDIT-01, NAT-M1, PLAT-M4, PLAT-M5)
- **Export / build-player pipeline.** Add a "Build Game" action that collects only reachable assets, converts formats, strips editor-only data, packs archives, and writes an output folder that launches on a clean machine. Windows first, and web if the Three.js route is chosen. (PLAT-01, PLAT-03, NATI-18)
- **Game-level project settings:** app identity, startup level, player start, and window, input and quality defaults. Add level rename, and stop picking the player pawn project-wide. (PLAT-04, EDIT-M02)
- **Game flow and a player-facing shell:** title screen to level transitions, pause, a save-game API, an options menu and player crash reporting. (GAME-13, CAPA-07, CAPA-M03, PLAT-M3, PLAT-05)
- **Player platform targets:** define the target matrix for exported players (Windows 10/11 x64, web, then Linux and macOS). (PLAT-06, CAPA-17, NATI-25)

### Phase 2 — Core engine model

- **Entity/component model, transform hierarchy and prefabs.** Gameplay currently knows only "Player Character" and "Enemy Controller". Blueprints are reduced actor templates with no hierarchy or overrides. Everything in Phase 3 depends on this. (EDIT-04, GAME-02, CAPA-02, EDIT-07, NATI-09, NATI-10)
- **Editor fundamentals:**
  - Move, rotate and scale props, foliage and terrain after placement. The gizmo targets only spawner, audio and sky objects. (EDIT-02)
  - Multi-select, duplicate, copy/paste, focus, a fly camera, Ctrl+S and preferences. (EDIT-15)
  - Undo/redo in every editor (blueprints, animation graphs, level logic, HUD), not just the level-object array. (EDIT-08, CAPA-M04)
  - Place objects and paint foliage onto terrain and mesh surfaces. (EDIT-13)
  - Asset folders, rename, move, dependencies and drag-to-viewport. (EDIT-16)
  - Connect the single-purpose tabs into one editor workflow. (EDIT-18)
- **Asset pipeline:**
  - Import glTF, OBJ, textures and audio with import options and reimport. Today only FBX imports, every model is forced to 5 m, and FBX is re-parsed on every project open. The native cooker is not on that path. (EDIT-03, CAPA-08, NATI-19)
  - Source tracking, import settings and dependency queries on top of the existing logical-ID layer. (PLAT-11)
  - A version-control-friendly project layout, and a migration framework with engine-version stamping. (PLAT-10, PLAT-09)
- **Edit-time scale:** stop re-hashing every asset and re-validating and rehydrating the whole project on every edit. Batch per-instance host transactions. Take native off the edit critical path. Add LOD, chunking and spatial indexing for terrain and foliage. (PLAT-M1, EDIT-14, NAT-M2, NATI-22, CAPA-19)

### Phase 3 — Game framework

- **Physics:** rigid bodies, gravity, colliders, triggers, raycast queries, joints and a character controller, plus collision authoring. Play-mode collision is currently inferred from object scale, and invisible logic objects block the player. Rapier runs in both TypeScript and Rust, so it suits either runtime. (GAME-07, CAPA-04, EDIT-M03, NATI-13)
- **Scripting:**
  - Visual scripting needs functions, custom events, loops, spawning, transforms, timers, typed pins, validation, debugging and sane persistence. (GAME-03, GAME-04, GAME-19, CAPA-03)
  - A text scripting / gameplay API. The only user code today is sandboxed HUD JSX. (GAME-14, PLAT-12)
  - Data-driven player, camera and combat instead of hardcoded TPS constants; remove the hard ±50/±100 m world bounds; movers, tweens and timelines for level objects; a fixed-step, ordered gameplay tick. (GAME-08, GAME-M1, GAME-M2, GAME-18)
- **Input:** action maps, gamepad, touch and rebinding. (GAME-09, CAPA-06)
- **Runtime UI:** show authored HUDs in play, with data binding, interaction, menus, font assets and localization. (GAME-12, CAPA-05)
- **Rendering authoring in the working renderer:** placeable point and spot lights, correct shadow coverage, a material system and editor, and terrain texture layers and painting. (EDIT-05, EDIT-06, CAPA-10, CAPA-M02)
- **Content systems:** particles and VFX (GAME-16, CAPA-12); navmesh, pathfinding and authorable AI (GAME-10, CAPA-09); a runtime audio API, mixer buses, streaming and music (GAME-15, CAPA-16).
- **Animation:** montages, notifies, root motion, layered/additive blending, IK, and transition durations that are honoured. Follow the ranked backlog in `CHARACTER_ANIMATION_UNREAL_GAP_AUDIT.md` §6, which has not been started. (GAME-17, CAPA-13)
- **Play-mode tooling:** pause, step, simulate and in-play inspection. (GAME-M3)

### Phase 4 — Release quality

- **Tests:** behavioural coverage for gameplay, play mode and end-to-end authoring. The frontend has about 109 lines of tests for roughly 25k LOC, and its gates are mostly source-regex checks. The native tests cannot detect rendering errors. (EDIT-17, GAME-21, GAME-M4, PLAT-15, CAPA-14, NATI-23)
- **User documentation, tutorials, sample projects and new-project templates.** (PLAT-16, CAPA-15)
- **A profiler and debug overlay** built on the metrics already collected. (CAPA-18)
- **Packaging:** third-party license notices in packages, including a plan for exported games; signed editor distribution. (PLAT-14, PLAT-17)

### Native route (only if native becomes the game runtime)

These are blockers only on that route; the Three.js runtime already covers them in some form:

- Load cooked meshes and replace placeholder triangles. (NATI-02)
- Camera, view/projection and a real frustum. (NATI-04)
- Real PBR with normals, textures and per-light parameters. (NATI-05)
- Real shadows and IBL. (NATI-06)
- A texture pipeline with decode, mips and GPU compression. (NATI-07)
- Skinning and animation evaluation. (NATI-08)
- A ticked game loop with real systems. (NATI-11)
- Scripting execution. (NATI-12)
- Audio, input and in-runtime UI and text. (NATI-14, NATI-15, NATI-16)
- Terrain, sky, fog and particles. (NATI-17)
- A level/scene concept. (NAT-M3)
- A usable native editor viewport: picking readback, real gizmos, docking. (NATI-21)

## 5. Not required for this bar (defer)

- Networking and multiplayer. (GAME-20, CAPA-21)
- A general editor extension API for panels, importers and commands. User gameplay code is covered in Phase 3; the existing plugin system is limited to AI providers. (EDIT-19, CAPA-20, PLAT-13)
- Running the editor on systems other than Windows 11 24H2 x64. (PLAT-07)
- Unreal-level animation: Control Rig, motion matching, Sequencer.

AI providers (fal.ai and the text/code providers) are optional add-ons used only by the HUD AI chat panel and texture generation; they are not on the critical path.

## 6. Status of prior audits

### 6.1 `findings.md` (F-001..F-080)

`findings.md` holds 80 findings, all marked *Completed*. Checked against current code (re-checked 2026-10-28): **78 fixed**, **2 partially fixed**, 0 open, 0 unclear. Critical and High items were verified in code, not from commit messages.

The five that were partly fixed, and where each stands now:

- **F-009** (High) — Custom HUD code can freeze the editor. Fixed (1709c68). The guard budgets each synchronous slice of the code (hudExecutionGuard.ts): a slice opens at the first guard tick and closes when the task and its microtasks finish, so handlers, timers and re-renders that run later start with a full budget, while a loop or promise chain that never yields is still stopped. Concise arrow bodies keep their return value (DynamicHUDComponent.tsx guardBody wraps them in a return). Covered by tests/frontend/hudSandbox.test.tsx and checked in the editor: a Custom element mapping a list with concise arrows renders it, and a 300 ms timer that updates its state keeps counting long after the render slice. There is still no memory isolation beyond the sandboxed iframe.
- **F-044** (High) — Native extraction discards authored renderer data. f9f3a4f. Fixed: authored data now crosses into native (main.rs:2108 animations, :2142 materials, :2289 worlds/scenes/levels/environment/lights). Still open: the GPU still draws one 2D triangle per entity in clip space with no mesh data (gpu.rs:1021-1050 projected_triangle; z is clamped to [-1,1], rotation is Z-only, and animation is an x offset). The PBR vertex shader passes positions straight through (gpu.rs:1131-1137: output.position = vec4(input.position, 1.0)), so there is no camera or view-projection (grep -i 'camera|view_proj' in gpu.rs: no hits). The fragment shader multiplies light counts by constants, with no normals or BRDF (gpu.rs:1140-1152). Real 3D project content cannot render natively. This only matters on the native route (§4): games ship on the Three.js runtime, so it stays open until native becomes the game runtime.
- **F-070** (Medium) — Frontend lacks unit coverage / relaxed compiler. Fixed. tsconfig.json sets strict, noImplicitAny and allowJs:false; CI runs typecheck:strict over every test file and npm test. tests/frontend holds 137 files (about 22,800 lines) covering hydration, editor sessions, level history, persistence ordering, the runtime systems and the editors.
- **F-072** (Medium) — Release lifecycle verification is in-memory only. 791e860 adds release/windows_lifecycle.py (286 LOC install, upgrade, rollback and uninstall smoke). It is opt-in only: grep 'LIFECYCLE_SMOKE' .github/workflows/*.yml returns no hits, so CI never runs it and there is still no recorded evidence of signed install, upgrade or uninstall.
- **F-077** (Medium) — Renderer docs ahead of implementation. Fixed (e1d51cf). README.md describes the native wgpu renderer as a pass-structure scaffold, lists what is real and what is placeholder (one projected triangle per entity, no camera, no PBR, stand-in shadows, IBL, animation, picking and gizmos), and names WebGL2 as the editor and play path.

Smaller residuals on findings marked fixed:

- F-003: fixed. A level switch awaits `flushPendingLevelEdits()` before it begins (`useLevelManager.ts`).
- F-010: replay and extract are still unpaged and return an error for large worlds.
- F-002: lease fencing is still optional in `db.ts` (`requireEditorLease`), though every World Editor write passes one. Animation graph writes are now fenced to the project they were made in: one still queued when another project opens is dropped (`useGraphManager.ts`, tests/frontend/graphManagerProjectFence.test.ts).
- F-069: fixed. The AnimationGraph key listeners ignore keys typed into text fields (`useInputHandler.ts` isEditableTarget).

<details><summary>All findings and their current status</summary>

| ID | Severity | Status | Title |
|---|---|---|---|
| F-001 | Critical | fixed | Host wire revision authority split across frontend clients |
| F-002 | Critical | fixed | Deferred frontend writes can mutate the wrong project |
| F-003 | High | fixed | Switching native levels retains previous level objects |
| F-004 | High | fixed | Project replacement leaks scene resources and is not atomic |
| F-005 | High | fixed | Partial asset failures reported as successful open |
| F-006 | High | fixed | Level rotations stored in degrees, rendered as radians |
| F-007 | High | fixed | Quad view creates four audio systems |
| F-008 | High | fixed | Cyclic blueprint graphs recurse until crash |
| F-009 | High | fixed | Custom HUD code can freeze the editor |
| F-010 | High | fixed | Oversized native responses terminate native engine |
| F-011 | High | fixed | Timed-out native call desynchronizes responses |
| F-012 | High | fixed | Host queue saturation silently drops requests |
| F-013 | High | fixed | Autosave I/O failure can shut down controller |
| F-014 | Critical | fixed | Archive validation/extraction pathname TOCTOU |
| F-015 | High | fixed | Partial recovery points publishable / missing domains restore empty |
| F-016 | High | fixed | Re-ingest cannot repair corrupt hash-named asset |
| F-017 | High | fixed | Save-as/import publish before authority dirs exist |
| F-018 | High | fixed | Command undo can erase later changes |
| F-019 | High | fixed | Cancel during execution leaves job in cancel_requested |
| F-020 | High | fixed | Retry spend charged to original job date |
| F-021 | High | fixed | Update/delete command proposals rejected before target validation |
| F-022 | High | fixed | Provider model discovery depends on call order |
| F-023 | High | fixed | Windows job containment begins after child runs |
| F-024 | High | fixed | Native engine not owned as process tree |
| F-025 | High | fixed | Provider shutdown can hang indefinitely |
| F-026 | High | fixed | Hung WebView thread skips browser cleanup |
| F-027 | High | fixed | Native viewport renders one frame and stops |
| F-028 | High | fixed | Engine snapshots stop at 128 entities |
| F-029 | Medium | fixed | State-changing methods don't advance revision |
| F-030 | Medium | fixed | Event revisions advance before validation |
| F-031 | Low to Medium | fixed | Recovery events omit details |
| F-032 | Medium | fixed | Upload responses >64KiB truncated |
| F-033 | Medium | fixed | Stream/upload forward connection headers |
| F-034 | Medium | fixed | Nested plugin entrypoints install but cannot run |
| F-035 | Medium | fixed | save() marks clean before recovery retention |
| F-036 | High | fixed | Save/export destinations not excluded from source tree |
| F-037 | High | fixed | Preview lookup crosses project boundaries |
| F-038 | High | fixed | Download staging copies persist all session |
| F-039 | High | fixed | Assets committed before referencing mutations succeed |
| F-040 | High | fixed | Hydration defers asset cooking with no retry |
| F-041 | Medium | fixed | Asset jobs outlive project close |
| F-042 | High | fixed | Schemas accept transforms native rejects |
| F-043 | High | fixed | Visible viewport bypasses production render pipeline |
| F-044 | High | partially-fixed | Native extraction discards authored renderer data |
| F-045 | Medium | fixed | MSAA not implemented / FXAA mislabeled |
| F-046 | Medium | fixed | Renderer metrics report placeholders |
| F-047 | Low | fixed | Native session token not authenticated |
| F-048 | Medium | fixed | GPU init mandatory for non-renderer services |
| F-049 | Medium | fixed | Large native worlds clone/thread/lookup costs |
| F-050 | High | fixed | Release PowerShell wrappers return success on failure |
| F-051 | High | fixed | Runtime pin markers don't attest contents |
| F-052 | High | fixed | Signing exposes password, no verify |
| F-053 | Medium | fixed | NUL bytes bypass release scanning |
| F-054 | Medium | fixed | SBOM omits dependency identities |
| F-055 | Medium | fixed | Update metadata accepts non-HTTPS |
| F-056 | Medium | fixed | Cross-backend verification doesn't compare pixels |
| F-057 | High in development, Medium otherwise | fixed | Initial restore races under StrictMode |
| F-058 | High | fixed | Duplicate selection authorities |
| F-059 | High | fixed | FBX cancellation doesn't stop parse or dispose output |
| F-060 | High | fixed | Graph preview mutates canonical materials |
| F-061 | Medium | fixed | Failed optimistic mutations diverge UI/host |
| F-062 | Medium | fixed | Host delete cascades not reflected live |
| F-063 | Medium | fixed | Level undo/redo omits fields, consumes history early |
| F-064 | Medium | fixed | Camera/selection saved inconsistently |
| F-065 | Medium | fixed | Rapid blueprint creation violates single-player invariant |
| F-066 | Medium | fixed | Project-operation errors become unhandled rejections |
| F-067 | Medium | fixed | Renderer recovery limits lifetime losses |
| F-068 | Medium | fixed | HUD coordinates not scaled to editing surface |
| F-069 | Medium | fixed | Keyboard/pointer/a11y incomplete |
| F-070 | Medium | fixed | Frontend lacks unit coverage / relaxed compiler |
| F-071 | Medium | fixed | Default local release discovery uses placeholders |
| F-072 | Medium | partially-fixed | Release lifecycle verification is in-memory only |
| F-073 | Medium | fixed | Windows security boundaries lack production-path tests |
| F-074 | Medium | fixed | Tests don't exercise implied boundary |
| F-075 | Medium | fixed | Diagnostics follow state unbounded / token-based trace gates |
| F-076 | Low to Medium | fixed | Tests can hang/false-pass/skip |
| F-077 | Medium | fixed | Renderer docs ahead of implementation |
| F-078 | Medium | fixed | Diagnostics marks run clean while writer active |
| F-079 | Medium | fixed | Output callback exception stops pipe draining |
| F-080 | Medium | fixed | Frontend port bind race / weak readiness identity |

</details>

### 6.2 `CHARACTER_ANIMATION_UNREAL_GAP_AUDIT.md`

*Updated 2026-10-27.* The ranked gaps are closed in the Three.js runtime except the three below:

- **Done:**
  - one-shot montages with bone masks;
  - notifies;
  - root motion;
  - foot-planting and look-at IK;
  - enemy ragdolls;
  - triangulated 1D/2D blend spaces;
  - any-state transitions with priorities, AND/OR conditions, exit time and honoured crossfade durations;
  - the Rapier character controller;
  - player replication through the relay server;
  - retargeting onto humanoid rigs that are not Mixamo-like, matched by bone role and lined up with the source rest pose (#42);
  - sync groups and phase-synced blend samples (#42);
  - additive layers: additive montages, an Additive pin on Play Player Animation, blueprint hit reactions (#42);
  - nested state machines, edited level by level on the graph canvas (#42);
  - animation curves that drive graph variables (#42);
  - animation LOD: distant and off-screen characters are posed less often (#41).
- **Also fixed while play-testing real Mixamo characters (#39):**
  - animation import;
  - a character's own clips winning over another model's clip of the same name.
- **Still open:**
  - a stand-alone skeleton asset (retargeting matches each import against the target rig instead);
  - stable clip references instead of names;
  - native pose evaluation (native route only).

## 7. Verified gap list

Gaps are grouped by audit area and sorted by verified severity. Each area's auditor gaps are followed by gaps its verifier added (*found by verifier*). Areas overlap on purpose, because the capability sweep searched by capability rather than by directory, so one theme can appear under several IDs; §4 groups them. Complexity is relative: S < M < L < XL.

| Area | Blocker | Major | Minor | Total |
|---|---|---|---|---|
| Native Rust runtime | 3 | 19 | 7 | 29 |
| Editor core and frontend rendering | 5 | 15 | 3 | 23 |
| Gameplay authoring and runtime | 7 | 15 | 4 | 26 |
| Platform, tooling and shipping | 2 | 15 | 5 | 22 |
| Repo-wide capability sweep | 5 | 14 | 6 | 25 |
| **All areas** | **22** | **78** | **25** | **125** |

### 7.1 Native Rust runtime

*Audited:* Rust native runtime (native/src/*.rs, native/Cargo.toml) and how Auvra/desktop, Auvra/host, "fbx-viewer (1)/host" and protocol drive it

The native crate (about 10.2k LOC, 5 deps: pollster, serde, serde_json, wgpu 30, winit 0.30; no image, glTF, physics, audio or scripting crates) is a well-hardened IPC service, not a game runtime. Its parts work as follows: an authenticated framed stdin/stdout protocol; a deterministic, revision-checked entity store with a 60 Hz accumulator and verified replay log; atomic paged project hydration; and a bounded glTF/GLB validator that writes a canonical envelope. Error handling is careful, with Result everywhere and only 5 non-test expect calls. The README/REFACTOR Stage 8 "Complete" renderer claims are mostly hollow. Each entity is drawn as one clip-space triangle with no camera, no mesh data and no textures. The "PBR" shader scales colour by the count of lights. Shadows sample a map rendered from screen space. IBL adds a constant, and "animation" slides the triangle sideways. Picking is never read back, gizmos are an orange triangle, and the capability bits are hard-coded to all-supported. The scene vertex layout is also broken: 10 floats are written per vertex, but the stride is 36 bytes and draw counts divide by 9. It went undetected because tests only compare a frame hash with itself. Simulation is only position += velocity, `world.advance` has no caller in the host or frontend, and play mode, gameplay, HUD and audio all run in the TypeScript/Three.js editor. The binary refuses to start without a host session token, so there is no player mode, no game export and no path from an authored project to a standalone build. As a game runtime it is at an early foundation stage. Nearly every runtime subsystem (meshes, camera, materials and textures, hierarchy, components, scripting, physics, audio, input, UI, skinning, packaging) is missing or a placeholder. Reaching the Godot 4 / early-Unity bar needs nearly every runtime subsystem built, or an explicit decision to ship a web/Three.js player instead.

**What exists:**

- **[solid]** Authenticated framed IPC service (auvra.native/1) with bounded errors and tracing — native/src/main.rs:21-22 (MAX_FRAME 64KiB, PROTOCOL), 300-400 (read/write_frame, bounded response fallback), 863-904 (HMAC-SHA256 session proof, constant-time compare), 1015-1153 (dispatch table, error-code allowlist); host bridge Auvra/desktop/native_engine.py:60-66 (method allowlist), 243-830
- **[solid]** Deterministic world store: 60Hz integer accumulator, max 8 catch-up steps, revision + per-entity generation checks, atomic transactions, canonical command order, replay log with hash re-verification — native/src/world.rs:12-16, 425-468 (apply_commands clones candidate map, all-or-nothing), 473-506 (advance_frame), 598-644 (checkpoint + replay_from_hydration), 11 #[test] in world.rs:1046-1236
- **[stub]** Simulation step (the only 'gameplay' the world runs) — native/src/world.rs:703-723 compute_partition_motion: position += velocity/60 then quantize; no other systems exist. WorldCommand only Upsert/Remove/SetTransform/SetVelocity (world.rs:115-140)
- **[solid]** Atomic, paged project hydration from host (validate-only, begin/append/commit/abort) mapping objects/models/levels/materials/animations/lights/settings — native/src/main.rs:1293-1530 (hydration draft lifecycle), 1927-2099 (project_candidate), 2101-2307 (project_render_state); host side Auvra/desktop/project_host.py:244-263 (field allowlist), 327-358 (_hydrate_native)
- **[basic]** Asset cooker: SHA-256-addressed sources, bounded streaming, glTF 2.0 JSON/GLB structural validation, URI fail-closed, atomic publication, worker queue with cancellation — native/src/assets.rs:463-552 (cook_source), 570-645 (hash-verified staging), 981-1026 (artifact = magic + canonical JSON + raw BIN copy, no GPU-ready conversion), 1046-1370 (structural ref checks), 243-447 (CookWorker); 11 tests assets.rs:1986-2379. Output is never read back by anything: grep 'fn load|read_artifact|load_mesh' over native/src returned no hits
- **[stub]** FBX import in cooker — native/src/assets.rs:1484-1506 accepts only text starting '; FBX 7.' and rejects ANY line other than Vertices/PolygonVertexIndex/a:/braces/comments, so real exported FBX files (FBXHeaderExtension, Objects, Normals, UVs...) fail; binary FBX rejected at 1482-1483
- **[basic]** Render extraction: sphere-frustum culling, distance LOD choice, (mesh,material,lod) batch grouping, pick-id assignment, light filtering, pass plan + FNV hashes — native/src/render_world.rs:470-668, 670-782; 8 tests 1072-1219. Culling never culls in practice: main.rs:1837 always passes wide_frustum() = six identical planes normal (1,0,0) distance 1e9 (main.rs:2830-2837)
- **[basic]** wgpu device init, offscreen render + readback hash, separate winit window present, renderer/surface recovery, GPU timestamp timing — native/src/main.rs:423-491 (Renderer::new, downlevel limits), 591-861 (Viewport open/pump/recover, catch_unwind around surface.configure), gpu.rs:33-98 (GpuTiming), 351-473 (render_offscreen)
- **[broken]** Mesh geometry submission — native/src/gpu.rs:1021-1051 projected_triangle: one 2D triangle per entity in clip space, x/y clamped to [-1,1], size from radius; mesh_id/lods/textures never referenced in gpu.rs (grep 'mesh_id|base_color_texture|lods' in gpu.rs: no hits). Plus stride bug: scene_vertices writes 10 floats/vertex (gpu.rs:952-963) but vertex_state array_stride is 36 bytes/9 floats (gpu.rs:1231-1249) and draws use len/9 (gpu.rs:717,737,766,823)
- **[stub]** Metallic-roughness PBR shading — native/src/gpu.rs:1139-1153: no normals, no BRDF, no texture sampling; lighting = 0.32*#directional + 0.12*#point + 0.18*#spot; uniform_bytes (gpu.rs:1052-1074) uploads only light counts and constant ambient
- **[stub]** Shadow maps — native/src/gpu.rs:696-718 renders the same clip-space vertex buffer into a 1024^2 depth map with no light view-projection; fragment samples it at screen-space UV (gpu.rs:1136, 1146-1147)
- **[stub]** Image-based lighting — native/src/gpu.rs:1067 uploads only a bool 'ibl present'; shader adds constant 0.08 (gpu.rs:1142); IblInput is four u64 handles never resolved to textures (render_world.rs:317-322)
- **[stub]** Skeletal / clip animation — render_world.rs:224-263 AnimationInput is clip_id/duration/speed only; sample() yields normalized time; gpu.rs:1022-1026 adds time/1e8 to the triangle's x. main.rs:2749-2758 hard-codes duration_ticks:1; hydration sets Entity.animation None (main.rs:2071)
- **[basic]** HDR intermediate + ACES tone mapping — Rgba16Float HDR target gpu.rs:545-553; post shader gpu.rs:1396-1399 applies Reinhard (color/(color+1)) then Narkowicz ACES curve then gamma 2.2: real but double-tonemapped
- **[basic]** Anti-aliasing (MSAA / FXAA) — MSAA is real: sample-count pipelines + resolve pass gpu.rs:514, 293-339, 825-842. 'FXAA' is a 5-tap box blur (gpu.rs:1380-1382)
- **[stub]** Post-processing chain (bloom, grading, vignette, sharpen) — single fullscreen pass with fixed constants, gpu.rs:1383-1395; 'bloom' is threshold*0.12 add with no blur, grading a fixed tint; no authored parameters
- **[stub]** Integer entity picking — R32Uint pass rendered (gpu.rs:768-795) into a texture created with RENDER_ATTACHMENT only (gpu.rs:628-636, no COPY_SRC); never read back and no pick/query method in dispatch (main.rs:1069-1134)
- **[stub]** Editor gizmos — gpu.rs:972-999 draws an orange copy of the entity triangle for selected entities; no translate/rotate/scale handles, no interaction
- **[stub]** Per-adapter capability gating — gpu.rs:232-234 capabilities() always returns RenderFeatureBits::all(); validate_adapter checks only 3 texture formats (gpu.rs:236-271); test asserts all 16 supported (gpu.rs:1492-1497)
- **[basic]** Multithreading — world.rs:572-590 std::thread::scope spawns one thread per partition per advance call (worker count from IPC param, main.rs:1602-1606); assets.rs:243-335 one cook worker thread; stdin reader thread main.rs:2941-2951. Rendering, extraction and hydration are single-threaded
- **[solid]** Error handling / robustness — Result-based throughout; non-test unwrap/expect/panic count: assets 0, gpu 1, main 1, render_world 2, world 1 (all invariant expects, e.g. main.rs:1111); no unsafe blocks; surface configure wrapped in error scope + catch_unwind (main.rs:834-860)
- **[basic]** Test coverage and CI — 44 #[test] total (grep -c '#\[test\]': assets 11, gpu 2, main 12, render_world 8, world 11). CI runs fmt, cargo test, --headless-self-test and --self-test on windows-latest + ubuntu-latest (.github/workflows/verify.yml:99-142). No image-correctness tests: self-test only checks the signature equals itself (main.rs:3231-3246)
- **[basic]** Editor integration of native viewport — ?renderer=native shows a placeholder panel; rendering goes to a separate OS window (fbx-viewer (1)/renderer/AuvraCanvas.tsx:94-113, 159-161); dockSupport 'unsupported' (main.rs:495, 1869); frontend calls only status/snapshot/applyChanges/open/close/renderReference/metrics/recover (fbx-viewer (1)/host/engine.ts:77-88)

#### NATI-01 — No standalone game/player executable or game export pipeline

- **Severity:** blocker (auditor: blocker; verifier: confirmed) · **Kind:** missing · **Complexity:** XL · **Roadmap:** Phase 1
- **Evidence:** native/src/main.rs:3321-3333 exits with code 2 unless AUVRA_NATIVE_SESSION_TOKEN is set; the only modes are IPC, --self-test and --headless-self-test (main.rs:3334-3340). Native has no project-file loader: project data arrives only via IPC params (main.rs:1927 project_candidate). grep -i 'export_game|player build|standalone game|build_game|exportGame' over Auvra/, release/ and frontend components/services: no hits. The release pipeline packages only the editor MSIX with auvra-native.exe as a helper (release/pipeline.py:625, 340).
- **Done looks like:** A player entry point (separate bin or --run-game mode) that runs without Python, WebView2 or a session token. It loads a cooked project pack from disk, opens a fullscreen/windowed surface, and runs the game loop with rendering, input, audio, scripts, physics and UI. The editor gets a 'Build Game' action that cooks all referenced assets and writes an output folder (exe + pak + config) that launches on a clean Windows machine.
- **Verification:** Verified. main.rs:3321-3333 exits 2 without AUVRA_NATIVE_SESSION_TOKEN, and the only modes are IPC, --self-test and --headless-self-test (3334-3340). vite.config.ts:64-67 builds only the 'editor' and 'hud' entries, so no web player entry exists either. A grep for 'standalone|buildGame|exportGame|export_game|Build Game|player.html' outside node_modules hit only @babel/standalone and the ajv standalone validator. The cooker is reachable only through authenticated IPC (asset.submit at main.rs:1119-1121), so a build step has no offline cook command. The dependsOn list assumes native ships the game. A TS/WebView2 player could instead reuse the existing packaging inputs (release/stage_inputs.ps1 takes Frontend and WebView2Fixed; release/pipeline.py:625) and skip NATI-02..18, but it would still need a player entry and physics.
- **Depends on:** NATI-02, NATI-04, NATI-06, NATI-07, NATI-13, NATI-14, NATI-15, NATI-16, NATI-17, NATI-18, NATI-23

#### NATI-13 — No physics

- **Severity:** blocker (auditor: blocker; verifier: confirmed) · **Kind:** missing · **Complexity:** L · **Roadmap:** Phase 3
- **Evidence:** grep -iw 'physics|collider|collision|rigidbody|raycast|gravity' over native/src gives no hits; Cargo.toml has no physics crate. The frontend package.json has no physics library either (grep rapier/cannon/ammo/physx gives no hits).
- **Done looks like:** A Rapier3D (or equivalent) integration covers collider and rigidbody components from authored data, a kinematic character controller, raycast/shape queries, trigger/contact events routed to scripts, layers/masks, and stepping in the fixed update.
- **Verification:** Verified. A grep for 'physics|collider|collision|rigidbody|raycast|gravity' over native/src returns 0 hits. The frontend package.json has no physics library. The only TS 'physics' is components/Sandbox/hooks/usePlayerPhysics.ts, which does circle-vs-circle prop collision and terrain-height snapping (lines 188-224), with no rigidbodies, queries or triggers. Physics is missing on both runtime routes, so the blocker stands either way (Rapier native or Rapier WASM).
- **Depends on:** NATI-10, NATI-11

#### NAT-M1 — No designated shipping runtime: native and the TS play runtime share no gameplay data or simulation

- **Severity:** blocker (found by verifier) · **Kind:** missing · **Complexity:** M · **Roadmap:** Phase 1
- **Evidence:** 8 of the 16 project domains (Auvra/project/schemas.py:15-19) never reach native: metadata, attachments, sockets, textures, audio, blueprints, graphs and hud are absent from the allowlist in Auvra/desktop/project_host.py:257-265. Play mode runs only in TS (components/Environment/LevelGameLoop.tsx, hooks/useLevelBlueprintRuntime.ts). A grep for 'nativeEngine' outside host/ finds only renderer/AuvraCanvas.tsx and renderer/nativeReference.ts. vite.config.ts:64-67 has no player entry. README.md:111-113 keeps WebGL2 as the default, and native is described as a 'launcher-owned' process (README.md:120). Neither README nor REFACTOR says which runtime a shipped game would use, so every NATI-02..18 item is a blocker only under an undecided choice.
- **Done looks like:** A recorded architecture decision selects the player runtime and is validated by a thin vertical slice. For TS, that means a 'player' Vite entry with no editor UI, a host-less project and asset loader, and packaging that reuses the WebView2 fixed-runtime pipeline. For native, it means a cooked scene and gameplay format covering all gameplay domains, executed identically in editor play mode and the shipped build. Either way, exactly one runtime executes play mode in both places.
- **Depends on:** NATI-01

#### NATI-02 — Renderer draws one placeholder triangle per entity; cooked meshes are never loaded

- **Severity:** major (auditor: blocker; verifier: partial) · **Kind:** stub · **Complexity:** L · **Roadmap:** Native route
- **Evidence:** gpu.rs:938-971 scene_vertices emits projected_triangle(entity) (gpu.rs:1021-1051), a 2D triangle sized by radius. gpu.rs has no reference to mesh_id, lods or any texture handle. Nothing reads cooked artifacts back: grep 'fn load|read_artifact|load_mesh|create_texture_with_data|write_texture' over native/src gives no hits, and artifact.bin is only written (assets.rs:511, 998). findings.md F-044 is marked Completed, but its core point that 'GPU geometry is a projected triangle per entity and ignores actual mesh contents' still holds.
- **Done looks like:** A runtime loader parses cooked mesh artifacts (positions, normals, UVs, tangents, joints/weights, indices, submeshes/material slots) into wgpu vertex/index buffers held in a residency cache keyed by asset hash. Extraction batches issue indexed, instanced draws per (mesh, material, lod), with per-instance model matrices in a storage/instance buffer. A real glTF from an authored project renders with correct silhouette.
- **Verification:** The gap is real in native. scene_vertices/projected_triangle (gpu.rs:938-971, 1021-1051) emit one 2D triangle per entity, and only Z-axis rotation is used (gpu.rs:1036-1037). mesh_id is never used in gpu.rs, and artifact.bin is never read back (grep 'artifact.bin|derived_root' in main.rs hits only the self-test at 3256-3265). Severity is overstated against the bar, though. The default editor and play runtime is Three.js (README.md:111-113), and it already renders real meshes (utils/modelLoader.ts with GLTFLoader, workers/fbxImport.worker.ts). This is a blocker only if native is chosen as the shipped player runtime.
- **Depends on:** NATI-04

#### NATI-04 — No camera, view/projection or real frustum; culling never culls

- **Severity:** major (auditor: blocker; verifier: partial) · **Kind:** missing · **Complexity:** M · **Roadmap:** Native route
- **Evidence:** grep -c camera in gpu.rs = 0. The vertex shader passes positions straight to clip space (gpu.rs:1131-1137), and projected_triangle clamps world x/y to [-1,1] and z to [-1,1] (gpu.rs:1026-1043). camera_position is used only for LOD distance (render_world.rs:498-501). Extraction always uses wide_frustum() with six identical planes (main.rs:1837, 2830-2837). There is no camera component in Entity (world.rs:93-111).
- **Done looks like:** A camera component (perspective/orthographic, fov, near/far, active flag) exists in the world. View/projection uniforms are uploaded per frame and the frustum is built from the active camera's view-projection. The native viewport has an editor fly/orbit camera, and game cameras can be scripted.
- **Verification:** The gap is verified. gpu.rs has 0 'camera' hits, and the vertex shader writes positions straight to clip space (gpu.rs:1131-1137). wide_frustum() is six identical planes at 1e9 (main.rs:2830-2837). The camera appears only as a position used for LOD (main.rs:2578-2586, render_world.rs:498-501). It is a blocker only on the native-player route. The Three.js editor and play runtime has full cameras.

#### NATI-05 — Fake PBR: no BRDF, normals, textures or per-light parameters; light colour/intensity dropped

- **Severity:** major (auditor: blocker; verifier: partial) · **Kind:** stub · **Complexity:** L · **Roadmap:** Native route
- **Evidence:** The fragment shader (gpu.rs:1139-1153) multiplies colour by light counts, and uniform_bytes uploads only counts (gpu.rs:1052-1074). WorldRenderLight has no colour/intensity (render_world.rs:305-314). world LightData colour/intensity (world.rs:59-69) are discarded by world_light_input (main.rs:2726-2747), and project hydration sets Entity.light None (main.rs:2070). The MaterialReference texture handles (render_world.rs:213-221) are never used by gpu.rs.
- **Done looks like:** Cook-Torrance metallic-roughness shading uses vertex normals/tangents and samples baseColor, normal, metallicRoughness, occlusion and emissive textures through material bind groups. A light storage buffer carries colour, intensity, range and cone, with a clustered or forward+ light loop. Alpha mask/blend and double-sided materials are supported. Output visually matches the editor's Three.js MeshStandardMaterial within tolerance.
- **Verification:** Verified as a native gap. The fragment shader is count-scaled (gpu.rs:1139-1153), and uniform_bytes uploads only counts (gpu.rs:1052-1074). WorldRenderLight has no colour or intensity (render_world.rs:305-314). parse_render_light (main.rs:2652-2722) and world_light_input (2726-2747) both ignore colour and intensity. The auditor missed one more problem: the post chain applies Reinhard before the ACES fit (gpu.rs:1396-1398), then a manual pow(1/2.2) (gpu.rs:1399) into an Rgba8UnormSrgb target (main.rs:472), which double-encodes gamma. Native output therefore cannot match the editor's ACESFilmic plus SRGB output (AuvraCanvas.tsx:143-144). This is a blocker only if native is the player runtime.
- **Depends on:** NATI-02, NATI-04, NATI-07

#### NATI-06 — Shadows and IBL are placeholders

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** claim-mismatch · **Complexity:** M · **Roadmap:** Native route
- **Evidence:** The shadow pass renders the camera-space triangle buffer into a 1024^2 depth target with no light matrix (gpu.rs:696-718), and the fragment samples it with screen UV (gpu.rs:1136, 1146-1147); all shadow textures are re-created per frame (gpu.rs:619-627). IBL is a bool adding a constant 0.08 (gpu.rs:1067, 1142). The README claims 'shadows, image-based lighting' (README.md:130-134).
- **Done looks like:** Directional cascaded shadow maps and spot/point shadow maps use light view-projections with PCF filtering and honour casts/receive flags. IBL loads an environment HDR/cubemap, generates or loads irradiance, prefiltered specular and a BRDF LUT, and samples them in the BRDF.
- **Verification:** Verified. The shadow pass draws the clip-space scene buffer with the plain depth pipeline and no light matrix (gpu.rs:696-718). The PBR fragment samples it at screen UV (gpu.rs:1136, 1146-1147). The shadow texture is re-created every frame (gpu.rs:619-627). IBL is only a presence bit (gpu.rs:1067) adding 0.08 (gpu.rs:1142), and the IblInput texture ids are never resolved. README.md:130-134 claims shadows and IBL.
- **Depends on:** NATI-04, NATI-05

#### NATI-07 — No texture/image pipeline: no decode, mips or GPU compression, nothing uploaded

- **Severity:** major (auditor: blocker; verifier: partial) · **Kind:** missing · **Complexity:** L · **Roadmap:** Native route
- **Evidence:** The cooker writes canonical JSON + raw BIN only (assets.rs:981-1026); images inside glTF are only reference-validated. Cargo.toml has no image/ktx/basis crate. grep 'TextureFormat::Bc|Astc|Etc2|ktx|basis' over native/src gives no hits. No texture is ever created from asset data.
- **Done looks like:** The cooker decodes PNG/JPEG/HDR and emits GPU-ready textures (KTX2 with BC7/BC5/BC4 or uncompressed fallback, full mip chains, sRGB vs linear flags). The runtime streams them into wgpu textures with samplers per material, under a memory budget and with an eviction policy.
- **Verification:** Verified for native. Cargo.toml has no image crate, and grep 'TextureFormat::Bc|Astc|Etc2|ktx|basis' and 'create_texture_with_data|write_texture' return 0 hits. cook_source accepts only glTF, GLB and ASCII FBX (assets.rs:476-512, 'unsupported_source_format'), so PNG and JPEG textures cannot even be submitted. The editor runtime loads textures through Three.js. This is a blocker only on the native-player route.

#### NATI-08 — No skeletal animation: no skins, clips, skinning or blending at runtime

- **Severity:** major (auditor: blocker; verifier: partial) · **Kind:** stub · **Complexity:** XL · **Roadmap:** Native route
- **Evidence:** AnimationInput holds only clip_id/duration/speed (render_world.rs:224-230), and sample() returns normalized time (render_world.rs:240-263). The GPU shifts the triangle by time/1e8 (gpu.rs:1022-1026). world_animation_input hard-codes duration_ticks 1 (main.rs:2749-2758). The cooker validates glTF skins structurally (assets.rs:1308-1316) but nothing evaluates them. CHARACTER_ANIMATION_UNREAL_GAP_AUDIT.md covers the editor side.
- **Done looks like:** The cooker extracts skeletons, inverse bind matrices and animation channels. The runtime samples clips with interpolation (LINEAR/STEP/CUBICSPLINE), blends layers, evaluates the authored AnimationGraph state machine, and computes joint palettes for GPU skinning in the vertex shader. Root motion and animation events are exposed to scripts.
- **Verification:** Verified for native. AnimationInput and sample() produce only normalized time (render_world.rs:224-263), which is used as an x offset (gpu.rs:1022-1026). world_animation_input hard-codes duration_ticks 1 and also rounds speed to an integer, so 0.5x plays at 1x and negative speeds turn positive (main.rs:2749-2758). The editor runtime already has skinned playback and a graph runtime (components/AnimationGraph/hooks/useGraphRuntime.ts, useAnimationMixer.ts). This is a blocker only if native ships games.
- **Depends on:** NATI-02, NATI-12, NATI-14

#### NATI-09 — No transform hierarchy / scene graph

- **Severity:** major (auditor: blocker; verifier: partial) · **Kind:** missing · **Complexity:** M · **Roadmap:** Phase 2
- **Evidence:** Entity (world.rs:91-111) has no parent field and is #[serde(deny_unknown_fields)]. The host's native field allowlist for objects contains no parentId (Auvra/desktop/project_host.py:262). grep -i 'parent|children|hierarch' in native/src hits only glTF node validation (assets.rs:1277-1290) and trace span ids (main.rs:37-223).
- **Done looks like:** Entities carry parent references with local transforms. World transforms propagate in hierarchy order each frame (dirty-flag), with socket/attachment support for bones. Reparent commands are validated for cycles, and glTF node hierarchies instantiate as entity trees.
- **Verification:** Verified. Entity has no parent (world.rs:91-111). The native 'parent' grep hits are glTF children (assets.rs:1277-1290), trace spans, and a viewport parentHandle that is validated and then ignored (main.rs:1873-1876). The authored data has no general hierarchy either: only attachments and sockets carry parentModelId (types.ts:24, 44). The native field allowlist also omits the attachments and sockets domains (project_host.py:257-265), so even weapon attachments never reach native. It is downgraded because it is conditional on the native route and small games can ship with flat scenes plus attachments.
- **Depends on:** NATI-12

#### NATI-10 — No extensible entity/component model

- **Severity:** major (auditor: blocker; verifier: partial) · **Kind:** missing · **Complexity:** L · **Roadmap:** Phase 2
- **Evidence:** Entity is a fixed struct with optional render/light/animation blocks and deny_unknown_fields (world.rs:91-111). The world has only four commands (world.rs:115-140). Every mutation clones the whole entity map (world.rs:448) and every mutation and tick re-serializes the whole world to JSON for an FNV hash (world.rs:1011-1024). Entity caps are 16,384 in the world (world.rs:14) but 4,096 for render (render_world.rs:12); beyond 4,096 visible entities extraction fails outright (render_world.rs:803-805).
- **Done looks like:** An ECS (e.g. bevy_ecs/hecs or a typed component registry) supports serializable components (transform, mesh renderer, camera, light, collider, rigidbody, audio source, script, animator, UI) with queries and a system schedule. Prefab/blueprint instantiation is supported, and determinism hashing is incremental or opt-in.
- **Verification:** The fixed struct with deny_unknown_fields (world.rs:91-111), the four commands (world.rs:115-140), the full clone per mutation (world.rs:448) and the JSON hash (world.rs:1011-1024) are all verified. One correction: the 4,096 cap (render_world.rs:803-805) is checked against all renderable input entities before culling, not 'visible' ones. With the viewport open, exceeding it kills the native process (see the missed gap). Severity depends on choosing native as the player runtime.

#### NATI-11 — No native game loop: the world is never ticked in editor or play mode, and simulation is velocity-only

- **Severity:** major (auditor: blocker; verifier: partial) · **Kind:** missing · **Complexity:** L · **Roadmap:** Native route
- **Evidence:** grep 'world.advance' over Auvra/ and the frontend host/components/hooks returns only the method allowlist (Auvra/desktop/native_engine.py:63); callers exist only in self-tests (main.rs:3202-3207) and unit tests. The simulation is position += velocity (world.rs:703-723). Play mode runs in TypeScript (fbx-viewer (1)/components/Environment/LevelGameLoop.tsx, components/Sandbox/hooks/useSandboxGame.ts), and grep nativeEngine over components/hooks/context finds nothing. The viewport is pumped from a 16 ms recv_timeout inside the IPC loop (main.rs:3023-3034).
- **Done looks like:** A native-owned main loop does fixed-timestep update, variable render and interpolation, with ordered systems (input, scripts, physics, animation, audio, transform propagation, render extraction). The editor can start, pause, step and stop play mode against the native world, with state snapshot and restore on stop.
- **Verification:** Verified. A grep for 'world.advance|advance_world' finds callers only in the self-test (main.rs:3205), unit tests, and allowlists (Auvra/desktop/native_engine.py:63, tests/diagnostics/test_program_trace.py:214). The simulation is velocity integration only (world.rs:703-723). Play mode does exist, in TS (components/Environment/LevelGameLoop.tsx, components/Sandbox/hooks/useSandboxGame.ts), so the engine has a game loop, just not a native one. This is a blocker only if native ships games.
- **Depends on:** NATI-10

#### NATI-12 — No scripting / Blueprint execution in native

- **Severity:** major (auditor: blocker; verifier: partial) · **Kind:** missing · **Complexity:** XL · **Roadmap:** Native route
- **Evidence:** grep -iw 'scripting|wasm|lua|rhai' over native/src gives no hits, and Cargo.toml has 5 deps with no VM. The host deliberately keeps graph/blueprint documents out of native ('Large HUD/graph/terrain/provider documents remain solely in the project repository', Auvra/desktop/project_host.py:245-248). Blueprint logic runs only in the TS editor.
- **Done looks like:** An embedded runtime (WASM, Lua or a compiled Blueprint bytecode VM) gets an API to entities/components, input, physics queries, audio, UI and scene loading. Authored Blueprints/LevelBlueprints compile to it, behave identically in editor play mode and the shipped player, and support hot reload.
- **Verification:** Verified that native has no VM. A grep for 'scripting|wasm|lua|rhai' finds only false positives from 'description', and blueprints/graphs/hud are excluded from the native allowlist (project_host.py:245-265). Level Blueprints do execute in the TS runtime (hooks/useLevelBlueprintRuntime.ts, LevelGameLoop.tsx). This is XL and a blocker only on the native-player route.
- **Depends on:** NATI-10, NATI-11

#### NATI-14 — No audio

- **Severity:** major (auditor: blocker; verifier: partial) · **Kind:** missing · **Complexity:** M · **Roadmap:** Native route
- **Evidence:** grep -iw 'audio|sound' over native/src gives no hits; there is no audio crate. Audio exists only in the editor (fbx-viewer (1)/components/Environment/AudioSystem.tsx).
- **Done looks like:** An audio engine (kira/rodio/cpal) provides 3D spatialized sources attached to entities, buses/mixer with volume, streamed music, cooked audio assets (OGG/WAV), and script control.
- **Verification:** Verified: 0 'audio|sound' hits in native/src. Audio, including positional audio, exists in the TS runtime (components/Environment/AudioSystem.tsx, components/Sandbox/PlayerController.tsx, usePlayerCombat.ts). This is a blocker only if native is the shipped runtime.
- **Depends on:** NATI-10

#### NATI-15 — No input handling

- **Severity:** major (auditor: blocker; verifier: partial) · **Kind:** missing · **Complexity:** M · **Roadmap:** Native route
- **Evidence:** ViewportApp::window_event handles only CloseRequested, Resized and RedrawRequested, and everything else hits '_ => {}' (main.rs:634-648). grep 'KeyboardInput|MouseInput|CursorMoved|gamepad|gilrs|DeviceEvent|MouseWheel' over native/src gives no hits.
- **Done looks like:** Keyboard, mouse (including relative/locked cursor) and gamepad (gilrs) input feed an action/axis mapping loaded from authored input settings, exposed to scripts. The native viewport supports editor camera navigation.
- **Verification:** Verified. window_event handles only CloseRequested, Resized and RedrawRequested (main.rs:634-648), and there are 0 hits for KeyboardInput/MouseInput/CursorMoved/gilrs. Gameplay input exists in TS (components/Sandbox/hooks/usePlayerControls.ts, LevelGameLoop.tsx, AnimationGraph/hooks/useInputHandler.ts). This is a blocker only on the native route, although it also makes the native viewport non-navigable (NATI-21).

#### NATI-16 — No in-runtime UI/HUD or text rendering

- **Severity:** major (auditor: blocker; verifier: partial) · **Kind:** missing · **Complexity:** L · **Roadmap:** Native route
- **Evidence:** grep -iw 'font|glyph|ui|hud' over native/src gives no hits. HUDs are React components evaluated with @babel/standalone in the editor, and HUD documents are excluded from native hydration (project_host.py:245-248, 255-263).
- **Done looks like:** A native UI layer (e.g. a retained-mode UI with SDF/atlas text, images, anchors/layout, buttons, focus/gamepad navigation) consumes a cooked HUD format exported from the HUD editor, with script bindings. Menus, health bars and dialogue render in the shipped player.
- **Verification:** Verified: 0 font/glyph/ui/hud hits in native/src, and HUD documents are excluded from native (project_host.py:245-265). A HUD runtime exists in TS (components/HUDEditor/DynamicHUDComponent.tsx, evaluated with @babel/standalone). This is a blocker only on the native route.
- **Depends on:** NATI-12, NATI-15

#### NATI-17 — Terrain, sky, fog and particles not supported by native

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** missing · **Complexity:** L · **Roadmap:** Native route
- **Evidence:** The host excludes terrain documents from native (project_host.py:245-248). The environment fields skyConfig and fog are sent (project_host.py:259) but apply_render_settings reads only camera, ibl, postEffects, msaaSamples, fxaa and lights (main.rs:2573-2648).
- **Done looks like:** Heightmap terrain with splat materials and LOD, a skybox or procedural sky, distance/height fog, and a GPU or CPU particle system are rendered natively from the same authored Environment data the editor uses.
- **Verification:** Verified. A grep for 'skyConfig|fog|terrain|particle|skybox' over native/src returns 0 hits, even though skyConfig and fog are sent in the environment allowlist (project_host.py:260). Terrain, sky and fog exist in the TS runtime (components/Environment/Terrain/TerrainSculptor.tsx, EnvironmentScene.tsx). Major is correct and conditional on the native route.
- **Depends on:** NATI-05, NATI-07

#### NATI-18 — Cooker produces no runtime format; no pak/bundle, streaming or residency management

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** missing · **Complexity:** L · **Roadmap:** Phase 1
- **Evidence:** A cook is the 'AUVRA-COOKED/1' magic + canonical JSON + raw BIN copy (assets.rs:981-1026); the module doc calls it 'an Auvra-owned deterministic envelope' (assets.rs:20-21). There is no mesh optimization, quantization, LOD generation, bundle format or async loading. The glTF validator does not check extensionsRequired (grep 'extensionsRequired|KHR_|draco|meshopt' in assets.rs gives no hits), so Draco/meshopt files pass validation but could never be decoded.
- **Done looks like:** The cooker emits a GPU-ready binary mesh format (interleaved/quantized vertices, optimized indices, generated LODs, bounds) and packs all project assets into a versioned pak with a table of contents. The runtime loads asynchronously on worker threads under a memory budget, with level streaming and unloading. Unsupported required glTF extensions are rejected or decoded.
- **Verification:** Verified. The envelope magic is 'AUVRA-COOKED/1' (assets.rs:49), the module doc says the output is 'an Auvra-owned deterministic envelope' (assets.rs:20-21), and write_artifact_file is at assets.rs:981-1026. A grep for 'extensionsRequired|KHR_|draco|meshopt' in assets.rs returns 0 hits. Nothing consumes the cooked output (NATI-02).
- **Depends on:** NATI-02, NATI-07

#### NATI-19 — Asset import breadth: real FBX unusable, no OBJ, glTF only validated

- **Severity:** major (auditor: major; verifier: partial) · **Kind:** stub · **Complexity:** M · **Roadmap:** Phase 2
- **Evidence:** parse_fbx rejects any line except Vertices/PolygonVertexIndex arrays (assets.rs:1490-1506) and all binary FBX (assets.rs:1482-1488), which covers practically every DCC export. The editor imports FBX via Three.js in the browser, so native and editor diverge.
- **Done looks like:** Binary and ASCII FBX import with meshes, normals, UVs, materials, skeletons and animations (e.g. via ufbx bindings or convert-to-glTF on import), plus OBJ. Imported results are identical between the editor preview and the native cook.
- **Verification:** The native FBX path is as described. It requires UTF-8 text starting with '; FBX 7.' and rejects any line other than Vertices/PolygonVertexIndex/a:/braces (assets.rs:1482-1506), so practically every real FBX fails. Effort is overstated, though. The editor already converts FBX to GLB, including animations, in a worker using GLTFExporter (workers/fbxImport.worker.ts:124-134, consumed at utils/modelLoader.ts:117). Persisting that GLB as a derived project asset would feed the existing native glTF path, which makes this roughly S. It matters only on the native route.
- **Depends on:** NATI-18

#### NATI-23 — Test suite cannot detect rendering errors; small overall coverage for a runtime

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** debt · **Complexity:** M · **Roadmap:** Phase 4
- **Evidence:** There are 44 #[test] functions in total, and gpu.rs has only 2 (capability bits and an FXAA flag, gpu.rs:1491-1505). The headless self-test checks that the render signature equals itself (main.rs:3231-3246). release/cross_backend.py:115-117 compares signatures across runs, not against reference images. As a result the stride bug (NATI-03) and the screen-space shadows passed CI.
- **Done looks like:** Golden-image tests per reference scene run with a tolerance metric on the software (lavapipe/WARP) and hardware adapters. There are loader round-trip tests on real glTF/FBX samples (Khronos sample models), plus play-mode integration tests for scripts, physics and audio in headless mode.
- **Verification:** Verified: 44 #[test] in total (assets 11, gpu 2, main 12, render_world 8, world 11). The headless self-test compares the render signature only with a second render (main.rs:3226-3241), and nativeReference.ts only requires signatures.size === 1. One detail is wrong: release/cross_backend.py:105-124 compares WebGL2 against native signatures for equality, not runs against each other. It is only exercised by tests/release/test_release_pipeline.py:403-437 with fabricated values and is never run against real renders in .github/workflows/verify.yml. The conclusion stands: there is no golden-image check, which is how the NATI-03 stride bug and the screen-space shadows passed CI.
- **Depends on:** NATI-03

#### NAT-M2 — Every project edit forces two full-project native transfers, and native limits cap editable project size

- **Severity:** major (found by verifier) · **Kind:** debt · **Complexity:** M · **Roadmap:** Phase 2
- **Evidence:** Each project.applyChanges first sends the full candidate project (all domains) through _validate_native_candidate (project_host.py:659, 386-397). It then fully rehydrates (project_host.py:671 calling _hydrate_native at 327-345, paged at 48KB in native_engine.py:986-1031), which rebuilds the world and resets replay (world.rs:375). This happens even for domains native ignores: graph and HUD edits go through applyChanges (hooks/useGraphManager.ts:22, utils/db.ts:164). Native caps total hydration documents at 16,384 across all domains (main.rs:1391, 1420, 1978) and world entities at 16,384 (world.rs:14), with no matching project-side limit (no hits for '16_?384' in Auvra/project). A native hydration failure closes the whole project session (project_host.py:347-357, 359-382), so native limits and strictness gate editing even though native is not the editor renderer.
- **Done looks like:** Edits to object, material and light documents become incremental world.applyCommands transactions (the method already exists at main.rs:1074-1076). Edits to domains native does not consume do not touch native at all. A native validation or hydration failure degrades the native view with a diagnostic instead of closing the project. Native and project limits are aligned and documented. Edit latency stays flat as project size grows.

#### NAT-M3 — Native has no level/scene concept: all levels are flattened into one world

- **Severity:** major (found by verifier) · **Kind:** missing · **Complexity:** M · **Roadmap:** Native route
- **Evidence:** project_candidate turns every object from every level into a world entity, and levelId is only checked for existence (main.rs:2016-2075, 2036-2042). project_render_state merges camera, lights and post effects from all worlds/scenes/levels/environment documents into one ProjectRenderState (main.rs:2288-2300, apply_render_settings at 2573-2586): the camera is last-wins and lights are unioned. Neither the world commands (world.rs:115-140) nor the IPC methods (main.rs:1069-1129) include a level load, unload or switch.
- **Done looks like:** The native world is scoped to an active level or scene. It has load, unload and switch commands with per-level environment, camera and lighting, a persistent global entity set across level changes, a script API to change levels, and later async streaming (overlaps NATI-18).
- **Depends on:** NATI-10, NAT-M1

#### NATI-03 — Vertex stride mismatch corrupts all scene and gizmo geometry

- **Severity:** minor (auditor: major; verifier: partial) · **Kind:** broken · **Complexity:** S · **Roadmap:** Phase 0
- **Evidence:** gpu.rs:952-963 writes 10 f32 per vertex (pos3, color4, metallic, roughness, 0.0) and gizmo_vertices writes 10 (gpu.rs:980-991). vertex_state declares array_stride 36 (9 floats) with attributes at 0/12/28 (gpu.rs:1231-1249). Draw counts use vertices.len()/9 (gpu.rs:717, 737, 766, 823). From the second vertex onward, positions are read from shifted floats. Undetected because main.rs:3231-3246 only checks a hash against itself.
- **Done looks like:** A single vertex struct is shared by the CPU packer and the pipeline layout (e.g. bytemuck Pod plus a size_of-derived stride), with draw counts derived from the vertex count. A golden-image test renders the reference scene and checks per-pixel tolerance against a stored image.
- **Verification:** The bug is confirmed. scene_vertices and gizmo_vertices push 10 f32 per vertex (gpu.rs:950-962, 978-990), but vertex_state and depth_pipeline declare array_stride 36 (gpu.rs:1231, 1263), and the draws use len/9 (gpu.rs:717, 737, 766, 823). The empty-buffer fallbacks still write 9 floats (gpu.rs:966, 995), which shows the 10th float was added later. It is downgraded because the whole scene-geometry path is a placeholder that NATI-02 replaces. It is an S fix with no effect on shipping a game, but it is useful evidence for NATI-23.

#### NATI-20 — README/REFACTOR Stage 8 'Complete' renderer claims and hard-coded capabilities misstate reality

- **Severity:** minor (auditor: major; verifier: partial) · **Kind:** claim-mismatch · **Complexity:** S · **Roadmap:** Phase 0
- **Evidence:** README.md:130-135 lists 'metallic-roughness PBR, animation, culling and deterministic LOD, batching, directional/point/spot lights, shadows, image-based lighting, integer picking, editor gizmos, HDR/ACES output, anti-aliasing, and a bounded post-processing chain' with per-adapter fallback reporting, and REFACTOR.md:25 marks Stage 8 Complete. In code, gpu.rs:232-234 returns all 16 features supported on every adapter, and PBR, shadows, IBL, animation, picking and gizmos are placeholders (see NATI-02/05/06/08/21). findings.md F-044 and F-045 are marked Completed despite the projected-triangle geometry remaining.
- **Done looks like:** Docs describe the native renderer as a pass-structure scaffold until the features render real content. Capability bits are derived from actual implemented and validated features, and per-adapter limits come from wgpu feature/limit queries. Stage gates require golden-image evidence, not hash self-consistency.
- **Verification:** The claim mismatch holds for PBR, shadows, IBL, animation, picking and gizmos, but the evidence overreaches. F-045 (MSAA) really is implemented: there are sample-count pipeline variants (gpu.rs:286-345) and an msaa-resolve pass (gpu.rs:825-843). The capability bits are constant (gpu.rs:232-234), but validate_adapter (gpu.rs:236-271) refuses renderer init when the required formats are missing. That makes support all-or-nothing, not falsely advertised on unsupported adapters, although the README.md:134-135 per-adapter fallback reporting is never exercised. README.md:135-137 also hedges that WebGL2 remains the default. The double tone-map and gamma encoding (gpu.rs:1396-1399) undercut the 'HDR/ACES output' claim. This is docs and status accuracy, S effort, and not a shipping blocker.

#### NATI-21 — Native viewport unusable as an editor viewport: picking never read back, placeholder gizmos, undocked separate window

- **Severity:** minor (auditor: major; verifier: partial) · **Kind:** stub · **Complexity:** L · **Roadmap:** Native route
- **Evidence:** The pick texture has RENDER_ATTACHMENT usage only (gpu.rs:628-636) and there is no pick query method (main.rs:1069-1134). Gizmos are an orange triangle (gpu.rs:972-999). The viewport is a separate OS window with dockSupport 'unsupported' (main.rs:495, 1869), and the editor shows a placeholder panel (fbx-viewer (1)/renderer/AuvraCanvas.tsx:106-113). Without input (NATI-15) the window cannot be navigated.
- **Done looks like:** The native viewport is embedded or composited into the editor frame. Pick readback is exposed via an IPC method (async, by pixel). Translate/rotate/scale gizmos with interaction are drawn. The editor can use native as the 'what you ship' view, at parity with the WebGL2 viewport.
- **Verification:** Verified. There is no pick readback or IPC method (main.rs:1069-1129). The pick texture is RENDER_ATTACHMENT only (gpu.rs:628-636). Python sends parentHandle (Auvra/desktop/native_engine.py:1317-1322), but native validates and ignores it (main.rs:1873-1876) and reports dockSupport 'unsupported' (main.rs:1909). The auditor missed that picking is also broken in the pass itself: the per-frame pick depth texture (gpu.rs:636-644) is loaded rather than cleared in the picking pass, so with wgpu zero-init and LessEqual (gpu.rs:1328-1332) only fragments at depth 0 are written. Severity is minor because the native viewport is opt-in (?renderer=native, and only for 'editor-scene-viewer' per AuvraCanvas.tsx:149-151). Authoring runs on the WebGL2 viewport, so this blocks neither editing nor shipping.
- **Depends on:** NATI-04, NATI-15

#### NATI-22 — Per-frame allocation and full-world serialization hot paths

- **Severity:** minor (auditor: major; verifier: partial) · **Kind:** debt · **Complexity:** M · **Roadmap:** Phase 2
- **Evidence:** Every frame re-creates the HDR, depth, 1024^2 shadow, pick and pick-depth textures, the samplers and the bind groups (gpu.rs:545-690). Each extraction clones the full world snapshot (main.rs:1750) and JSON-serializes the whole snapshot to hash it (render_world.rs:665, 985-988), and each tick re-serializes the world (world.rs:1021-1024). The GPU timing read blocks with wait_indefinitely every frame (gpu.rs:69-77, main.rs:497-500). Batch building is O(keys × entities) (render_world.rs:559-581). Each advance spawns fresh OS threads (world.rs:573-586).
- **Done looks like:** Render targets are persistent and resized only on resize, with cached bind groups and pooled transient buffers. Change-tracked extraction does not serialize per frame. Determinism hashing is moved to debug/replay mode, GPU timing readback is asynchronous and N frames delayed, batching uses a hash map, and a persistent job pool replaces per-call threads. A 10k-entity scene holds 60 fps on mid-range hardware.
- **Verification:** All items are verified: per-frame textures, samplers and bind groups (gpu.rs:545-690); the snapshot clone plus JSON canonical_hash per extraction (main.rs:1750, render_world.rs:665, 985-988); the per-tick world JSON hash (world.rs:1011-1024); the blocking wait_indefinitely timing read every viewport frame (gpu.rs:69-77 via present_production at gpu.rs:487-490); O(keys×entities) batching (render_world.rs:559-581); and per-call scoped threads (world.rs:573-586). They are mostly S fixes, and the renderer parts are subsumed by the NATI-02/05/10 rewrites. None matters for shipping at the current placeholder stage.
- **Depends on:** NATI-10

#### NATI-24 — Native hydration failure closes the project even though the editor renders with WebGL2

- **Severity:** minor (auditor: minor; unverified (minor, not sent to verifier)) · **Kind:** debt · **Complexity:** S · **Roadmap:** Phase 0
- **Evidence:** Auvra/desktop/project_host.py:346-358: any native hydration exception invalidates the session and raises recovery_required. _hydrate_native runs on create, open, apply and import (project_host.py:97, 546, 563, 578, 673, 698, 719, 745). Native validation is strict, e.g. an object must reference an existing level (main.rs:2036-2042). A native-only defect therefore blocks editing projects whose authoritative renderer is WebGL2.
- **Done looks like:** While native is not the authoritative runtime, a hydration failure degrades the native view (status plus diagnostics) without closing the project. Alternatively, the project schema and the native validators are proven equivalent by shared conformance fixtures.

#### NATI-25 — Shipping platform is Windows-only; no player packaging for any platform

- **Severity:** minor (auditor: minor; verifier: confirmed) · **Kind:** missing · **Complexity:** M · **Roadmap:** Phase 1
- **Evidence:** CI builds and tests native on windows-latest and ubuntu-latest (.github/workflows/verify.yml:105), but the only release artifact is a Windows x64 editor MSIX (README.md:154-156; release/pipeline.py:340 TargetDeviceFamily Windows.Desktop). There are no macOS, Linux player, Steam-depot or web targets. Platform cfgs exist only for reparse-point checks (assets.rs:820-829).
- **Done looks like:** Player builds for Windows x64 (portable zip/installer, no MSIX requirement) and Linux x64, with macOS optional. The export settings handle icon, name, version and fullscreen/resolution defaults.
- **Verification:** Verified. The CI matrix is [windows-latest, ubuntu-latest] (.github/workflows/verify.yml:105), but the only release artifact is an editor MSIX with TargetDeviceFamily Windows.Desktop (release/pipeline.py:340). Minor is appropriate, since a Windows-only first shipping target is acceptable for indie games.
- **Depends on:** NATI-01

#### NAT-M4 — Native process terminates when viewport extraction fails (render cap of 4,096 against a world cap of 16,384)

- **Severity:** minor (found by verifier) · **Kind:** broken · **Complexity:** S · **Roadmap:** Phase 0
- **Evidence:** validate_input rejects more than 4,096 render entities before any culling (render_world.rs:12, 803-805), while the world accepts 16,384 (world.rs:14). With the viewport open, run_ipc_live_loop calls pump_viewport(app)? (main.rs:3023-3025), which calls build_extraction(...)? (main.rs:2959). The error therefore propagates out of run_ipc (main.rs:2952), and main exits with code 1 'native.fatal' (main.rs:3341-3344). Any other extraction validation error has the same effect. It is minor only because the native viewport is opt-in.
- **Done looks like:** An over-budget or invalid extraction degrades per frame (cull or clip to budget, emit a diagnostic, keep the last good frame) and never ends the IPC loop. Render and world caps are aligned, or the render cap is applied after culling. A regression test with 4,097 objects and the viewport open passes.
- **Depends on:** NATI-10

### 7.2 Editor core and frontend rendering

*Audited:* Editor core + frontend rendering (fbx-viewer (1): App.tsx, components/{Scene,Environment,UI,Tools,Settings}, context/, renderer/, editor hooks, utils/, workers/, services/)

The editor is a React/R3F (WebGL2) app split into 7 mutually exclusive tabs (App.tsx:27,65-155). The level-building part is the "World Editor" (components/Environment). It can place props by clicking, paint instanced foliage, sculpt a single gray heightfield terrain, add one sky, add audio emitters and enemy spawners, and play the level through a hardcoded shooter loop (LevelGameLoop). Its project, session-lease and renderer-lifecycle plumbing is solid and well hardened (most of findings.md F-001..F-080 is closed). The editing features themselves are prototype quality. Props and foliage cannot be moved after placement: the gizmo only targets spawner/audio/sky objects (EnvironmentScene.tsx:367) and the inspector has no transform fields. Import is FBX-only, and every model is force-normalized to 5 m. There are no lights beyond one sun, no materials, no prefabs, no hierarchy and no multi-select. Undo only covers the level-object array. Terrain heights are persisted as one JSON array that runs into the 256 KiB host message limit. Play mode can permanently delete authored objects from the project (via DestroyActor). Architecturally there are two diverging renderers with no shared runtime. All authoring and play happen in WebGL2. The native wgpu renderer is a separate view-only window, limited to the asset-viewer surface. It cannot ingest the editor's binary FBX assets, drops the editor's object types, and may reject editor-authored non-mesh objects (spawner/audio/sky/terrain, which have an empty modelId); this is static analysis and was not run. The editor also never authors the lights, materials, LOD or post settings that native supports. Neither renderer produces a standalone player build. Test coverage is token-level: 7 frontend tests, and strict TypeScript checks cover only 5 source files.

**What exists:**

- **[solid]** Project lifecycle UI (New/Open/Save/Save As/.auvrapack import-export/recent/recovery/close) through the Python host — components/UI/Header.tsx:87-158; hooks/useProjectManager.ts:59-224 (transition-scoped operations, editor-state document persisted before Save)
- **[solid]** Editor session leases fencing stale async writes across project/level switches — utils/editorSession.ts; hooks/useLevelManager.ts:46-113,236-258,362-407 (lease checks on every DB op, atomic level switch)
- **[solid]** Renderer surface lifecycle: context-loss recovery, per-surface metrics, ACES/sRGB policy — renderer/AuvraCanvas.tsx:17-92,122-168; renderer/registry.ts; tests/frontend/rendererRecovery.test.ts
- **[basic]** FBX import in a Web Worker (FBXLoader->GLTFExporter->GLTFLoader) with progress, cancellation, Phong->Standard material upgrade, thumbnails — utils/modelLoader.ts:42-150; workers/fbxImport.worker.ts:119; utils/processing/ModelMaterials.ts:7-40; hooks/useModelManager.ts:70. FBX only, forced 5 m normalization (utils/processing/ModelTransforms.ts:5,33-35)
- **[basic]** Level management (create/load/delete levels, per-level objects and level blueprint) — hooks/useLevelManager.ts:341-429; components/Environment/EnvironmentSidebar.tsx:41-47 uses window.prompt for naming
- **[basic]** Click-to-place props with ghost preview, grid snap and R-to-rotate — components/Environment/EnvironmentScene.tsx InteractionLayer (raycasts a y=0 plane, line 90); EnvironmentViewport.tsx:92-96
- **[broken]** Transform gizmo (translate/rotate/scale, world/local, grid and angle snapping) — EnvironmentScene.tsx:358-373 sets the gizmo target only for spawner/audio/sky refs ('For this demo, we only support transforming Spawners/Unique objects' line 367); props, foliage and terrain get no gizmo
- **[basic]** Undo/redo (Ctrl+Z/Ctrl+Y) for World Editor objects — hooks/useLevelManager.ts:131-201 (whole-array JSON snapshots, max 50, cleared on level switch); only snapshotted on gizmo drag, paint stroke, add and remove
- **[basic]** Outliner (flat list with search, select, delete) — components/Environment/EnvironmentSidebar.tsx:298-360; no tree, rename-in-place, visibility or lock; the 'Focus' button only re-selects (338-344)
- **[basic]** Inspector for name, sky, audio and spawner settings — components/Environment/layout/EnvironmentInspector.tsx:300-540; grep 'position' in that file returns 0 hits (no transform editing)
- **[basic]** Instanced rendering of props and foliage grouped by model — components/Environment/InstancedLevelLayer.tsx:22-200 (InstancedMesh per mesh part; recreated when count changes, line 130; no selection highlight)
- **[basic]** Foliage paint and erase brush — components/Environment/FoliageBrushTool.tsx:38 (infinite y=0 plane), 53-119 (per-frame per-instance onPaint), 99 'Assuming flat plane for now'
- **[basic]** Terrain create and sculpt (raise/lower/flatten/smooth), one per level — components/Environment/Terrain/TerrainObject.tsx:45-52 (fixed gray flat-shaded material), 111-121 (whole heights array committed per stroke); EnvironmentInspector.tsx:39-57 (single terrain)
- **[basic]** Sky atmosphere with time of day, sun, fog and procedural IBL — components/Environment/SkySystem.tsx:27-107; components/Scene/LocalEnvironment.tsx (Lightformer cube map)
- **[basic]** Audio emitters with spatial settings and a waveform loop-region editor — EnvironmentInspector.tsx:426-525; components/Environment/assets/WaveformEditor.tsx
- **[basic]** Quad orthographic views (left/right/top/bottom) — components/Environment/EnvironmentViewport.tsx:212-268 (no front/back views; orbit camera only)
- **[basic]** Content browser (category filter, search, delete, import) — components/UI/Browser/ContentBrowser.tsx:36-118; BrowserToolbar.tsx:121 accept='.fbx'/'image/*'/'audio/*'
- **[basic]** Texture retexture, mask tool and AI texture generation via providers — components/Tools/RetextureEditor.tsx; components/Environment/EnvironmentMaskTool.tsx:176 retextureModel; hooks/useTextureGeneration.ts
- **[basic]** Play-in-editor ('PLAY LEVEL') — components/Environment/LevelGameLoop.tsx:94-400: hardcoded shooter (blood, projectiles, enemy spawners), Bloom/Vignette only here (282-286); mutates authored data (see gaps)
- **[stub]** Native wgpu viewport bridge from the editor — renderer/AuvraCanvas.tsx:94-119 renders only a status card; 159-161 nativeEligible only for surfaceId 'editor-scene-viewer' with ?renderer=native; native IPC exposes no pick or gizmo method (method list in native/src/main.rs: viewport.open/close, renderer.extract ...)
- **[stub]** Backend-neutral render graph, resource contracts and capability tiers — renderer/renderGraph.ts, contracts.ts, capabilities.ts, conventions.ts are imported only by scripts/diagnostics/verify.mjs and scripts/renderer/verify.mjs, never by runtime code
- **[stub]** Frontend unit/component tests — tests/frontend/*.test.ts(x): 5 files, 7 tests, ~94 LOC; tsconfig.strict.json includes only 5 source files

#### EDIT-01 — Two diverging renderers and no single shippable runtime

- **Severity:** blocker (auditor: blocker; verifier: confirmed) · **Kind:** claim-mismatch · **Complexity:** XL · **Roadmap:** Phase 1
- **Evidence:** WebGL2/R3F renders all authoring and play (EnvironmentViewport.tsx:188-194, LevelGameLoop.tsx:4,255). Native is a separate, view-only window, eligible only for the asset viewer (AuvraCanvas.tsx:159-161), with no pick or gizmo IPC. The host forwards only generic object fields to native (Auvra/desktop/project_host.py:256-266). That drops `type`, terrain, sky, foliage, audio and spawn data, and it never sends model normalization (editor-side sizes come from ModelTransforms.ts:33-35). So the same object renders at different sizes in the two renderers. Native builds entities for every object in every level, with no active-level filter (native/src/main.rs:2023-2072). The editor never writes the lights/materials/LOD/IBL/postEffects that F-044 and the README say native supports; grep of components/hooks/utils finds only material texture-ref cleanup (utils/db.ts:503-505). Gameplay is React components bound to editor context (LevelGameLoop.tsx:95 useScene). Vite builds only the 'editor' and 'hud' entries (vite.config.ts:64-67); there is no player target.
- **Done looks like:** A written decision on one runtime (for example the native runtime is the shipping player, and the editor viewport docks or streams it, or else a web player build), with one scene/entity format both editor and player consume losslessly. The editor viewport and PIE run that same runtime, including picking and gizmos over IPC. A 'Build Game' path produces a standalone player from a project. Divergent code paths are deleted, or kept as an explicitly secondary preview.
- **Verification:** Verified. Native is only eligible for one surface: AuvraCanvas.tsx:159 has `nativeEligible = surfaceId === "editor-scene-viewer"`. World Editor (surfaceId editor-environment-viewport, EnvironmentViewport.tsx:188) and PIE (runtime-level-game-loop, LevelGameLoop.tsx:252) always use WebGL. The native IPC surface (main.rs:1070-1125) has world.*, renderer.*, asset.* and viewport.open/close, with no pick or gizmo methods. The host whitelists object fields without `type`, terrainData, skyConfig, spawnConfig or audioConfig (project_host.py:257-266). project_candidate (main.rs:2023-2072) builds entities for every object with no level filter. The only Vite entries are editor and hud (vite.config.ts:64-67). Native main() supports only IPC and self-test modes (main.rs:3334-3340), so there is no standalone player mode. release/ packages only the editor. Correction: dependsOn EDIT-07 (prefabs) is wrong; this should depend on EDIT-04 (entity schema) and the cook step in EDIT-03.
- **Depends on:** EDIT-07

#### EDIT-02 — Placed props, foliage and terrain cannot be moved, rotated or scaled after placement

- **Severity:** blocker (auditor: blocker; verifier: confirmed) · **Kind:** broken · **Complexity:** M · **Roadmap:** Phase 2
- **Evidence:** EnvironmentScene.tsx:358-373 sets the TransformControls target only from spawnerRefs, which hold spawn_point/audio_emitter/sky_sphere objects; comment at line 367: 'For this demo, we only support transforming Spawners/Unique objects'. Props and foliage render through InstancedLevelLayer with no ref (lines 445-457). grep 'position' in components/Environment/layout/EnvironmentInspector.tsx returns 0 hits. TransformInputGroup exists (components/UI/Properties/TransformInputGroup.tsx) but is used only by Attachment, Socket and Blueprint panels. Selected props get no highlight because InstancedLevelLayer receives no selectedId.
- **Done looks like:** Every level object type can be selected with a visible highlight and edited by gizmo (using a proxy Object3D for instanced items) and by numeric position/rotation/scale fields in the inspector. Every edit is undoable and persisted, covered by component tests.
- **Verification:** Verified. EnvironmentScene.tsx:357-372 sets a gizmo target only from spawnerRefs, which register only spawn_point, audio_emitter and sky_sphere (lines 349, 459-468). Terrain is also excluded, so terrain cannot be moved either. grep position|rotation|scale|TransformInput in EnvironmentInspector.tsx returns 0 hits. InstancedLevelLayer has no selectedId prop and only a hover highlight (InstancedLevelLayer.tsx:144-160). Props are always placed at scale [1,1,1] (EnvironmentViewport.tsx:95). Combined with the 5 m normalization this makes correct level scale impossible to author.

#### EDIT-03 — Import pipeline is FBX-only, forces 5 m normalization, has no import options or reimport, and does not match the native cooker

- **Severity:** blocker (auditor: blocker; verifier: partial) · **Kind:** missing · **Complexity:** L · **Roadmap:** Phase 2
- **Evidence:** File inputs accept only '.fbx' for models (components/UI/Browser/BrowserToolbar.tsx:121, Properties/AnimationControls.tsx:125, Properties/AttachmentPanel.tsx:81). GLTFLoader is used only to parse the worker's FBX->GLB conversion (utils/modelLoader.ts:117). Every non-animation model is scaled so its largest axis is 5 m (utils/processing/ModelTransforms.ts:5,33-35; hooks/useModelManager.ts:51). A duplicate filename is blocked with alert() (useModelManager.ts:30-33). grep -i reimport returns no hits, and deleting a model cascades removal of all its placements (useLevelManager.ts:29-31). Every project open re-parses every FBX sequentially in the browser (useScenePersistence.ts:305-330). The native cooker accepts glTF/GLB plus only an ASCII FBX 7.x geometry subset ('Binary FBX ... unsupported and fail closed', native/src/assets.rs:17-21), so typical binary FBX from Blender or Mixamo never renders natively.
- **Done looks like:** glTF/GLB (primary) plus FBX and OBJ import, with an import-settings dialog (unit scale, up axis, normalize off by default, material/animation/collision options). Reimport-in-place keeps the asset ID and all placements. One shared cook step produces the cached runtime format consumed by both the editor and the player, and project open loads cooked assets instead of re-parsing sources.
- **Verification:** Import exists and is robust in its reduced form: a cancellable worker FBX->GLB pipeline with progress (workers/fbxImport.worker.ts, modelLoader.ts:110-130), plus texture and audio import (BrowserToolbar.tsx:121). The 'missing' kind is therefore overstated. The blocker part is confirmed: forced 5 m normalization (ModelTransforms.ts:4,32-34; useModelManager.ts:52; useScenePersistence.ts:320) with no per-asset scale option, and props placed at scale 1 with no way to rescale (EDIT-02). The lack of glTF/OBJ import and reimport is major on its own. The duplicate-name alert is confirmed (useModelManager.ts:30-33). The native cooker mismatch is confirmed (assets.rs:17-21) but belongs to EDIT-01.
- **Depends on:** EDIT-01

#### EDIT-04 — No generic entity/component model, transform hierarchy, cameras or player start

- **Severity:** blocker (auditor: blocker; verifier: confirmed) · **Kind:** missing · **Complexity:** XL · **Roadmap:** Phase 2
- **Evidence:** LevelObject is a flat record with a closed 6-value type enum: 'prop'|'foliage'|'spawn_point'|'audio_emitter'|'terrain'|'sky_sphere' (types.ts:72,125-138). It has no parentId, children, components, tags, layers, visibility or lock (grep parentId|children:|reparent in types.ts, components/Environment and useLevelManager returns 0 hits). Blueprints are limited to 'Player Character'|'Enemy Controller' (types.ts:259). Only one sky and one terrain are allowed per level (EnvironmentSidebar.tsx:79-85; EnvironmentInspector.tsx:39-42). There are no camera, light, trigger/collider or player-start object types.
- **Done looks like:** A versioned entity schema with a parent/child transform hierarchy and an extensible component list (mesh, light, camera, collider/trigger, audio, script, spawn, player start). The outliner becomes a tree with drag-to-reparent, rename, visibility and lock. The inspector is generated per component. A migration converts existing LevelObject documents.
- **Verification:** Verified. types.ts:72 has the closed LevelObjectType enum, and LevelObject at types.ts:125-138 has no parent, components, tags or visibility. grep parentId|parent_id over types.ts, components/Environment, useLevelManager and schemas.py returns 0 hits, and native world.rs has no parent/children either. BlueprintType is limited to 2 values (types.ts:259). No camera, light, trigger or player-start type exists anywhere. The only 'trigger' is a proximity check by name (useLevelBlueprintRuntime.ts:339-361).

#### EDIT-12 — Native validation likely rejects editor-authored spawner, audio, sky and terrain objects (empty modelId)

- **Severity:** blocker (auditor: major; verifier: confirmed) · **Kind:** broken · **Complexity:** S · **Roadmap:** Phase 0
- **Evidence:** The editor creates non-mesh objects with modelId '' (EnvironmentSidebar.tsx:52-58,66-73,87-92; EnvironmentInspector.tsx:44-50). The host forwards modelId to native (project_host.py:265) and validates every change against native before applying it (project_host.py:384-397,659). Native treats any present modelId string as required (native/src/main.rs:2047-2050), giving 'object references a missing model'. The Python schema treats '' as optional (Auvra/project/schemas.py:136). grep for an empty modelId in tests/ and native/src returns 0 hits. This is static analysis (PLAUSIBLE), triggered whenever the native engine is READY.
- **Done looks like:** Native treats an empty or absent modelId as having no render component (or the host omits it) and receives the object `type`. A host and native regression test adds each non-mesh object type with native running.
- **Verification:** Verified the full path. The editor writes modelId '' (EnvironmentSidebar.tsx:52,67,88; EnvironmentInspector.tsx:45), and canonicalChange forwards it unchanged (db.ts:146-165). The host field filter keeps it (project_host.py:313-315). Native validation, commit and hydrate all use project_candidate (main.rs:1294,1478,1512), and its `if let Some(model_id) = value.get("modelId").and_then(Value::as_str)` treats Some("") as missing ('object references a missing model', main.rs:2047-2050). Native starts whenever native/target/release/auvra-native.exe exists or the app is packaged (launcher/cli.py:471,649,751-756). Severity goes up for two reasons. First, adding sky, terrain, spawner or audio is rejected while native is READY. Second, _hydrate_native on open (project_host.py:563,578) runs while native is READY. On failure it invalidates and closes the session with recovery_required (project_host.py:346-358), so a project authored while native was unavailable may become unopenable. The fix effort is S.

#### EDIT-05 — No placeable lights, broken shadow coverage, no GI or editor post-processing

- **Severity:** major (auditor: blocker; verifier: partial) · **Kind:** missing · **Complexity:** L · **Roadmap:** Phase 3
- **Evidence:** grep pointLight|spotLight|rectAreaLight|hemisphereLight|CSM|shadow-camera|Lightmap across the frontend matches only material map passthrough in utils/processing/ModelMaterials.ts:21-22. Lighting is one directional sun plus ambient from SkySystem.tsx:58-98. That sun has no shadow-camera bounds, so three.js defaults to a 10x10 m ortho shadow frustum around the origin while terrain defaults to 100 m (EnvironmentInspector.tsx:35). Post-processing is hardcoded Bloom/Vignette in PIE only (LevelGameLoop.tsx:282-286), and AA is disabled there (line 261).
- **Done looks like:** Directional, point and spot light entities with color, intensity, range and shadow toggles. Cascaded or fitted directional shadows covering the view. Per-level environment and post-process settings (exposure, bloom, AO, AA, fog) edited in the inspector and honored in the editor, PIE and the player. Optionally light probes or baked lighting for the chosen runtime.
- **Verification:** The missing pieces are confirmed: grep pointLight|spotLight|hemisphereLight|CascadedShadow|shadow-camera finds nothing in the editor (HemisphereLight appears only in renderer/referenceScenes.ts:42, a test scene). SkySystem.tsx:89-96 sets no shadow-camera bounds, so the default ±5 m frustum applies. However, the 'no GI' wording overstates it. A procedural Sky with time of day, fog and a local IBL environment map exist (SkySystem.tsx:76-104; Scene/LocalEnvironment.tsx:22-26), and PIE has Bloom/Vignette (LevelGameLoop.tsx:282-286). An outdoor game with one sun is shippable, so this is major rather than a blocker. The shadow-frustum fix is a one-liner.
- **Depends on:** EDIT-04, EDIT-01

#### EDIT-06 — No material system or material editor; terrain has no texture layers

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** missing · **Complexity:** L · **Roadmap:** Phase 3
- **Evidence:** The only material authoring is a per-model albedo override, textureOverrides: Record<MaterialName, textureId> (types.ts:69), driven by the retexture and mask tools (EnvironmentMaskTool.tsx:176). grep roughness|metalness|normalMap|NodeMaterial|materialId in components, hooks, context and utils finds only hardcoded literals (TerrainObject.tsx:47-48, BloodSystem.tsx:130). Terrain uses one fixed gray flat-shaded MeshStandardMaterial (TerrainObject.tsx:45-52), and terrainData.textureId is never read by TerrainObject.tsx (grep returns 0 hits). The native 'materials' domain exists (project_host.py:264) but the editor never writes it.
- **Done looks like:** A material asset type (PBR parameters plus texture slots, alpha mode, double-sided) with a preview sphere, assignable per mesh slot and per instance. Texture import settings (color space, normal map, compression). Terrain layer or splat painting. All of it rendered identically by the shipping runtime. A shader graph is optional.
- **Verification:** Verified. Terrain uses a fixed #555555 flat-shaded material (TerrainObject.tsx:44-51). grep textureId in the Terrain/*.tsx files returns 0 hits, even though schemas.py:139 validates terrainData.textureId. grep roughness|metalness|normalMap|materialId outside the material-copy helper finds only hardcoded literals. The editor never writes the native 'materials' domain (project_host.py:264). Imported FBX materials and textureOverrides are the only material path.
- **Depends on:** EDIT-04, EDIT-01

#### EDIT-07 — No prefabs or reusable instanced object templates

- **Severity:** major (auditor: major; verifier: partial) · **Kind:** missing · **Complexity:** L · **Roadmap:** Phase 2
- **Evidence:** grep -i prefab over *.ts, *.tsx, *.py, *.rs and *.md in the repo (excluding node_modules, .venv and native/target) returns 0 hits. The only reuse mechanism is placing the same model again; logic actors are created ad hoc (EnvironmentSidebar.tsx:49-109).
- **Done looks like:** Prefab assets built from entity hierarchies with components. Instances support per-property overrides, apply/revert, nested prefabs and update propagation on prefab edit, all persisted in the project schema.
- **Verification:** grep -i prefab returns 0 hits repo-wide, which is confirmed. However, Blueprints are a reduced form of actor template. A Blueprint bundles a model, stats, variables, an animation graph and a scale (types.ts:268-283), and spawn points instantiate it by ID (SpawnConfig.blueprintId, types.ts:74-79). That covers characters only, with no hierarchy, overrides or props. True prefabs depend on EDIT-04.
- **Depends on:** EDIT-04

#### EDIT-08 — Undo/redo covers only the level-object array, misses many edits, and can drop terrain work

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** missing · **Complexity:** L · **Roadmap:** Phase 2
- **Evidence:** History snapshots only levelObjects (useLevelManager.ts:131-148) and is cleared on level change (198-201). Inspector edits to name, sky, audio and spawn settings call updateLevelObject without snapshotHistory (EnvironmentInspector.tsx:300-525). Terrain strokes never snapshot (grep undo|history|snapshot in Terrain/*.tsx returns only an unrelated comment). Undoing an earlier operation therefore restores stale terrain heights. grep undo|redo|history lists only Environment files, LevelContext/SceneContext/useLevelManager and HUDEditor/AIChatPanel: the Blueprint, Animation Graph, Level Blueprint and HUD editors and the content browser have no editor undo. Each snapshot deep-copies all objects including terrain heights, up to 50 copies.
- **Done looks like:** A command/transaction undo stack shared by all editors, with coalescing for drags and strokes and memory-bounded history. Every mutation path goes through it, with unit tests for undo/redo round-trips including terrain and inspector edits.
- **Verification:** Verified. History is levelObjects-only, holds up to 50 full JSON deep copies (useLevelManager.ts:131-148) and is cleared on level change (198-201). No inspector updateLevelObject call (EnvironmentInspector.tsx:305-519) snapshots first, and terrain strokes never snapshot. The only other undo is host command.undo, which covers the last AI HUD proposal only (provider_host.py:818-827; AIChatPanel.tsx:95-99). RetextureEditor has only a 'Discard' button.

#### EDIT-09 — Debounced level edits are dropped on Save, close or project switch, and failed persists revert silently

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** broken · **Complexity:** S · **Roadmap:** Phase 0
- **Evidence:** updateLevelObject (used for gizmo, inspector and sculpt edits) persists only after a 1.5 s timer (useLevelManager.ts:526-527). saveProject does not flush pending updates (useProjectManager.ts:136-141). A session transition clears pendingUpdatesRef without writing (useLevelManager.ts:260-266), and so does unmount (268-276). On a persist error the edit is rolled back with only a diagnostics record and no user notification (useLevelManager.ts:249-255).
- **Done looks like:** Pending edits are flushed and awaited before save, save-as, close, open and level switch. Persist failures raise a visible notification and keep the edit retryable. A regression test covers edit-then-immediate-save and edit-then-close.
- **Verification:** Verified: 1.5 s debounce (useLevelManager.ts:526-527). saveProject only persists the editor-state metadata and calls save (useProjectManager.ts:136-141), and grep flush|commitUpdates finds no caller outside the hook. A session transition and unmount both clear pending updates without writing (useLevelManager.ts:260-276). By contrast, useAttachmentManager.ts:56-63 does flush on unmount, so this is a level-manager regression. On failure the edit is rolled back with only a diagnostics record (249-255). This combines badly with EDIT-10 and EDIT-12, whose failures are reverted silently through this path.

#### EDIT-10 — Terrain persistence exceeds the 256 KiB host message limit

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** broken · **Complexity:** M · **Roadmap:** Phase 0
- **Evidence:** Heights are a JSON number[] inside the level object (types.ts:95-101). Each stroke commits the whole (res+1)^2 array (TerrainObject.tsx:111-121). The resolution slider offers 32-512 with a default of 128 (EnvironmentInspector.tsx:36,135-139). The transport rejects requests over 256 KiB (host/nativeTransport.ts:6,122), and the host refuses to page any document that 'exceeds the transport limit' (Auvra/desktop/project_host.py:627-628). Even at 0 heights, 513^2 values is over 500 KB of JSON, and a fully sculpted 129^2 terrain is about 300 KB. Failed commits roll back silently (EDIT-09).
- **Done looks like:** Heightmaps stored as binary assets (for example R16/R32F) uploaded through the asset path and chunked into tiles. Terrain documents hold only references and metadata. Per-stroke undo. Tested save/reopen at 513^2 and above.
- **Verification:** Verified and worse than stated. The full float array is committed per stroke (TerrainObject.tsx:111-121), and the slider allows 32-512 (EnvironmentInspector.tsx:136). The transport cap is 256 KiB (nativeTransport.ts:6,122; host/validation.py:29). In addition, the host snapshot soft limit is 192 KiB (project_host.py:38). A terrain document of 192-256 KiB can be committed, but then fails paging even at page_size 1 with 'A project document exceeds the transport limit' (project_host.py:627-628). Every later object upsert does getSnapshotAll('objects') first (db.ts:150-152), so one large terrain can make the whole objects domain unreadable for edits and project load.
- **Depends on:** EDIT-09

#### EDIT-11 — Play-in-editor is not isolated from authored data and has no player start

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** broken · **Complexity:** M · **Roadmap:** Phase 0
- **Evidence:** LevelGameLoop passes the editor's persistent removeLevelObject into the level-logic runtime (LevelGameLoop.tsx:95,373). DestroyActor calls it (useLevelBlueprintRuntime.ts:240-245) for overlaps generated from authored levelObjects (339-361), which deletes them from the project via a canonical remove (useLevelManager.ts:482-491). The player spawns at the Scene tab's ViewportContext camera X/Z with a fixed y=0.5 (useEnvironmentState.ts:109-112; LevelGameLoop.tsx:186). The World Editor camera never updates that state: grep setCameraState matches only SceneCamera and GraphPreview.
- **Done looks like:** PIE runs on a cloned, transient world that is discarded on Stop, with no host writes from gameplay. A player-start entity, a play-from-camera option, and simulate versus possess modes. An automated test asserts the project revision is unchanged after a play session.
- **Verification:** Verified. LevelGameLoop takes removeLevelObject from useScene (line 95) and passes it to LevelLogicSystem (line 373). DestroyActor calls it (useLevelBlueprintRuntime.ts:240-245), and that is the persistent host remove (useLevelManager.ts:482-491). Spawn uses the ViewportContext camera X/Z with y=0.5 (useEnvironmentState.ts:109-111; LevelGameLoop.tsx:186). setCameraState is called only from SceneCamera.tsx and GraphPreview.tsx, so the World Editor camera is never used.
- **Depends on:** EDIT-04

#### EDIT-13 — Placement and foliage painting ignore terrain and mesh surfaces

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** missing · **Complexity:** M · **Roadmap:** Phase 2
- **Evidence:** Click placement intersects an infinite plane near y=0 (EnvironmentScene.tsx:44-78,90). The foliage brush uses new THREE.Plane(up, 0) (FoliageBrushTool.tsx:38) with 'const normal = _up; // Assuming flat plane for now' (line 99), so alignToNormal does nothing. There is no surface, vertex or pivot snapping and no minimum spacing.
- **Done looks like:** Placement and paint raycast against terrain and static meshes (BVH-accelerated), with align-to-normal, slope and height filters, spacing and density controls, and snap-to-surface and vertex snapping for the gizmo.
- **Verification:** Verified. InteractionLayer raycasts against a mathematical Plane (EnvironmentScene.tsx:80-90). FoliageBrushTool uses Plane(up,0) (line 38) and `const normal = _up; // Assuming flat plane for now` (line 99), so alignToNormal is a no-op. Painted foliage is spawned at cursor y (~0), so it sits under or above sculpted terrain, while play mode snaps the player to terrain height (usePlayerPhysics.ts:220-224).
- **Depends on:** EDIT-02

#### EDIT-14 — Level editing does not scale: per-instance host transactions, full-domain refetch, native revalidation per edit, no LOD or BVH

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** debt · **Complexity:** L · **Roadmap:** Phase 2
- **Evidence:** Every upsert first fetches the entire domain through paged host calls, then applies one document (utils/db.ts:147-165, serialized through mutationQueue at 140-145). Each applyChanges revalidates the whole project against native and rehydrates the native world (project_host.py:659,673). The foliage brush issues up to ceil(density*5) addLevelObject calls per frame while painting (FoliageBrushTool.tsx:53,80-119). Each added instance changes the args of the InstancedMesh, so it is recreated (InstancedLevelLayer.tsx:130). Hover raycasting tests every instance with no BVH. grep for LOD/<Detailed/BVH in components, hooks and utils returns 0 hits. Outliner and browser lists are not virtualized. Project open re-parses all FBX sequentially (useScenePersistence.ts:305-330).
- **Done looks like:** One batched transaction per stroke or gizmo drag carrying deltas, with incremental native updates. Growable instance buffers. BVH picking. LOD and distance culling for instanced layers. Virtualized lists. A perf budget test, for example 10k foliage instances plus 500 props at 60 fps in the editor and under 5 s project open with cooked assets.
- **Verification:** Verified. Every upsert refetches the whole domain (db.ts:150-152). Host _apply rebuilds the domain, validates the full project against native and rehydrates native on every apply (project_host.py:654-673). The brush does ceil(density*5) adds per frame (FoliageBrushTool.tsx:80-119). Each addLevelObject also calls snapshotHistory(), which JSON deep-copies all level objects including terrain heights for every painted instance (useLevelManager.ts:442,141-148). InstancedMesh args include instances.length (InstancedLevelLayer.tsx:130), so it is recreated on every add. There is no BVH or LOD.
- **Depends on:** EDIT-03

#### EDIT-15 — Core editor UX missing: multi-select, duplicate/copy/paste, focus, fly camera, Ctrl+S, preferences

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** missing · **Complexity:** M · **Roadmap:** Phase 2
- **Evidence:** Selection is a single selectedObjectId (useEnvironmentState.ts:16). grep for marquee/selectedIds/multiSelect finds only GraphCanvas.tsx:170. grep for key 's','d','f','c','v' and navigator.clipboard in components, hooks, context and utils returns no files. Hotkeys are only Q/B/M/W/E/R/Z/X/Del/Esc and undo (useEnvironmentHotkeys.ts:176-231). The 'Focus Object' button only re-selects (EnvironmentSidebar.tsx:338-344). The World Editor uses OrbitControls only, with no WASD fly (EnvironmentViewport.tsx:198-203). The rotation snap is fixed at 15° with a display-only toolbar label (useEnvironmentState.ts:31; EnvironmentToolbar.tsx:211). There are 13 window.confirm/alert/prompt calls. SettingsModal configures providers only, with no editor preferences or keybindings.
- **Done looks like:** Multi-select (click with modifiers, marquee, outliner range) with group gizmo. Duplicate (Ctrl+D), copy/paste and delete, plus frame-selected (F). A fly camera with speed control. Ctrl+S. Configurable snap values. In-app dialogs instead of browser prompts. Editor preferences with remappable shortcuts. Keyboard-accessible panels.
- **Verification:** Verified. useEnvironmentHotkeys.ts handles only Ctrl+Z/Y, Del, Esc, Q/B/M, W/E/R, Z and X. grep duplicate|clipboard|paste in Environment, useLevelManager and context returns 0 hits. The World Editor uses OrbitControls only (EnvironmentViewport.tsx:198-203). A WASD fly camera does exist for the Scene tab (components/Scene/SceneCamera.tsx:131), but the World Editor does not reuse it.
- **Depends on:** EDIT-02, EDIT-08

#### EDIT-16 — Asset management is a flat list: no folders, rename, move, dependencies or drag-to-viewport

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** missing · **Complexity:** M · **Roadmap:** Phase 2
- **Evidence:** ContentBrowser has only a category filter and search, plus delete (components/UI/Browser/ContentBrowser.tsx:36-118). The World Editor asset list shows only the 'Prop' and 'Environment' categories (EnvironmentSidebar.tsx:28-31), so Character models cannot be placed as scenery. There is no drag/drop handler in either browser. Deleting a model silently removes all its placements (useLevelManager.ts:29-31) with no reference warning.
- **Done looks like:** A folder-based asset browser with rename, move, search and filter, thumbnails, a reference/dependency view with safe-delete warnings, drag-and-drop into viewport and inspector slots, and one browser shared by all editor modes.
- **Verification:** Verified. The World Editor filters to Prop/Environment (EnvironmentSidebar.tsx:28-31). grep onDrop|onDragStart|draggable|rename|folder in Browser and Environment returns only the object-rename tooltip (EnvironmentInspector.tsx:307). Model delete silently cascades placements (useLevelManager.ts:29-31; db.ts:304-306). Because import also rejects duplicate filenames (useModelManager.ts:30-33), two different 'Tree.fbx' files cannot coexist, which is a real constraint for a flat namespace.
- **Depends on:** EDIT-03

#### EDIT-17 — Thin test coverage and narrow strict typing for editor core

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** debt · **Complexity:** M · **Roadmap:** Phase 4
- **Evidence:** tests/frontend has 5 test files with 7 tests in total (editorSession, hudTypes, rendererRecovery, scrubbableInput, select). There are no tests for useLevelManager, undo/redo, useScenePersistence, import, the gizmo or the inspector. tsconfig.strict.json 'include' lists only 5 source files. 110 occurrences of ': any', 'as any' or '<any>' remain in components, hooks, context, utils, renderer and App.tsx. The renderer verify scripts exercise modules that are unused at runtime.
- **Done looks like:** Unit tests for level manager persistence, undo and debounce flush. Component tests for the inspector, gizmo and outliner. A Playwright or WebView end-to-end smoke (import, place, transform, save, reopen, play, verify unchanged). Strict TypeScript across all editor source in CI.
- **Verification:** Verified. tests/frontend has 5 files with 7 it/test cases. tsconfig.strict.json includes only 5 source files plus tests. I count 115 `: any|as any|<any>` hits. scripts/project/verify.mjs is mostly regex assertions over source text, for example lines 78, 130 and 164. These are not behavioral tests of the level manager.

#### EDIT-M01 — Level-script actor references use non-unique display names, so events hit every same-named instance and break on rename

- **Severity:** major (found by verifier) · **Kind:** broken · **Complexity:** S · **Roadmap:** Phase 0
- **Evidence:** Overlap events store `targetActorName` as a free-text string (LevelBlueprintEditor.tsx:91-108; LogicNode.tsx:271-272; LevelBlueprintInspector.tsx:139-141). The runtime matches by `n.data?.targetActorName === obj.name` (useLevelBlueprintRuntime.ts:355-357). Default names are identical for every placement of a model: `${model?.name}_Prop` / `_Foliage`, and 'Enemy Spawner' (useLevelManager.ts:456-460). So an overlap event fires for every instance of that model, DestroyActor deletes whichever one overlapped (and does so persistently, see EDIT-11), and renaming an object in the inspector (EnvironmentInspector.tsx:305) silently orphans the script reference. No actor picker or ID-based reference exists.
- **Done looks like:** Script nodes reference actors by stable object ID, picked from the outliner or viewport with an eyedropper. The display name is shown but not used for matching. Rename and delete update or flag dependent graphs. A migration converts existing name references. A test covers duplicate names and rename.
- **Depends on:** EDIT-04

#### EDIT-M02 — No project/game settings or multi-level flow: no startup level, level rename or level transitions, and the player pawn is picked project-wide

- **Severity:** major (found by verifier) · **Kind:** missing · **Complexity:** M · **Roadmap:** Phase 1
- **Evidence:** grep renameLevel|startupLevel|defaultLevel|projectSettings|gameSettings over hooks, context, components and utils returns only the legacy default-level bootstrap (useLevelManager.ts:289-301; useScenePersistence.ts:884). components/Settings has only SettingsModal (providers). LevelAction supports only 'Restart' and 'EndGame' (useLevelBlueprintRuntime.ts:247-258), and grep OpenLevel|nextLevel|changeLevel returns 0 hits. PIE always uses the first 'Player Character' blueprint in the whole project (useSandboxConfiguration.ts:24,28) inside a fixed third-person-shooter loop: weapon sounds, aim, projectiles and blood (LevelGameLoop.tsx:99-134,240,319-387). There is no per-level game mode or default-pawn setting.
- **Done looks like:** A Project Settings panel (game name, startup level, default game mode and player, input actions, window and quality defaults) persisted in the project schema and consumed by PIE and the future player build. Level rename and duplicate. A 'Load Level' script node with a level picker. Per-level world settings that override the game mode and player.
- **Depends on:** EDIT-04, EDIT-01

#### EDIT-M03 — No collision authoring: play-mode collision is inferred from object scale, invisible logic objects block the player, and the world is hard-clamped to ±100 m

- **Severity:** major (found by verifier) · **Kind:** broken · **Complexity:** M · **Roadmap:** Phase 3
- **Evidence:** usePlayerPhysics.ts:189-210 treats every level object except foliage and terrain as a circle obstacle with radius max(scale.x,scale.z)*0.5. That makes a 5 m-normalized prop placed at scale 1 a 0.5 m collider, and makes spawn_point, audio_emitter and sky_sphere (sky placed at [0,5,0], EnvironmentSidebar.tsx:87-92) invisible 0.5 m blockers. usePlayerPhysics.ts:214-215 clamps the player to x,z in [-100,100], while the editor lets terrain be authored up to 1000 m (EnvironmentInspector.tsx:117). grep rapier|cannon|ammo|physx|collider in package.json, components and hooks returns 0 hits. The editor has no collider shape, collision toggle or visualization.
- **Done looks like:** Per-object collision settings in the inspector (none, box, sphere, capsule, convex or mesh, auto-fit to mesh bounds, trigger flag, layer), visualized in the editor. Play mode uses those shapes through a real physics backend. Non-geometric logic objects never collide. World bounds come from level settings or the terrain extent, not a constant.
- **Depends on:** EDIT-04

#### EDIT-18 — Editor is disconnected single-purpose tabs; the 'Scene' tab is an asset viewer, not scene assembly

- **Severity:** minor (auditor: minor; verifier: partial) · **Kind:** claim-mismatch · **Complexity:** M · **Roadmap:** Phase 2
- **Evidence:** The README claims 'scene assembly'. App.tsx:27,65-155 mounts one of 7 tabs at a time, each with its own canvas, so switching unmounts it and loses World Editor tool and selection state (useEnvironmentState.ts:13-48). The Scene tab renders models at the origin with no transforms and hides all but the selected one (ViewerScene.tsx:91-97). There are two separate play modes (Sandbox tab and PLAY LEVEL). Panels are fixed, with no docking or resizing.
- **Done looks like:** A level-centric main editor with a persistent viewport and dockable, resizable panels (outliner, inspector, browser, asset preview). Specialized editors open as documents or panels without destroying viewport state. One play mode.
- **Verification:** The tab architecture is confirmed: App.tsx:27 holds a single activeTab, and each editor is mounted conditionally. The claim-mismatch framing is weak. README.md:8 says 'scene assembly', and the World Editor (EnvironmentEditor) does provide level assembly with an outliner, inspector, gizmo and quad-view layouts. The Scene tab being an asset viewer contradicts no README claim. The README itself states pre-alpha status (README.md:16-17). The real issue is state loss on tab switch and two separate play modes.
- **Depends on:** EDIT-04

#### EDIT-19 — No editor extensibility (plugins, tools, editor scripting)

- **Severity:** minor (auditor: minor; verifier: confirmed) · **Kind:** missing · **Complexity:** L · **Roadmap:** Deferred (§5)
- **Evidence:** Plugin capabilities are limited to {'text','code','commands','media.generate','media.edit'} (Auvra/plugins/package.py:28). grep registerPanel|registerTool|editorPlugin|registerCommand|commandPalette in frontend components, hooks, context and utils returns 0 hits.
- **Done looks like:** A documented, sandboxed editor extension API (custom inspectors and components, tools/menus, importers, and batch scripts over the project model), versioned with the host protocol.
- **Verification:** Verified. Plugin capabilities are AI/provider-only (Auvra/plugins/package.py:28). The 'commands' capability produces only HUD element create/update/delete proposals (provider_host.py:725-734; providers/commands.py:32). No editor extension API exists. This is not required for the ship bar, so minor is right.
- **Depends on:** EDIT-04

#### EDIT-20 — Dead and duplicate code plus small correctness bugs in editor components

- **Severity:** minor (auditor: minor; unverified (minor, not sent to verifier)) · **Kind:** debt · **Complexity:** S · **Roadmap:** Phase 0
- **Evidence:** components/UI/{ContentBrowser,Sidebar,AnimationControls,AttachmentPanel,ViewControls}.tsx (about 793 LOC) are unreferenced duplicates of the Browser/, Sidebar/, Properties/ and Viewport/ versions (import grep finds only the latter). renderer/renderGraph.ts, contracts.ts, capabilities.ts and conventions.ts are imported only by verify scripts. LevelObjectRenderer.tsx:139 calls useMemo after conditional early returns (rules-of-hooks violation). EnvironmentScene.tsx:421 has an operator-precedence bug: `isActiveView && interactionMode==='select' || interactionMode==='sculpt'`.
- **Done looks like:** Duplicates deleted. Renderer contracts either wired into a real runtime path or moved to a clearly labeled spec package. Hooks-order and precedence bugs fixed and lint-enforced (eslint-plugin-react-hooks in CI).

### 7.3 Gameplay authoring and runtime

*Audited:* Gameplay authoring + runtime (fbx-viewer (1): Sandbox, Blueprint, LevelBlueprint, HUDEditor, AnimationGraph runtime, gameplay hooks, data/blueprints, hud-frame, types.ts)

The gameplay layer is a hardcoded third-person-shooter demo, not a game framework. It is built from React/R3F components that exist only inside the editor. A small Level Blueprint graph (one per level, about 20 node kinds, Float/Bool/Int/String only, no loops, functions, custom events, spawning, transforms or timers) drives two fixed entity "blueprint" types. Those types are 'Player Character' (only one allowed) and 'Enemy Controller'. Both are really templates of a model, stats and an animation graph, with no per-entity scripting. Movement, camera, input, combat and AI are hand-coded with constants: WASD/Shift/F/LMB, an orbit camera, hitscan-like projectiles, a melee-chaser state machine and a ±50/±100 arena clamp. There is no physics library, navmesh, gamepad support, save-game, level transition, runtime HUD, particle system beyond hardcoded blood, localization or networking. The play mode has bugs that break gameplay. Static tracing shows BeginPlay re-runs on every LevelGameLoop render, which is effectively every frame. 'Destroy Actor' permanently deletes the level object from the saved project. Enemies in level play mode deal no damage. The authored HUD document is never shown in play mode. The native Rust world has only transform, velocity, render, light and animation data, so no shipped build can contain any of this gameplay. Against a Godot 4 / early-Unity bar, nearly the whole game framework still has to be built: an entity-component model, physics, scripting, input, UI runtime, game flow and save, and a standalone runtime.

**What exists:**

- **[stub]** Level Blueprint visual scripting editor (event graph per level) — components/LevelBlueprint/LevelBlueprintEditor.tsx:339-435 palette: BeginPlay/Tick/Overlap events, Float/Int/String/Bool literals, Add/Sub/Add(Int)/ToString, PrintString/DestroyActor/Restart/EndGame, Branch/Greater, Get/Set of Player/Enemy anim-graph vars and stats. LogicCanvas.tsx:99-151 does pin linking with type compatibility. Persisted in LevelData.blueprint (useLevelManager.ts:530-558).
- **[basic]** Level Blueprint runtime interpreter with cycle/depth guard — hooks/useLevelBlueprintRuntime.ts:69-202 pulls data inputs backward (Add/Sub/Mul/Div/compare/And/Or/literals/VariableGet). :214-296 runs exec nodes forward with path-set and depth caps (MAX 128/256, :10-11), which is the F-008 fix. Tick runs in useFrame (:320-325). Overlap is a sphere-distance test against level-object pivots (:341-366).
- **[basic]** Entity 'Blueprints' (Player/Enemy templates) — types.ts:259-282 has BlueprintType 'Player Character'|'Enemy Controller', linked model, stats, traits, animation graph, meshScale, aimOffset and weaponSounds. data/blueprints/player.ts and enemy.ts hold the defaults. useBlueprintManager.ts:20-69 enforces a single player. Only the 'Health' and 'Damage' stats are read at runtime (SandboxEntity.tsx:69, SandboxWorld.tsx:69).
- **[broken]** Play-in-editor level game loop — components/Environment/LevelGameLoop.tsx:94-410 renders terrain, instanced props and foliage, sky, audio, player, timed enemy spawners (SpawnerSystem :42-83), level logic, camera and a hardcoded SandboxUI. It is entered from EnvironmentEditor.tsx:68-74 with the player spawned at the editor camera. Several defects are listed in the gaps (BeginPlay re-fire, destructive DestroyActor, no enemy damage).
- **[basic]** Sandbox test arena (1 player vs 1 enemy) — components/Sandbox/SandboxScene.tsx and SandboxWorld.tsx:35-201 use fixed spawn positions [-3,0,3]/[3,0,-3] and the first Player and first Enemy blueprint (useSandboxConfiguration.ts:24-25). Enemy melee damage works here (SandboxWorld.tsx:81-88).
- **[stub]** Player character controller (third-person shooter) — PlayerController.tsx:75-102 with usePlayerPhysics.ts:18-27 hardcoded speeds and stamina. Collision is circle-vs-circle using object scale as radius (:188-211). Y snaps to the terrain heightfield or 0 (:218-227), with no gravity or jump. The world is clamped to ±100 (:213-215).
- **[stub]** Camera system — components/Sandbox/CharacterCameraRig.tsx: one pointer-lock orbit/aim rig with hardcoded sensitivity 0.002 and pitch limits (:33-35). Distance comes from the 'CameraDistance' graph variable (:38-41). No raycast or collision (no Raycaster in the file), no camera switching. useCameraManager.ts is only an editor camera state holder (13 lines).
- **[basic]** Combat: projectiles, health, death/despawn, hit VFX — usePlayerCombat.ts:14-18 hardcodes FIRE_RATE 0.15 and damage 10. ProjectileManager.tsx:57-90 tests segments against registered cylinders only. useEntityHealth.ts:30-46 sets the IsDead graph variable. SandboxEntity.tsx:155-204 fades and despawns dead entities. BloodSystem.tsx is a hardcoded 400-particle instanced burst.
- **[stub]** Enemy AI (melee chaser FSM) — components/Sandbox/AI/AIStateMachine.ts with states IDLE/PATROL/CHASE/SEARCHING/STRAFING/ATTACKING/RECOVERY/RETURNING (AIConfig.ts:47-55). Perception is an FOV cone plus hearing radius with no occlusion (AISenses.ts:27-37). Movement is a straight line toward the destination (useAILocomotion.ts:154-156). Tuning constants are hardcoded (AIConfig.ts:1-44).
- **[basic]** Level audio emitters (2D/3D) — components/Environment/AudioSystem.tsx:84-147 uses THREE.Audio/PositionalAudio with ref/max distance, rolloff, loop region and autoplay from AudioConfig (types.ts:81-93). Player weapon one-shots are non-positional 2D sounds with random detune (usePlayerCombat.ts:51-79).
- **[basic]** HUD editor with sandboxed custom JSX widgets — components/HUDEditor/HUDEditor.tsx:13-28,120-122 stores the 'hud-main' document in the project. componentRegistry.tsx:85-92 has 6 widget types (Scope, HealthBar, Crosshair, Text, Container, Custom). DynamicHUDComponent.tsx:84-88 compiles Babel JSX with a step guard, and hud-frame.tsx:63 evaluates it with new Function inside an opaque-origin iframe. AIChatPanel produces host-approved HUD commands.
- **[basic]** Animation runtime (state machine + Blend2D) — AnimationGraph/GraphRuntime.tsx and hooks/useGraphRuntime.ts:59-123 provide a variable store, state machine, mixer and Blend2D. Full detail is in CHARACTER_ANIMATION_UNREAL_GAP_AUDIT.md §0: no montages, layers, IK, root motion or notifies, and no skinning in the native renderer.

#### GAME-01 — Gameplay runtime exists only inside the editor's React tree; no standalone game runtime

- **Severity:** blocker (auditor: blocker; verifier: confirmed) · **Kind:** missing · **Complexity:** XL · **Roadmap:** Phase 1
- **Evidence:** LevelGameLoop.tsx:95 pulls everything from the editor's useScene() context, and play is reachable only via EnvironmentEditor.tsx:68-74. native/src/world.rs:93-141 Entity and WorldCommand cover only transform, velocity, render, light and animation, with no scripting, input, collision, audio or UI. Grepping the repo for exportGame|buildGame|packageGame|player build|game build (excluding node_modules/.venv/target) finds nothing.
- **Done looks like:** A runtime-only package loads cooked project data (levels, entities, graphs, HUD, input map, audio) and runs the game loop, scripting, physics, input, UI and audio with no editor contexts, project session or host write access. Editor play mode uses that same runtime. An 'Export Game' flow produces a player-facing executable with a startup map. This overlaps the packaging area, but the gameplay code has to be split out of the editor first.
- **Verification:** Play is reachable only as an editor branch. EnvironmentEditor.tsx:68-74 swaps the editor for <LevelGameLoop>, and LevelGameLoop.tsx:95 pulls all of its data from useScene(). native/src/world.rs:93-141 Entity and WorldCommand cover only transform, velocity, render, light and animation, and world.rs:709-713 only integrates velocity. A grep of native/src for KeyboardInput|KeyCode|script|collision|audio|physics finds no gameplay; main.rs:635-644 handles only Close, Resize and Redraw. Grepping for exportGame|buildGame|packageGame|standalone|startupLevel|export_game over .ts/.tsx/.py/.rs/.md/.json/.toml/.yml finds only @babel/standalone and texture variables. release/ (build.ps1, pipeline.py) packages the editor MSIX, which README.md:151-160 confirms. Plugins are provider-only (Auvra/plugins/protocol.py:20 ProviderProtocolError), so no hidden runtime lives there either.
- **Depends on:** GAME-02, GAME-07, GAME-13

#### GAME-02 — No general actor/entity-component model; gameplay types hardcoded to Player/Enemy

- **Severity:** blocker (auditor: blocker; verifier: confirmed) · **Kind:** missing · **Complexity:** XL · **Roadmap:** Phase 2
- **Evidence:** types.ts:72 fixes LevelObjectType to 6 kinds. types.ts:125-138 LevelObject is a flat record with optional per-type configs and no components, parent, tags or custom properties. types.ts:259 BlueprintType is 'Player Character'|'Enemy Controller'. useBlueprintManager.ts:24-28 enforces a singleton player. types.ts:306 Hittable team is 'Player'|'Enemy'. Traits such as 'InventorySystem' and 'QuestLog' (player.ts:117) are cosmetic: a grep for traits finds only BlueprintInspectorPanel.tsx:365-379. Placed props are instanced meshes with no runtime identity (LevelGameLoop.tsx:303-304).
- **Done looks like:** Entities have a transform hierarchy and a list of typed components (mesh, collider, rigidbody, script/graph, audio source, light, camera, trigger, spawner, health, and so on). Users can define any number of blueprint/prefab classes, each with its own variables and event graph, with per-instance overrides. Entities can be placed, spawned, queried and destroyed at runtime by reference. The project schema and the native world carry the same component data.
- **Verification:** Verified at types.ts:72 (6 object kinds), types.ts:125-138 (flat LevelObject), types.ts:259 (two BlueprintTypes), types.ts:306 (team union) and useBlueprintManager.ts:23-27 (singleton player). Traits are only edited in BlueprintInspectorPanel.tsx:365-379 and read nowhere else. One small overstatement: props do have a runtime identity through their LevelObject id, since DestroyActor removes them by id and InstancedLevelLayer re-renders from levelObjects. But script can only address them through the overlap context. Enemies cannot be placed at all; they exist only through spawn_point timers (LevelGameLoop.tsx:42-83). The Python schema also hard-allowlists nested keys (Auvra/project/schemas.py:26-52), so a component model needs schema work too.

#### GAME-03 — Visual scripting node library is too small to script a game

- **Severity:** blocker (auditor: blocker; verifier: confirmed) · **Kind:** stub · **Complexity:** XL · **Roadmap:** Phase 3
- **Evidence:** types.ts:232-235 lists every node kind (about 20). The palette exposes fewer (LevelBlueprintEditor.tsx:351-412). Multiply, Divide, Less, Equal, And and Or are implemented in the runtime (useLevelBlueprintRuntime.ts:146-195) but cannot be added from the palette, which offers only Greater (:409). PinDataType has no Vector, Rotator, Array or object references (types.ts:220). There is one graph per level and no per-entity graphs. Grepping for Delay|ForLoop|Sequence|DoOnce|Gate|SpawnActor|CustomEvent finds nothing.
- **Done looks like:** The node set covers flow control (Sequence, ForLoop/ForEach/While with budget, Delay/Timer, DoOnce, Gate, Switch) and custom events/dispatchers. It supports functions and macros with inputs and outputs, local and level variables, and Vector/Rotator/Transform/Array/Map/EntityRef types with casts. Gameplay nodes cover spawn and destroy by reference, get/set transform, apply damage, play sound or animation, input action events, physics queries, timers, HUD binding, open level, save/load and print. Each blueprint class has its own event graph. A searchable context-menu palette generated from a node registry.
- **Verification:** The palette (LevelBlueprintEditor.tsx:347-412) offers BeginPlay, Tick, Overlap, four literals, Add, Sub, Add(Int), ToString, Print, Destroy, Restart, EndGame, Branch and Greater only. Multiply, Divide, Less, Equal, And and Or run in the runtime (useLevelBlueprintRuntime.ts:146-195) but have no palette entry. Grepping for Delay|ForLoop|ForEach|Sequence|DoOnce|Gate|SpawnActor|CustomEvent|FlipFlop finds only a comment at useLevelBlueprintRuntime.ts:281. One minor correction: PinDataType does include 'Object' (types.ts:220). It is only produced by Overlap's 'Other Actor' pin, and no node consumes it, because DestroyActor has no target pin. Entity variables are Float/Boolean only (types.ts:150). This gap and GAME-14 together leave no viable scripting path, so blocker stands.
- **Depends on:** GAME-02

#### GAME-06 — Play mode is not isolated: 'Destroy Actor' permanently deletes level objects from the project

- **Severity:** blocker (auditor: blocker; verifier: confirmed) · **Kind:** broken · **Complexity:** M · **Roadmap:** Phase 0
- **Evidence:** The DestroyActor node calls removeLevelObject (useLevelBlueprintRuntime.ts:240-246), wired from the editor context (LevelGameLoop.tsx:95,373). That function snapshots editor undo history and calls dbOperations.deleteLevelObject (useLevelManager.ts:482-491), which issues canonicalChange('objects','remove') to the host project (utils/db.ts:465-466). Restart only resets enemies and stats (LevelGameLoop.tsx:201-211), so the object stays gone.
- **Done looks like:** Play mode runs on a cloned runtime world. Destroy, spawn and move affect only that world, nothing is written to the project or undo stack, and stopping or restarting play restores the authored state.
- **Verification:** The DestroyActor node calls removeLevelObject (useLevelBlueprintRuntime.ts:240-246). That function calls snapshotHistory and dbOperations.deleteLevelObject (useLevelManager.ts:482-491), which issues canonicalChange('objects','remove') at utils/db.ts:465-466. handleRestart (LevelGameLoop.tsx:201-211) does not restore the object. One mitigation: snapshotHistory puts the pre-delete state on the editor undo stack (capped at 50), so a user who notices can Ctrl+Z after leaving play. Even so, every playtest of a pickup or destroy mechanic edits the authored project. The root cause is that no runtime world copy exists, so blocker stands. If the project is read-only, assertWritable throws inside the async callback and the rejection goes unhandled.
- **Depends on:** GAME-02

#### GAME-07 — No physics engine: no rigid bodies, gravity, colliders, triggers, or raycast queries

- **Severity:** blocker (auditor: blocker; verifier: confirmed) · **Kind:** missing · **Complexity:** L · **Roadmap:** Phase 3
- **Evidence:** package.json has no physics dependency, and grepping the frontend for rapier|cannon|ammo|physx|jolt|oimo returns 0 hits. Player collision is a circle push-back using object scale as radius, with foliage skipped (usePlayerPhysics.ts:188-211). Y is snapped to the heightfield or 0 (:218-227). Jump only sets an animation variable (PlayerController.tsx:99). Enemies have no world collision or terrain snap and move along an unflattened 3D vector (useAILocomotion.ts:154-156). Projectiles ignore walls and terrain and test only registered cylinders (ProjectileManager.tsx:57-90). Overlap 'triggers' measure distance from object pivots with scale as radius (useLevelBlueprintRuntime.ts:342-348). All Raycaster use is in editor tools (Environment/*).
- **Done looks like:** A physics engine (for example Rapier WASM in the web runtime and rapier/Jolt natively) with static, kinematic and dynamic bodies. Box, sphere, capsule, convex, mesh and heightfield colliders can be authored or auto-generated on import. Collision layers and masks, trigger volumes with enter/exit events, and raycast, shape-cast and overlap queries are exposed to scripting. A kinematic character controller handles gravity, slopes, steps and jump. Projectiles use physics queries.
- **Verification:** Grepping .ts/.tsx/.py/.rs/.toml/package.json for rapier|cannon|ammo.js|physx|jolt|oimo|havok|bullet finds only a 'Bullet Drop' comment in ScopeReticle.tsx. native/Cargo.toml lists only pollster, serde, serde_json, wgpu and winit. The circle push-back is at usePlayerPhysics.ts:188-211, and the Y snap is at :218-227. Another problem: the push-back skips only foliage and terrain (:191), so invisible spawn_point, audio_emitter and sky_sphere objects act as solid 0.5 m circles. All three are created at x=0, z=0 with scale 1 (EnvironmentSidebar.tsx:52-92). Projectiles test only registered Hittables (ProjectileManager.tsx:55-93).
- **Depends on:** GAME-02

#### GAME-12 — Authored HUD is never shown in game; no runtime UI system (binding, interaction, menus, fonts, localization)

- **Severity:** blocker (auditor: blocker; verifier: confirmed) · **Kind:** broken · **Complexity:** L · **Roadmap:** Phase 3
- **Evidence:** The 'hud-main' document (HUDEditor.tsx:21,120-122) has no consumer outside HUDEditor and the Python host (repo grep for hud-main). Play mode renders the hardcoded SandboxUI instead (LevelGameLoop.tsx:394-407; SandboxUI.tsx:237-262). Widget props are static, with no binding to game variables (HUDCanvas.tsx:199). HUDElement.align is declared but never used (HUDEditor/types.ts:14). Resize handles are 'Visual Only' (HUDCanvas.tsx:187). The Custom widget iframe is pointer-events-none (DynamicHUDComponent.tsx:170), so buttons cannot work. There is no Font asset category (types.ts:7), and grepping for i18n|locali[sz] finds nothing.
- **Done looks like:** The runtime renders authored UI documents: HUD plus a screen stack for main menu, pause, options and game over. It supports anchors and scaling, data binding to entity and game variables, and interactive widgets (button, slider, toggle, list, text input) with focus and gamepad navigation. Fonts can be imported, string tables provide localization, and scripting nodes can show or hide screens and set widget values.
- **Verification:** hud-main is consumed only by HUDEditor.tsx:21, Auvra/desktop/provider_host.py (516, 760-811) and a test. Play mode renders the hardcoded SandboxUI (LevelGameLoop.tsx:394-407). HUDCanvas.tsx:199 passes static el.props, and the resize handles are marked 'Visual Only' (HUDCanvas.tsx:187). DynamicHUDComponent.tsx:170 sets pointer-events-none. Grepping for i18n|locali[sz] finds nothing. Grepping components/HUDEditor for `.align` finds nothing, so align is never used.
- **Depends on:** GAME-03, GAME-09

#### GAME-13 — No game flow: game state, save/load, level transitions, player start, pause

- **Severity:** blocker (auditor: blocker; verifier: confirmed) · **Kind:** missing · **Complexity:** L · **Roadmap:** Phase 1
- **Evidence:** Grepping for GameMode|GameInstance|gameState|checkpoint|savegame|SaveSlot finds nothing. LevelAction supports only Restart and EndGame (useLevelBlueprintRuntime.ts:247-258), and EndGame just exits play (LevelGameLoop.tsx:376). There is no Open Level node, and loadLevel is editor-only (useLevelManager.ts:362). The player spawns at the editor camera position (EnvironmentEditor.tsx:68-74; LevelGameLoop.tsx:185-187) because there is no PlayerStart type (types.ts:72). Grepping for pause|timeScale finds only animation code.
- **Done looks like:** The project defines a startup map and a game mode/instance with variables that persist across levels. Open Level / Load Level nodes work with loading screens. A PlayerStart actor exists. A save-game API writes versioned slot files to the user's data directory, covering variables and selected entity state. Pause and time scale are supported.
- **Verification:** Grepping .ts/.tsx/.py/.rs for GameMode|GameInstance|gameState|checkpoint|savegame|SaveSlot|PlayerStart|OpenLevel|timeScale|isPaused finds only animation-viewer timeScale (App.tsx:36, ModelViewer.tsx:108) and AnimationAction.timeScale. EndGame maps to onExit (LevelGameLoop.tsx:376). The spawn point is the editor camera position (useEnvironmentState.ts:109-111; LevelGameLoop.tsx:185-187). The project schema does have 'worlds' and 'scenes' domains (Auvra/project/schemas.py:16,129-131), but they are persistence only and nothing loads them at runtime.
- **Depends on:** GAME-01, GAME-02

#### GAME-04 — Visual scripting semantics are fragile or wrong

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** broken · **Complexity:** M · **Roadmap:** Phase 3
- **Evidence:** (a) Events are matched by display name (useLevelBlueprintRuntime.ts:304 and :324 compare n.name to 'Event BeginPlay' and 'Event Tick'; :356 checks name.includes('Overlap')), yet the inspector lets users rename any node (LevelBlueprintInspector.tsx:50-54), which silently disables the event. (b) Only the first wire from an exec output runs (:290 connections.find), while the canvas allows several output wires and caps every input, including Exec, at one wire (LogicCanvas.tsx:136-139). (c) The path guard `path.has(nodeId)` (:215) blocks revisiting a node, so loops cannot be expressed. (d) areTypesCompatible lets String connect to anything, Exec included (LogicCanvas.tsx:102). (e) LevelBlueprintData.variables is never read or written; it appears only in the EMPTY_BLUEPRINT init at useLevelManager.ts:12. (f) Enemy Get/Set is always a no-op in level play because enemyApiRef is `{ current: undefined }` (LevelGameLoop.tsx:372), and even when wired it targets a single enemy. (g) Overlap targets are matched by actor name, not id (:357).
- **Done looks like:** Each node has a stable kind enum plus a GUID, and the display name is cosmetic. Exec outputs fan out in a defined order and exec inputs accept many wires. Explicit loop nodes have iteration budgets. A strict pin type system has explicit conversion nodes. Level and class variables work. Targets are per-instance entity references. A compile step reports errors with node highlighting.
- **Verification:** I verified all seven points. (a) Events are matched by name (useLevelBlueprintRuntime.ts:304, :324, :356), and nodes can be renamed (LevelBlueprintInspector.tsx:50-54). (b) Only the first wire runs (connections.find at :290), and inputs are capped at one wire (LogicCanvas.tsx:136-138). (c) The path.has guard is at :215. (d) The String-to-anything rule is at LogicCanvas.tsx:102, and Object-to-anything is at :104. (e) LevelBlueprintData.variables is referenced only in EMPTY_BLUEPRINT (useLevelManager.ts:11). (f) LevelGameLoop.tsx:372 passes a fresh enemyApiRef with current undefined. (g) The overlap match is by obj.name at :357. Additional finding: the canvas has no way to delete a single wire. LogicCanvas, LogicConnection and LogicNode have no remove or disconnect handler, so a wire goes away only when an input is replaced or its node is deleted.
- **Depends on:** GAME-03

#### GAME-05 — BeginPlay re-runs on every play-mode render, and the whole play tree re-renders every frame

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** broken · **Complexity:** S · **Roadmap:** Phase 0
- **Evidence:** Statically traced, not run. LevelGameLoop.tsx:372 passes a new `{ current: undefined }` enemyApiRef on each render. That changes evaluateInput (deps [blueprint, playerApiRef, enemyApiRef], useLevelBlueprintRuntime.ts:202), which changes executeNode (:296), which re-triggers the BeginPlay effect (deps [blueprint.nodes, executeNode], :303-317). LevelGameLoop re-renders every frame: usePlayerPhysics.ts:174 calls onStaminaChange unconditionally each frame, and LevelGameLoop.tsx:361 stores a new playerStats object every time. removeLevelObject also changes identity whenever levelObjects changes (useLevelManager.ts:141-148, 482-491).
- **Done looks like:** BeginPlay fires exactly once per play session or restart. Runtime refs are stable. High-frequency HUD stats move through a ref or external store instead of top-level React state at 60 Hz. A test asserts BeginPlay runs once across 300 simulated frames.
- **Verification:** I re-traced the chain. usePlayerPhysics.ts:174 calls onStaminaChange every frame, and LevelGameLoop.tsx:361 runs setPlayerStats(prev => ({...prev, stamina})), so each frame produces a new object and LevelGameLoop re-renders. That re-render creates a new `{ current: undefined }` at :372. evaluateInput's dependencies are [blueprint, playerApiRef, enemyApiRef] (:202), so it gets a new identity. executeNode follows (:296), and the BeginPlay effect re-runs because its dependencies are [blueprint.nodes, executeNode] (:317). The result is a BeginPlay PrintString notification on every frame. The S effort estimate is reasonable.

#### GAME-08 — Player controller, camera, and combat are a hardcoded TPS shooter, not data-driven

- **Severity:** major (auditor: blocker; verifier: partial) · **Kind:** missing · **Complexity:** L · **Roadmap:** Phase 3
- **Evidence:** Speeds and stamina are constants (usePlayerPhysics.ts:18-27), while the blueprint 'Walk Speed'/'Run Speed' stats (player.ts:114-115) are never read; grepping stats.find finds only Health and Damage. Fire rate and damage are hardcoded (usePlayerCombat.ts:14-18). There is one orbit/aim camera with fixed sensitivity and no collision (CharacterCameraRig.tsx:33-35). The mesh is hidden while aiming (SandboxEntity.tsx:145-153). The game-over screen is a fixed 'SIGNAL LOST' (SandboxUI.tsx:68-80). Movement is driven twice: useGraphLocomotion translates the mesh every frame on top of the controller (useGraphLocomotion.ts:16-46, always mounted by useGraphRuntime.ts:117).
- **Done looks like:** Movement, camera and weapon behaviour are components configured from blueprint data. Presets cover at least first-person, third-person and top-down controllers. A camera component has a spring-arm collision probe, and a camera manager handles switching, blending and shake. Gameplay rules such as damage, fire rate and death handling are blueprint variables or script, with no engine source edits needed for a non-shooter game.
- **Verification:** The facts hold. The constants are at usePlayerPhysics.ts:18-27 and usePlayerCombat.ts:13-17. Grepping stats.find finds only Health (SandboxEntity.tsx:69) and Damage (SandboxWorld.tsx:69), and mesh hiding while aiming is at SandboxEntity.tsx:145-153. The double drive is real: useGraphLocomotion translates the mesh by 0.05 per frame without delta scaling, which is also frame-rate dependent. It is mounted at useGraphRuntime.ts:70, not :117 as cited. There are slight data hooks: the camera reads a 'CameraDistance' graph variable and blueprint.aimOffset (CharacterCameraRig.tsx:37-41; LevelGameLoop.tsx:390). The severity is overstated. A hardcoded sample controller is fine at the Godot/Unity bar once GAME-02/03/14 exist, since those engines also make users script controllers. Major, not an independent blocker.
- **Depends on:** GAME-02, GAME-07

#### GAME-09 — No input action mapping, gamepad support, or rebinding

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** missing · **Complexity:** M · **Roadmap:** Phase 3
- **Evidence:** Keys are hardcoded in usePlayerControls.ts:173-184 (WASD, ShiftLeft, Space, KeyF, LMB). The animation graph's authored 'Input Mappings' are disabled at runtime (SandboxEntity.tsx:326 enableInputs={false}). Grepping for getGamepads|gamepad finds only lucide icon imports. Escape is hard-wired to exit play (LevelGameLoop.tsx:228-238). The visual scripting has no input event nodes (types.ts:232-235).
- **Done looks like:** A project-level Input Actions asset defines actions and axes with keyboard, mouse and gamepad bindings, dead zones and modifiers. Players can rebind at runtime and choices persist. Input Action event and value nodes exist in scripting. Controllers consume actions, not raw key codes.
- **Verification:** The keys are hardcoded at usePlayerControls.ts:68-78. The file has 84 lines, so the cited :173-184 is wrong, but the claim stands. Grepping for getGamepads|gamepad finds only Gamepad2 lucide icons. The animation graph's input mappings (useInputHandler.ts:9-34) are turned off by enableInputs={false} at SandboxEntity.tsx:326. The Escape exit is at LevelGameLoop.tsx:228-238. A keyboard-only game is shippable, so major is right.
- **Depends on:** GAME-03

#### GAME-10 — No navigation or authorable AI; 'NavMeshVisualizer' is a boundary square

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** stub · **Complexity:** L · **Roadmap:** Phase 3
- **Evidence:** NavMeshVisualizer.tsx:8-36 draws a square outline and a tinted plane. Grepping for recast|pathfind|astar finds nothing. AI is a single hardcoded melee FSM (AIStateMachine.ts; AIConfig.ts:1-55) that moves in a straight line to the target and hard-clamps to ±boundarySize around the world origin (AIController.tsx:123-128; boundarySize=50 at LevelGameLoop.tsx:346). Perception has no line-of-sight test (AISenses.ts:27-37). AI_CONFIG is not exposed in any inspector, and AI can only target the player.
- **Done looks like:** A navmesh is baked from level colliders (for example recast-navigation) with path queries, a crowd/avoidance system and off-mesh links. AI behaviour is an asset (behavior tree or state machine plus blackboard) assignable per blueprint. Perception uses LOS raycasts. AI tuning lives in blueprint data.
- **Verification:** NavMeshVisualizer.tsx:8-36 draws a square and a tinted plane, and its only consumer is SandboxEnvironment.tsx:45. Grepping for recast|pathfind|astar|navmesh finds only that component. The hard clamp is at AIController.tsx:88-92, not :123-128 (the file is 105 lines), and distFromCenter is measured from the world origin (:66). Perception is a dot-product FOV plus distance with no raycast (AISenses.ts:20-41).
- **Depends on:** GAME-02, GAME-07

#### GAME-11 — Enemies deal no damage in level play mode

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** broken · **Complexity:** S · **Roadmap:** Phase 0
- **Evidence:** RuntimeEnemyController.handleAttack has an empty body: `if (dist < 2.5) { }` (LevelGameLoop.tsx:443-448). Damage is applied only in the Sandbox arena (SandboxWorld.tsx:81-88). In real levels the player therefore cannot die, and the 'Restart on Death' template (LevelBlueprintEditor.tsx:244-304) never triggers. SpawnConfig.team is ignored because spawned entities are always team='Enemy' (LevelGameLoop.tsx:463).
- **Done looks like:** A shared, data-driven damage system (instigator, amount and type from blueprint stats) is used by both the Sandbox and level play. Spawner team and blueprint settings are respected.
- **Verification:** LevelGameLoop.tsx:443-448 has `if (dist < 2.5) { }`, an empty body. useAIBrain.ts:57-65 does call onAttack, but it reaches this no-op. Damage works only in SandboxWorld.tsx:67-88. team='Enemy' is hardcoded at LevelGameLoop.tsx:463, and SpawnConfig.team (types.ts:78) is never read.

#### GAME-14 — No text scripting or gameplay API; only sandboxed HUD JSX

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** missing · **Complexity:** XL · **Roadmap:** Phase 3
- **Evidence:** The only user code path is HUD 'Custom' JSX compiled by Babel (DynamicHUDComponent.tsx:84-88) and evaluated in an opaque iframe (hud-frame.tsx:63). It receives only static element props (HUDCanvas.tsx:199) and has no access to entities, input, physics or events. Changing gameplay beyond the 20 node kinds means editing engine React source such as LevelGameLoop.tsx and the Sandbox hooks.
- **Done looks like:** A sandboxed script component (TypeScript/JS in a worker or QuickJS, or Lua/WASM) with a documented, versioned API covering lifecycle (start/update/fixedUpdate/destroy), entity/component access, input actions, physics queries, spawn/destroy, audio, UI and save. It has hot reload and error reporting, and visual nodes are thin wrappers over the same API.
- **Verification:** The only dynamic code paths are Babel.transform (DynamicHUDComponent.tsx:85) and new Function inside the sandboxed iframe (hud-frame.tsx:63), which receives only static props. Auvra/plugins is the provider-extension IPC (protocol.py:20 ProviderProtocolError) with no gameplay API. Major is the right level alone, since a blueprint-only engine can ship games, but this gap and GAME-03 together are blocking.
- **Depends on:** GAME-02

#### GAME-15 — Audio is static emitters plus weapon one-shots; no runtime audio API, mixer, or music

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** stub · **Complexity:** M · **Roadmap:** Phase 3
- **Evidence:** AudioSystem.tsx:84-147 creates level emitters from AudioConfig (types.ts:81-93) at mount. usePlayerCombat.ts:51-79 plays 2D weapon shots. There are no PlaySound/StopSound nodes (types.ts:232-235), no buses, master volume or settings (grepping for bus|master in AudioSystem finds none), no music or crossfade system, no animation-driven sounds (no notifies, per the animation audit), and no occlusion or reverb.
- **Done looks like:** An audio source component and Play/Stop/Fade nodes or API, including play-at-location. A mixer with buses (master/music/SFX/UI/voice) and volume settings saved per player. Music playlists with crossfade. Footstep and impact hooks via animation notifies and physics contacts.
- **Verification:** The gap is real, but one piece of evidence is wrong. AudioSystem.tsx:46 and :56 do call listener.setMasterVolume, though only as a 0/1 mute toggle driven by isMuted, so the grep for 'master' does return hits. Per-emitter loop regions and spatial falloff exist (types.ts:81-93; AudioSystem.tsx:135-194). There are no Play/Stop nodes (types.ts:232-235), no buses, no music system and no player volume settings (grepping for masterVolume|musicVolume|sfxVolume|audioSettings finds nothing).
- **Depends on:** GAME-02, GAME-03

#### GAME-16 — No particle/VFX system; only hardcoded blood burst and muzzle flash

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** stub · **Complexity:** L · **Roadmap:** Phase 3
- **Evidence:** BloodSystem.tsx:10-133 hardcodes 400 instanced red particles with gravity. Muzzle flash is a socket config (types.ts:31-39; SandboxEntity.tsx:229-234). There is no emitter asset, VFX editor or spawn-VFX node, and the only grep hits for 'particle' are in BloodSystem.tsx.
- **Done looks like:** A particle emitter asset (spawn rate/burst, lifetime, velocity/forces, color/size over life, texture/flipbook, blending) with an editor preview. A runtime GPU/instanced renderer works in both the web runtime and native. Spawn Emitter at location/attached nodes and API exist.
- **Verification:** Grepping for particle outside BloodSystem.tsx finds nothing. The 'emitter' hits are all audio_emitter. The only VFX are the blood InstancedMesh, the projectile tracers (ProjectileManager) and the socket muzzle flash (SocketController.tsx:97,288 AdditiveBlending).
- **Depends on:** GAME-02

#### GAME-17 — Animation cannot be driven by gameplay beyond variables (no montages/notifies/root motion)

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** missing · **Complexity:** L · **Roadmap:** Phase 3
- **Evidence:** Covered in depth by CHARACTER_ANIMATION_UNREAL_GAP_AUDIT.md §0: a flat state machine with Single/Blend2D, no montages, slots, layers, IK, root motion or notifies, and no skinning in the native renderer. For gameplay this means no one-shot attack, reload or interact animations from script, and no hit frames or footstep events. Enemy attacks are timer-driven (useAIBrain.ts:57-65).
- **Done looks like:** Play Montage/Stop Montage nodes and API. Animation notifies raise gameplay events. Root motion can drive the character controller. Upper/lower body layering lets the player aim while moving. See that audit's backlog for the full list.
- **Verification:** Grepping components/, hooks/ and native/src for montage|notify|rootMotion|AnimNotify|layeredBlend|playOneShot finds only unrelated comments and Rust Condvar notify calls. The enemy damage frame is timer-based (useAIBrain.ts:57-65). The animation runtime is variable-driven only (useGraphRuntime.ts:33-75).
- **Depends on:** GAME-03

#### GAME-19 — Visual scripting tooling lacks debugging, validation, undo, and sane persistence

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** missing · **Complexity:** M · **Roadmap:** Phase 3
- **Evidence:** Grepping components/LevelBlueprint for breakpoint|watch|highlight|copy|paste|comment|undo finds nothing. Errors are silent because evaluation returns null (useLevelBlueprintRuntime.ts:71-73, 197-198). Editor undo covers only levelObjects (useLevelManager.ts:141-148). Node drag calls updateBlueprint on every pointermove (LogicCanvas.tsx:178-188), which writes the whole level to the host each time (useLevelManager.ts:530-545). The canvas has an all-caps 'DO NOT CHANGE THIS LOGIC. EVER.' comment (LogicCanvas.tsx:124-129).
- **Done looks like:** A live execution trace (wire and node highlighting during play), breakpoints with step, variable watch, and a compile/validate panel with clickable errors. Graph undo/redo, copy/paste, comment boxes, a searchable palette, and persistence on drag end.
- **Verification:** Grepping components/LevelBlueprint for breakpoint|watch|highlight|copy|paste|comment|undo|ctrl|metaKey finds nothing. The only 'Search' is an icon on the reset-viewport button (LogicCanvas.tsx:259-262). Dragging calls updateBlueprint on every pointermove (LogicCanvas.tsx:174-188), which calls dbOperations.addLevel on every update (useLevelManager.ts:530-545). Undo history covers only levelObjects (useLevelManager.ts:131-148). Also missing: deleting an individual wire, and a keyboard Delete shortcut; deletion is button-only (LevelBlueprintEditor.tsx:308-316).
- **Depends on:** GAME-04

#### GAME-M1 — Hardcoded world bounds and single-terrain ground: levels larger than 200 m, or placed off-origin, are unplayable

- **Severity:** major (found by verifier) · **Kind:** broken · **Complexity:** S · **Roadmap:** Phase 3
- **Evidence:** The player is clamped to ±100 on X and Z regardless of level or terrain size (usePlayerPhysics.ts:214-215). Ground height comes from the first terrain object only, via obstacles.find(o => o.type === 'terrain') (usePlayerPhysics.ts:109), and returns 0 off that terrain (:45-47), so multi-tile or offset terrains do not work. Enemies are hard-clamped to ±boundarySize around the world origin (AIController.tsx:66, 88-92), with boundarySize fixed at 50 (LevelGameLoop.tsx:346). The AI state machine sends enemies back toward the origin once distFromCenter > boundarySize (AIStateMachine.ts:42-51). A spawner placed beyond 50 m therefore spawns enemies that snap back into the central box.
- **Done looks like:** World extents come from level data, or are unbounded. Ground queries work over every terrain tile and collider, ideally through the GAME-07 physics queries. AI bounds come from nav or level volumes, not an origin-centred square. A level with terrain at (500, 0, 500) is fully walkable, and its spawners work.
- **Depends on:** GAME-07

#### GAME-M2 — Level objects cannot move or animate at runtime (no movers, prop animation, or timeline/tween)

- **Severity:** major (found by verifier) · **Kind:** missing · **Complexity:** M · **Roadmap:** Phase 3
- **Evidence:** Play mode renders props and foliage only through InstancedLevelLayer (LevelGameLoop.tsx:303-304). That layer copies each mesh's geometry and material into an InstancedMesh (InstancedLevelLayer.tsx:40-53, 82-128) with no AnimationMixer, so animated or skinned props show a static pose. No node sets a transform or plays an animation on a level object (types.ts:232-235). Grepping components/, hooks/ and types.ts for tween|timeline|sequencer|cinematic|door|moving platform finds only a 'Cinematic Letterbox' comment in ScopeReticle.tsx:26. Doors, elevators, moving platforms, animated set-pieces and cutscene cameras cannot be built.
- **Done looks like:** Placed objects can carry an animation-player component that plays their clips and keyframes their transforms and properties. A tween/timeline asset can be triggered from script, with Play/Stop/SetTransform/MoveTo nodes and API. Kinematic movers push the character controller. Skinned props render through a non-instanced path in play.
- **Depends on:** GAME-02, GAME-03

#### GAME-M3 — Play mode is a modal replacement with no pause, step, in-play inspection, or simulate

- **Severity:** major (found by verifier) · **Kind:** missing · **Complexity:** M · **Roadmap:** Phase 3
- **Evidence:** EnvironmentEditor.tsx:68-74 returns <LevelGameLoop> instead of the editor, so the outliner, inspector and gizmos are gone during play. Escape immediately ends play (LevelGameLoop.tsx:228-238). Grepping components/Environment, components/Sandbox, hooks and App.tsx for pause|step frame|frameStep|simulate finds only AI patrol comments and audio-element pause. The only runtime feedback is PrintString toasts (useLevelBlueprintRuntime.ts:238). GAME-19 covers graph debugging only, not world-level play-in-editor iteration.
- **Done looks like:** Play runs on a cloned runtime world (see GAME-06) beside the editor panels. There is pause, resume and single-frame step, plus a live entity tree and inspector showing runtime values (health, variables, AI state), and a way to eject from the player to a free camera. Optionally, a simulate-without-player mode. Stopping play restores the authored state.
- **Depends on:** GAME-06

#### GAME-M4 — Zero automated test coverage for the gameplay runtime

- **Severity:** major (found by verifier) · **Kind:** debt · **Complexity:** M · **Roadmap:** Phase 4
- **Evidence:** tests/frontend contains only editorSession.test.ts, hudTypes.test.ts, rendererRecovery.test.ts, scrubbableInput.test.tsx and select.test.tsx. Grepping tests/frontend for useLevelBlueprintRuntime|LevelGameLoop|ProjectileManager|AIStateMachine|usePlayerPhysics|SandboxWorld|LogicCanvas|LevelBlueprint finds nothing. Bugs that a simple harness would catch shipped anyway: BeginPlay firing every frame (GAME-05), enemy damage being a no-op (GAME-11), and destroy editing the project (GAME-06).
- **Done looks like:** A headless gameplay harness steps the runtime N frames with scripted input and asserts on state. It covers blueprint execution semantics (events once, branch routing, fan-out), damage and death, spawners, overlap enter/exit, and play-mode isolation. It runs in CI next to the existing vitest suite, and the pure modules (AIStateMachine, graph evaluator, physics step) have unit tests.
- **Depends on:** GAME-01

#### GAME-18 — Gameplay tick is ad-hoc per component with no fixed step, ordering, or scaling

- **Severity:** minor (auditor: major; verifier: partial) · **Kind:** debt · **Complexity:** M · **Roadmap:** Phase 3
- **Evidence:** Every system runs its own variable-delta useFrame (PlayerController.tsx:75, AIController.tsx:76, useLevelBlueprintRuntime.ts:320, SpawnerSystem LevelGameLoop.tsx:49). The overlap pass allocates a Vector3 for every level object, foliage included, every frame, even when no overlap events exist (useLevelBlueprintRuntime.ts:341-366). Graph steps use linear nodes.find/connections.find (:78,:91,:218,:290). The native world has a fixed step (world.rs) that gameplay does not use.
- **Done looks like:** A central game loop runs a fixed-step simulation tick with explicit system phases (input, script, physics, AI, animation, late update) and a render-rate interpolation step. Triggers use a spatial index. Graphs are compiled to adjacency maps. A perf budget is validated with hundreds of entities and thousands of foliage instances.
- **Verification:** The facts are accurate: there are per-component useFrame loops, and the overlap pass allocates a new THREE.Vector3 for every level object, foliage included, each frame (useLevelBlueprintRuntime.ts:341-366). usePlayerPhysics also iterates all levelObjects each frame. Two caveats on the evidence. First, the native fixed step (world.rs:12, TICKS_PER_SECOND=60) only integrates velocity, so 'gameplay does not use it' is more a symptom of GAME-01 than its own gap. Second, a fixed-step central loop arrives with GAME-01 and GAME-07, since a physics engine needs fixed stepping. On its own this is debt with a real but modest foliage-perf cost, so it is overstated as major.
- **Depends on:** GAME-07

#### GAME-20 — No networking/multiplayer

- **Severity:** minor (auditor: minor; verifier: confirmed) · **Kind:** missing · **Complexity:** XL · **Roadmap:** Deferred (§5)
- **Evidence:** Grepping frontend sources for WebSocket|RTCPeer|multiplayer|netcode|replicat returns 0 hits, and native/src has no networking. This is acceptable for a first single-player-capable release at the Godot/early-Unity indie bar.
- **Done looks like:** Later: a transport layer (ENet/WebRTC/WebSocket), entity replication with authority, RPC nodes and API, and lobby/session hooks.
- **Verification:** There is no gameplay networking in the frontend or native code. Deferring it is acceptable at the stated bar.
- **Depends on:** GAME-01, GAME-02

#### GAME-21 — No automated tests for any gameplay runtime

- **Severity:** minor (auditor: minor; unverified (minor, not sent to verifier)) · **Kind:** debt · **Complexity:** M · **Roadmap:** Phase 4
- **Evidence:** fbx-viewer (1)/tests/frontend contains only editorSession, hudTypes, rendererRecovery, scrubbableInput and select tests. Grepping tests for useLevelBlueprintRuntime|LevelGameLoop|usePlayerPhysics|AIStateMachine|ProjectileManager returns nothing.
- **Done looks like:** Headless tests cover graph execution semantics (events, branching, loops, variables), play-session isolation, the damage/death flow, spawner limits, and controller collision. A deterministic replay test runs a scripted level for N ticks.
- **Depends on:** GAME-05, GAME-06

#### GAME-22 — Misleading or dead gameplay scaffolding

- **Severity:** minor (auditor: minor; verifier: confirmed) · **Kind:** claim-mismatch · **Complexity:** S · **Roadmap:** Phase 0
- **Evidence:** SocketLogicController.tsx is never rendered (SandboxEntity.tsx:312 says it was replaced). Default traits 'InventorySystem' and 'QuestLog' (player.ts:117) imply systems that do not exist. The blueprint stats 'Walk Speed', 'Run Speed' and enemy 'Speed' (player.ts:114-115, enemy.ts:66) are never read. NavMeshVisualizer is not a navmesh. Animation graph Input Mappings are preview-only (SandboxEntity.tsx:326).
- **Done looks like:** Remove the dead code, and either implement or remove the placeholder traits and stats. Rename or label the boundary visualizer, and make the UI state clearly what is editor-preview-only.
- **Verification:** SocketLogicController is referenced only by its own file and by a comment at SandboxEntity.tsx:312. The 'Walk Speed', 'Run Speed' and 'Stamina' stats (player.ts:113-115) and the enemy 'Speed' stat (enemy.ts:66) are never read. A 'Speed' graph variable exists, but it is a different thing (player.ts:5). The traits are cosmetic, as noted under GAME-02.

### 7.4 Platform, tooling and shipping

*Audited:* Platform, tooling and shipping (Python host, launcher, desktop frame, project format, providers, plugins, diagnostics, release/, CI, protocol, tests, docs, licensing)

Auvra's dev tooling is careful work. It has a hardened launcher (doctor/prepare/start/clean/support/diagnostics), a versioned host protocol with JSON Schema, generated TS/Python bindings and conformance vectors, and a transactional, journaled project repository with recovery points and .auvrapack import/export. Diagnostics are bounded and redacted, the editor MSIX pipeline is deterministic, there are about 370 Python tests, and CI runs a real WebView2 project-lifecycle smoke. But a user cannot ship a game. No export, build-player or cook-for-target path exists anywhere: not in the editor UI, the launcher CLI, the host protocol or release/. Gameplay exists only as the editor's in-tab Sandbox, which is bound to editor SceneContext and loads all data through the WebView2 host transport. The native Rust binary is an editor-owned IPC child that exits without a session token and has no input, audio, physics or scripting. The only release pipeline packages the editor itself (entry point runtime/python/pythonw.exe, Windows 11 24H2 x64 only). Reading the code (nothing was run) suggests even that MSIX breaks on first use, because the protocol/v1 and project/v1 JSON schemas are loaded from repo-relative paths and are never staged into the package. Other major problems: the editor is Windows-only; the plugin system covers AI providers only and is not wired into the host, despite what README says; the project format has no migration path past schemaVersion 1 and is hostile to version control; asset identity is a content hash with no reimport. Also: the frontend has 7 test cases for about 25k LOC, there are no docs, samples or templates, and third-party license notices are not shipped. AI providers (fal.ai etc.) are optional add-ons used only by the HUD AI chat panel and texture generation; they are not a core dependency.

**What exists:**

- **[solid]** Python development launcher (bootstrap of locked uv env, npm ci, loopback Vite, port selection, process-tree ownership, clean/support/diagnostics commands, stable exit codes) — Auvra/launcher/cli.py:51-70 (start/doctor/prepare/clean/support/diagnostics subparsers); Auvra/launcher/bootstrap.py (stdlib bootstrap); Auvra/launcher/platform/windows_job.py; tests/launcher (73 tests)
- **[solid]** WebView2 desktop editor frame and host controller (Windows only) — Auvra/desktop/webview2.py:301-304,358-360 (Windows-only guards), Auvra/desktop/controller.py:580-628; CI job native-project-smoke runs tests.desktop.test_native_smoke against a real WebView2 (.github/workflows/verify.yml native-project-smoke)
- **[solid]** Versioned host protocol v1 (JSON Schema, generated TS + Python bindings, conformance vectors, fake host) — protocol/v1/auvra-host.schema.json:23 (method enum), protocol/v1/conformance.json, fbx-viewer (1)/scripts/protocol/generate.mjs, Auvra/host/generated/protocol_v1.py, tests/host/test_conformance.py
- **[solid]** Transactional project repository (journaled atomic writes, writer lock and read-only fallback, manual/autosave recovery points, cross-domain reference validation, unreferenced-asset pruning, .auvrapack export/import, legacy .forge import) — Auvra/project/repository.py:274-304 (transaction journal), :231-236 (prune), Auvra/project/locking.py, Auvra/project/schemas.py:111-170 (reference validation), Auvra/project/archive.py, Auvra/project/legacy.py; tests/project (51 tests)
- **[basic]** Content-addressed asset store (sha256-named blobs, MIME sniffing, manifest) — Auvra/project/assets.py:33-37 (digest is the asset id and on-disk name), :72-81, :190-195 (single Content/manifest.json)
- **[basic]** Editor MSIX release pipeline (deterministic assembly, hashed release manifest, content and secret scanning, CycloneDX SBOM, AppInstaller metadata, MakeAppx/SignTool helpers, offline packaged-startup verification, CI unsigned dev artifact) — release/pipeline.py:603-665 (_assemble_into), :323-349 (AppxManifest, Executable=runtime/python/pythonw.exe, 'Auvra game engine'), :750 make_msix, :775 sign_msix; .github/workflows/verify.yml release-dev-msix job. Packages the editor only; see PLAT-08 for the schema-staging defect
- **[stub]** release/asset_cooking.py 'asset cooking' — release/asset_cooking.py:42-91 only copies files and canonicalizes JSON. It is called only from tests (grep 'cook_assets' hits only tests/release/test_release_pipeline.py:14,411), not from the pipeline or CI
- **[basic]** Native asset cooker (validates glTF/GLB, parses ASCII FBX into the editor's derived cache) — native/src/assets.rs:463-478 (cook_source), :831-1046 (glTF validation), :1472 (parse_fbx); no texture compression or per-platform variants
- **[basic]** Native runtime process (wgpu viewport, deterministic world, IPC) — native/src/main.rs:3321-3340 (exits code 2 without AUVRA_NATIVE_SESSION_TOKEN; modes are only IPC, --self-test, --headless-self-test). IPC methods are only world.*, renderer.*, viewport.*, asset.*. CI builds and runs the headless self-test on ubuntu and windows
- **[basic]** In-editor play mode (Sandbox tab) — fbx-viewer (1)/App.tsx:26 (activeTab union includes 'sandbox'), :136-139 (<SandboxScene/> as an editor tab); components/Sandbox/SandboxWorld.tsx:15,58 (reads editor useScene context)
- **[solid]** Local diagnostics (bounded, redacted logs, crash markers, support bundle, frontend diagnostics boundary) — Auvra/diagnostics/core.py; Auvra/launcher/diagnostics.py:65,238-264 (crash marker, record_diagnostics_crash); fbx-viewer (1)/diagnostics/RuntimeDiagnosticsBoundary.tsx; tests/diagnostics (22 tests)
- **[basic]** AI provider integrations (fal.ai media; OpenAI/Anthropic/xAI/OpenRouter/Ollama/llama.cpp text/code/commands), Credential Manager storage. Optional, not a core dependency — Auvra/providers/*.py, Auvra/desktop/provider_host.py. Frontend consumers are only components/HUDEditor/AIChatPanel.tsx:4, hooks/useTextureGeneration.ts:4 via services/TextureGenerationService.ts, and components/Settings/SettingsModal.tsx. Credentials are Windows-only (providers/credentials.py:57)
- **[stub]** Provider plugin SDK (.auvraplugin signed packages, AppContainer worker, permission grants, revocation) — Auvra/plugins/*.py implemented and tested (tests/plugins/test_sdk.py, 18 tests), but nothing outside Auvra/plugins imports it (grep -rn 'plugin' Auvra --include=*.py excluding Auvra/plugins/ returned no hits) and the protocol has no plugin.* method (auvra-host.schema.json:23)
- **[solid]** CI (editor typecheck/test/build on Node 22/24; Python 3.12/3.14 on Windows and Ubuntu; native fmt/test/build/headless self-test on Windows and Ubuntu; real WebView2 project-lifecycle smoke; unsigned dev MSIX assemble/verify/startup smoke) — .github/workflows/verify.yml (5 jobs, 312 lines). No macOS job, no game export, no play-mode/gameplay test, no lint (no eslint script in fbx-viewer (1)/package.json, no clippy step)
- **[basic]** Test suites — Python: about 372 test_ methods (desktop 122, launcher 73, project 51, host 35, providers 33, diagnostics 22, plugins 18, release 18). Rust: 44 #[test]. Frontend: 7 it/test cases across 5 files in fbx-viewer (1)/tests/frontend (about 110 LOC) plus verify scripts that are mostly regex checks on source text (scripts/project/verify.mjs:40-75, 178 regex/includes checks)
- **[basic]** Licensing artifacts — LICENSE (Apache-2.0); native/THIRD_PARTY_NOTICES.md (5 direct crates only); SBOM component identities from npm/cargo/uv locks (release/pipeline.py:386-456)

#### PLAT-01 — No game export / build-player pipeline anywhere (UI, CLI, protocol, release)

- **Severity:** blocker (auditor: blocker; verifier: confirmed) · **Kind:** missing · **Complexity:** L · **Roadmap:** Phase 1
- **Evidence:** The grep for export.?game|build.?player|standalone|player.?build|game.?build|runtime.?only|build.?game|target.?platform across the repo hit only the .auvrapack project export (hooks/useProjectManager.ts:154, components/UI/Header.tsx:155 'Export an .auvrapack project') and unrelated 'standalone' identifiers. Launcher subcommands are start/doctor/prepare/clean/support/diagnostics only (Auvra/launcher/cli.py:51-70). The host protocol method enum has no build or export-game method (protocol/v1/auvra-host.schema.json:23). The release pipeline builds only the editor MSIX (release/pipeline.py:343 Executable=runtime/python/pythonw.exe, policy.json product 'Auvra').
- **Done looks like:** A 'Build Game' action in the editor plus a headless CLI (e.g. `auvra build --project X --target windows-x64|web|linux-x64 --out dir`) backed by a host method. It validates the project, cooks and packs reachable content, copies the player runtime for the target, writes game identity (name, version, icon, company), and produces a runnable folder/zip or installer with no editor, Python, Node, providers or dev tooling. A CI job builds a sample project and launches the result headlessly.
- **Verification:** I re-ran the grep `export.?game|build.?player|player.?build|game.?build|build.?game|target.?platform|runtime.?only|playerBuild|exportGame|shipping` over *.py/*.ts/*.tsx/*.rs/*.json/*.ps1/*.yml/*.md, excluding node_modules/.venv/target/dist. It returned 0 hits. The launcher subparsers are only start/doctor/prepare/clean/support/diagnostics (Auvra/launcher/cli.py:51-77). The protocol method enum (protocol/v1/auvra-host.schema.json:23) has project.exportPack (an .auvrapack project archive) and no build or export-game method. release/pipeline.py:343 sets the editor entry point, runtime/python/pythonw.exe. No alternate name or path turned up anywhere.
- **Depends on:** PLAT-02, PLAT-03, PLAT-04

#### PLAT-02 — No standalone player runtime: gameplay only runs inside the editor's Sandbox tab over the WebView2 host

- **Severity:** blocker (auditor: blocker; verifier: confirmed) · **Kind:** missing · **Complexity:** L · **Roadmap:** Phase 1
- **Evidence:** Play mode is an editor tab (fbx-viewer (1)/App.tsx:26,136-139) and reads editor state (components/Sandbox/SandboxWorld.tsx:15,58 useScene). All project data comes through the WebView2 host transport (host/bootstrap.ts:14-16 window.chrome.webview; utils/projectService.ts:1). Vite builds only the 'editor' and 'hud' entries (vite.config.ts:63-67). The native binary refuses to start without AUVRA_NATIVE_SESSION_TOKEN and has only IPC/self-test modes (native/src/main.rs:3321-3340). Grepping native/src for audio|sound, rapier|collider|rigid and KeyboardInput|MouseInput|gamepad returned 0 hits, so it cannot run gameplay either.
- **Done looks like:** A runtime-only player entry (e.g. player.html/player.tsx, or a native host) that boots from a cooked game pack and runs the startup level with the same gameplay code as play mode (Sandbox, level blueprints, physics, AI, animation, HUD), with no editor UI, Python, provider code or host protocol. Sandbox is refactored to depend on a runtime data interface instead of SceneContext and projectService. A thin desktop shell (e.g. a minimal WebView2/WebKit wrapper or Tauri-style exe) runs it fullscreen or windowed. Play-in-editor and the shipped player share one code path.
- **Verification:** Confirmed. The evidence is incomplete, though. Level play actually runs in a second path, LevelGameLoop inside the Environment editor (components/Environment/EnvironmentEditor.tsx:70). It is the only path that runs level blueprints (useLevelBlueprintRuntime is imported only by LevelGameLoop.tsx:23). The Sandbox tab is a separate fixed arena (SandboxScene.tsx:30 useSandboxGame({playerModel, enemyModel})). Both read editor SceneContext (LevelGameLoop.tsx:95; SandboxWorld.tsx:58; PlayerController.tsx:39; SandboxEnvironment.tsx:13). A production frontend without WebView2 throws 'Auvra requires the packaged WebView2 host' (host/bootstrap.ts:27). FakeHost is DEV-only and in-memory. Vite inputs are only editor and hud (vite.config.ts:63-67). In native/src, the grep for audio/sound/rapier/collider/rigid/KeyboardInput/MouseInput/gamepad has 0 hits. winit is used only for window close/resize/redraw (main.rs:635-644).

#### PLAT-03 — No shipping asset cook/pack step (reachability, format conversion, editor-data stripping, packed archives)

- **Severity:** major (auditor: blocker; verifier: partial) · **Kind:** stub · **Complexity:** L · **Roadmap:** Phase 1
- **Evidence:** release/asset_cooking.py:42-91 copies files verbatim and only canonicalizes JSON; it is used only by tests (grep cook_assets: tests/release/test_release_pipeline.py:14,411). The native cooker writes an editor-local derived cache and validates glTF/GLB/ASCII FBX (native/src/assets.rs:463-478,831,1472), with no texture compression or platform variants. Custom HUD code is compiled at runtime with @babel/standalone (components/HUDEditor/DynamicHUDComponent.tsx:2) under a CSP that allows 'unsafe-eval' (vite.config.ts:8).
- **Done looks like:** A cook step driven by the asset dependency graph from the startup and included levels. It converts sources to runtime formats (GLB, KTX2/Basis or platform-compressed textures, compressed audio), precompiles HUD/blueprint code so the player needs no Babel or eval, strips editor-only data (provider provenance, AI job metadata, editor camera/selection, recovery data), and writes a versioned, hashed pack (archive + manifest) per target. It is incremental, deterministic and covered by a test that cooks a sample project and loads it in the player.
- **Verification:** The facts are right. release/asset_cooking.py:42-91 copies bytes and canonicalizes JSON, and only tests use it (tests/release/test_release_pipeline.py:14,411). The native cooker (native/src/assets.rs:463-831) validates glTF/GLB/ASCII FBX into a derived cache, with no ktx/basis/compression. The HUD CSP has 'unsafe-eval' (vite.config.ts:8, hudPackagedCsp). The severity is overstated. A first shippable player on the existing Three.js/WebGL2 stack could load the original GLB/PNG/OGG content-addressed blobs as they are and keep Babel. The blocker part (collect reachable Content/sha256 blobs and Project/*.json into the build) belongs to PLAT-01's build step. Texture compression, HUD precompilation and editor-data stripping are optimization and hardening, so this is major, not blocker.
- **Depends on:** PLAT-11

#### PLAT-04 — No game-level project settings (startup level, app identity, window/input/quality defaults)

- **Severity:** major (auditor: blocker; verifier: partial) · **Kind:** missing · **Complexity:** M · **Roadmap:** Phase 1
- **Evidence:** The project descriptor schema allows only format/schemaVersion/projectId/name/revision/createdAt/updatedAt (project/v1/project.schema.json, additionalProperties:false). The grep for startScene|startupLevel|defaultLevel|mainLevel|inputMap|actionMap|keyBindings|gameSettings|windowMode|vsync hit only the editor's implicit 'default_level' creation (hooks/useLevelManager.ts:289, hooks/useScenePersistence.ts:884). metadata.schema.json has only a free-form 'settings' object.
- **Done looks like:** A versioned project-settings domain edited in an editor panel: game title, version, company, icon, startup level and level list, default resolution/fullscreen/vsync, quality presets, an input action map (keyboard/mouse/gamepad), audio bus defaults and target platforms. It is validated by schema and consumed by both the exporter and the player runtime.
- **Verification:** No game-identity or startup-level settings exist: project.schema.json allows only format/schemaVersion/projectId/name/revision/createdAt/updatedAt, with additionalProperties:false. Some pieces exist in reduced form. The worlds schema has an ordered `levels` list plus msaaSamples/fxaa quality fields (project/v1/worlds.schema.json). Animation graphs carry per-graph keyboard InputBindings (key/Press|Release|Hold to a blackboard variable) (components/AnimationGraph/panels/BlackboardInputs.tsx:22-28). Player movement is hard-coded to e.code 'KeyW' etc. (components/Sandbox/hooks/usePlayerControls.ts:27,68). There is no gamepad support: the grep for getGamepads/gamepad returned only lucide icons. The startup level and title could be build-profile fields of PLAT-01, so this is major, not a standalone blocker.

#### PLAT-05 — No player-facing runtime shell: settings/options menu, input rebinding, save-game API, player crash reporting

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** missing · **Complexity:** M · **Roadmap:** Phase 1
- **Evidence:** The grep for savegame|save_game|saveSlot|checkpoint|localStorage in components/Sandbox, components/LevelBlueprint and hooks returned no hits. The grep for 'main menu|pause menu|options menu|graphics settings' in components returned no hits. Crash markers exist only for the editor launcher (Auvra/launcher/diagnostics.py:252-264).
- **Done looks like:** A runtime library with: persisted player settings in a per-user directory (resolution, fullscreen, volume buses, input rebinding); a save-slot API exposed to blueprints (write/read/list/delete, versioned); default main/pause/options menu templates in the HUD editor; and a player crash handler that writes a local log/minidump and shows a dialog, with no editor dependency.
- **Verification:** I re-grepped savegame|save_game|saveSlot|checkpoint|localStorage|indexedDB in components/Sandbox, LevelBlueprint, Environment and useLevelBlueprintRuntime: 0 hits. The only indexedDB use is a read-only legacy importer (utils/db.ts:65). The level-blueprint runtime node set is Branch/DestroyActor/LevelAction/PrintString/VariableSet plus math and logic nodes, with no persistence node (grep of type === and case labels in hooks/useLevelBlueprintRuntime.ts). There is no pause or options menu.
- **Depends on:** PLAT-02, PLAT-04

#### PLAT-06 — Only target is Windows 11 24H2 x64; no web, Linux, macOS, Windows 10, mobile or console target

- **Severity:** major (auditor: major; verifier: partial) · **Kind:** missing · **Complexity:** L · **Roadmap:** Phase 1
- **Evidence:** release/policy.json: platform 'win-x64', minimumWindowsBuild 26100. AppxManifest TargetDeviceFamily MinVersion=10.0.26100.0 (release/pipeline.py:340-341). runtime_verify.py:17 MIN_WINDOWS_BUILD=26100. Applied to a shipped game, this baseline would exclude every Windows 10 and pre-24H2 Windows 11 player. There is no web, mobile or console tooling anywhere.
- **Done looks like:** The player runtime ships at minimum for Windows 10/11 x64 and the web (WebGL2, which the Three.js runtime already targets), then Linux and macOS desktop wrappers. Each target has a CI job that builds a sample project and smoke-runs it. Minimum OS requirements for a game are set per target, not inherited from the editor's Windows 11 24H2 requirement.
- **Verification:** The evidence (release/policy.json minimumWindowsBuild 26100; pipeline.py:340-341 MinVersion 10.0.26100.0; runtime_verify.py:17) describes the editor package, not a game target. No game target exists at all, which is PLAT-01. The real gap is the missing target matrix for exported players (Win10/11 x64, web, Linux and macOS). That is major and overlaps PLAT-01/02. Some groundwork exists: the native engine already builds and runs cargo tests plus a headless self-test on ubuntu-latest (.github/workflows/verify.yml:100-136), and WebGL2 is the stable render path (README.md:112-121).
- **Depends on:** PLAT-02, PLAT-03

#### PLAT-07 — Editor runs only on Windows 11 24H2 x64 (WebView2 via pythonnet/WinForms; plugins and credentials Windows-only)

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** missing · **Complexity:** XL · **Roadmap:** Deferred (§5)
- **Evidence:** README.md:25 states the requirement. Auvra/desktop/webview2.py:301-304 and :358-360 raise 'available on Windows only'. Auvra/plugins/worker.py:42-48 and :72 (AppContainer), plugins/security.py:58 (CNG verify returns False off Windows) and providers/credentials.py:57 are also Windows-only. The CI python job runs on ubuntu, but the frame tests cannot run there. There is no macOS CI job (.github/workflows/verify.yml).
- **Done looks like:** The editor launches on macOS and Linux through a portable webview host (or a loopback browser mode with an equivalent authenticated host transport). It uses OS keychains (Keychain, libsecret) for credentials and portable plugin isolation. The CI matrix includes macOS, and the native runtime is built and tested on all three OSes.
- **Verification:** I verified the evidence. webview2.py:301-304 and :358-360 raise on non-nt. plugins/worker.py:42-48 requires Windows 11 24H2 AppContainer. security.py:58 returns False off win32. credentials.py:57 raises CredentialError off win32. The only non-Windows path is `npm run dev` with the in-memory FakeHost (host/fakeHost.ts:13; bootstrap.ts:20-24), which has no persistence and which the frontend README says does not exercise the host boundary. CI already builds and tests the native crate on ubuntu (verify.yml:100-136), so the Linux part of the native runtime is partly done. Major, not blocker: Windows-only editors can still ship games.

#### PLAT-08 — Packaged editor MSIX does not include the protocol or project JSON schemas the host loads at runtime (likely breaks on first host message or project create)

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** broken · **Complexity:** S · **Roadmap:** Phase 0
- **Evidence:** Auvra/host/validation.py:15 resolves SCHEMA_PATH = parents[2]/'protocol'/'v1'/'auvra-host.schema.json', and Auvra/project/schemas.py:21 resolves SCHEMA_DIR = parents[2]/'project'/'v1'. In the package these resolve to <pkg>/host/protocol and <pkg>/host/project. CI stages only the Auvra/ package as host input (.github/workflows/verify.yml:255-258), and no release code references protocol or project/v1 (grep in release/*.py, release/*.ps1 and verify.yml found only the npm protocol:verify step). Release tests stage only host/Auvra (tests/release/test_release_pipeline.py:100-102). On navigation the controller posts a session envelope (Auvra/desktop/controller.py:624-628) through validate_message (Auvra/desktop/webview2.py:261-268), which lazily opens SCHEMA_PATH (validation.py:70-74). The release smoke only asserts frame and native READY and never sends a request or creates a project (tests/desktop/test_release_smoke.py:115-121). This is a static inference and was not executed.
- **Done looks like:** Schemas are loaded as package resources (importlib.resources or bundled inside Auvra/), or staged by stage_inputs.ps1/pipeline with manifest checks. The packaged smoke test performs host.ping, project.create, save, close and open against the unpacked MSIX and fails if any schema is missing.
- **Verification:** I verified this statically. In the package, host input goes to <pkg>/host/Auvra/... (pipeline.py:623-627), so validation.py:15 parents[2] resolves to <pkg>/host/protocol/v1/... and schemas.py:21 to <pkg>/host/project/v1. Neither is staged: _assemble_into (pipeline.py:605-633) and stage_inputs.ps1 copy no protocol or project dir, and CI copies only Auvra/ (verify.yml:255-258). Auvra/host/generated holds only protocol_v1.py, with no embedded schema. The failure is not caught. validate_message lazily opens SCHEMA_PATH (validation.py:70-74), and its callers in webview2.py:261-268 catch only ProtocolValidationError, so a FileNotFoundError escapes. controller._post (controller.py:580-586) catches only FrameClosedError. The test gap is worse than the auditor said. The packaged smoke runs under `uv run` from the repo (verify.yml:288-289), so it imports the repo's Auvra, where the schemas resolve. The packaged interpreter only runs the non-UI smoke, which exits before importing the app (pipeline.py:551-552).

#### PLAT-10 — Project layout is hostile to version control despite the 'reviewable JSON' claim

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** claim-mismatch · **Complexity:** M · **Roadmap:** Phase 2
- **Evidence:** README.md:97 claims 'reviewable JSON documents'. Every document is written as single-line minified JSON (Auvra/project/serialization.py:24-26, separators=(',',':')). Each domain is one file holding all its documents, e.g. every object of every level in Project/objects.json (Auvra/project/repository.py:203). Every transaction rewrites revision and updatedAt in the tracked <name>.auvra descriptor (repository.py:290), so any two branches conflict. All asset metadata lives in one Content/manifest.json (Auvra/project/assets.py:190-195). No .gitattributes or LFS setup is generated (grep 'gitattributes|lfs' in Auvra returned no hits); only a .gitignore for .auvra/ is written (repository.py:79).
- **Done looks like:** Pretty-printed, stably ordered JSON. One file per level, blueprint, graph, HUD and material. No volatile counters or timestamps in tracked files (runtime revision moves into .auvra/). Per-asset metadata sidecars instead of a monolithic manifest. A generated .gitattributes with LFS rules for Content/. A documented team git workflow, and a test showing two branches editing different levels merge without conflict.
- **Verification:** Verified. canonical_json uses separators=(',',':') and sort_keys=True (serialization.py:23-26). Keys are stably ordered, but each domain is one line. One file per domain (repository.py:203, Project/{domain}.json) puts every object of every level, including inline terrain heights, in objects.json. Every transaction writes revision and updatedAt into the tracked descriptor (repository.py:290). The only VCS scaffolding is a .gitignore of .auvra/ (repository.py:79), and the grep gitattributes|lfs in Auvra has 0 hits. For a small team on git, every concurrent commit conflicts on the .auvra descriptor.
- **Depends on:** PLAT-09

#### PLAT-11 — Asset database lacks stable GUIDs, source tracking, reimport, import settings and dependency queries

- **Severity:** major (auditor: major; verifier: partial) · **Kind:** missing · **Complexity:** L · **Roadmap:** Phase 2
- **Evidence:** Asset identity is the sha256 of the bytes (Auvra/project/assets.py:33-37 'The digest is the stable opaque asset handle', :72), so changing a source file creates a new id and every referencing document must be rewritten by hand. The grep for reimport|importSettings|import_settings|sourcePath|source_path in Auvra/project returned no hits. Dependency knowledge is limited to referenced_asset_ids for pruning (repository.py:231-236) and forward reference validation (schemas.py:111-170); there is no reverse lookup ('what uses this').
- **Done looks like:** Stable asset GUIDs decoupled from content hash, with content hash kept as a version. Each asset records its source path and import settings. Changed source files are detected for reimport/hot-reload. There is a queryable forward and reverse dependency graph, used by the editor ('find references', safe delete, rename) and by the cooker for reachability.
- **Verification:** The evidence misreads the identity model. Content hashes are not referenced from everywhere. There is a stable logical-ID layer: models/textures/audio/animations documents have their own `id` and a single `assetId` hash field (project/v1/models.schema.json). Objects, sockets, attachments, animations and blueprints reference modelId/textureId/audioId, the stable document ids (schemas.py:134-161). Swapping a source file therefore means changing one assetId field, not rewriting every referencing document. Forward reference validation also already blocks deleting a referenced model. What is genuinely missing: source-path tracking, import settings, a reimport UI (the frontend grep for reimport|replaceModel|replaceSource|hot.?reload|findReferences|usedBy has 0 hits) and reverse 'what uses this' queries. Still major for art iteration, but smaller effort than claimed (M, not L).

#### PLAT-15 — Test depth does not cover gameplay, play mode or end-to-end authoring; frontend gates are mostly source-regex checks

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** debt · **Complexity:** L · **Roadmap:** Phase 4
- **Evidence:** The frontend has 7 it/test cases across 5 files (fbx-viewer (1)/tests/frontend: editorSession, hudTypes, rendererRecovery, scrubbableInput, select) for about 25k LOC. Sandbox, level-blueprint runtime, physics/AI, animation graph runtime and HUD runtime have no behavioral tests. scripts/project/verify.mjs reads 48 source files and applies about 178 regex/includes checks (e.g. :56-75). There is no lint script in package.json and no clippy step in CI. No test exercises author, play, export and run.
- **Done looks like:** Unit tests for the blueprint interpreter, animation state machine, AI/navigation and physics glue. Deterministic headless play tests (fixed-step replay of a sample level with golden state hashes). An E2E smoke (browser mode or WebView2) covering import, place, play and export, then launching the exported player. Regex gates replaced by behavioral tests where possible, and ESLint plus clippy enforced in CI.
- **Verification:** Verified: 7 it/test cases across 5 vitest files (grep -c over tests/frontend). scripts/project/verify.mjs has 178 readFileSync/includes/match checks. package.json has no lint script, and verify.yml has no clippy or eslint step. For context, CI does run 44 Rust #[test]s plus headless deterministic replay and self-test on windows and ubuntu (verify.yml:124-142). That covers the native world but none of the Three.js gameplay path (Sandbox, LevelGameLoop, blueprint runtime, AI, physics, HUD).
- **Depends on:** PLAT-01

#### PLAT-16 — No user documentation, tutorials, sample projects or new-project templates

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** missing · **Complexity:** L · **Roadmap:** Phase 4
- **Evidence:** find for docs|doc|samples|examples|templates|tutorial*|demo* directories (depth 3, excluding node_modules/.venv/target) returned nothing. README.md covers only dev setup and says architecture docs are kept outside the repo (README.md:20). project.create accepts only name and parentHandle (protocol/v1/auvra-host.schema.json $defs.projectCreatePayload), so there is no template choice. The only starter content is two default blueprints (fbx-viewer (1)/data/blueprints/index.ts:5-8).
- **Done looks like:** A user manual (editor tour, importing, levels, blueprints node reference, physics, audio, HUD, animation, play mode, building a game), a getting-started tutorial, 2-3 sample projects (e.g. third-person action, FPS arena) kept loadable by CI, new-project templates selectable in project.create, and a contributor architecture overview in the repo.
- **Verification:** I ran find at depth 4 for *doc*/*sample*/*example*/*template*/*tutorial*/*demo*/*starter* dirs: nothing. The only .md files are README, REFACTOR, findings, the animation audit, the frontend README and native THIRD_PARTY_NOTICES. tests/fixtures holds only fake_child.py, with no sample project. projectCreatePayload is {name, parentHandle} only (auvra-host.schema.json:64). Starter content is just data/blueprints/{player,enemy}.ts.
- **Depends on:** PLAT-04

#### PLAT-M1 — Every project edit re-hashes every referenced asset and re-validates and rehydrates the whole project, so edit latency grows with total asset bytes

- **Severity:** major (found by verifier) · **Kind:** broken · **Complexity:** S · **Roadmap:** Phase 2
- **Evidence:** ProjectHost._apply builds a candidate of all DOMAIN_NAMES and calls _validate_native_candidate, which pages the whole project to native in 48 KB frames. After commit it calls _hydrate_native again (Auvra/desktop/project_host.py:651-673; native_engine.py:986-1040). ProjectRepository.apply_changes calls validate_project_references(candidate, asset_exists=self.assets.verify) (Auvra/project/repository.py:258-263). That loops over every asset handle in every domain (Auvra/project/schemas.py:165-170). AssetStore.verify streams and SHA-256-hashes the full file each time (Auvra/project/assets.py:92-99). One object move or property tweak therefore re-reads and hashes every referenced FBX/GLB/texture/audio blob, with repeats for shared handles, and also rewrites the whole domain file with fsync. Static inference, not timed.
- **Done looks like:** Reference validation checks existence plus the recorded size from the manifest. Full hash verification runs only on ingest, open, explicit repair and pack export. applyChanges validates only the changed documents and their outgoing references, and native receives incremental changes instead of a full re-validate and rehydrate. A perf test with a 1 GB/5k-object fixture project asserts applyChanges p95 under 50 ms.

#### PLAT-M2 — Per-document transport cap (192 KB to load, 256 KB to save) and inline terrain heightfields: large or sculpted terrains fail to save, or save but cannot be reopened

- **Severity:** major (found by verifier) · **Kind:** broken · **Complexity:** M · **Roadmap:** Phase 0
- **Evidence:** Every host message is capped at 256 KiB (Auvra/host/validation.py:29; host/nativeTransport.ts:6,122; host/protocol.ts:8). The frontend sends one whole document per applyChanges (utils/useNativeProjectDocument.ts:151-154), with no compaction (utils/projectService.ts:379-386). Snapshot load uses a 192 KiB soft limit and fails with 'A project document exceeds the transport limit' when one document does not fit (Auvra/desktop/project_host.py:38,624-628). Terrain heights are stored inline in the objects document (schemas.py:29 terrainData.heights). TerrainSculptor pushes every vertex Z as a JS double (components/Environment/Terrain/TerrainSculptor.tsx:202-206). The default resolution is 128 and the slider max is 512 (EnvironmentInspector.tsx:36,136), giving 129x129=16,641 to 263,169 vertices. At 512 even an unsculpted terrain is about 526 KB. A mostly sculpted 128 terrain (about 200 KB) passes the 256 KB save cap but fails the 192 KB reopen limit.
- **Done looks like:** Heightfields, and any bulk numeric data such as navmesh or baked data, are stored as binary content-addressed assets referenced by assetId. The transport supports chunked document transfer, or the host rejects oversize writes with the same limit it enforces on load. A test sculpts a 512x512 terrain, saves, closes and reopens it successfully.

#### PLAT-M3 — No runtime level transitions or game flow (open level, title screen to level 1 to level 2)

- **Severity:** major (found by verifier) · **Kind:** missing · **Complexity:** M · **Roadmap:** Phase 1
- **Evidence:** The level-blueprint runtime's only flow node is LevelAction with 'Restart' and 'EndGame' (fbx-viewer (1)/hooks/useLevelBlueprintRuntime.ts:247-258). The full node set (grep of case/type === labels) has no OpenLevel/LoadLevel/ChangeLevel. loadLevel exists only as an editor action (hooks/useLevelManager.ts:362), invoked from the editor sidebar (components/Environment/EnvironmentSidebar.tsx:140). LevelGameLoop plays only the editor's current level (LevelGameLoop.tsx:95 useScene().levelObjects/activeLevelBlueprint). The grep for loadLevel|openLevel|changeLevel|switchLevel|nextLevel|streamLevel in gameplay code found only these editor hits.
- **Done looks like:** A runtime level service, independent of editor SceneContext, can unload the current level and load another by id with a loading state. It is exposed as an OpenLevel blueprint node and a HUD button action, can carry persistent game state across levels, and starts from the project's startup level (PLAT-04). Play-in-editor and the exported player use it, with a test that transitions between two fixture levels.
- **Depends on:** PLAT-02, PLAT-04

#### PLAT-M4 — Play mode is split into two unrelated runtimes, and authored HUDs are rendered by neither

- **Severity:** major (found by verifier) · **Kind:** broken · **Complexity:** M · **Roadmap:** Phase 1
- **Evidence:** The Sandbox tab is a fixed 1v1 arena (components/Sandbox/SandboxScene.tsx:30 useSandboxGame({ playerModel, enemyModel })) that does not run level blueprints. Level play is a separate LevelGameLoop inside the Environment editor (components/Environment/EnvironmentEditor.tsx:70) that re-wires PlayerController/AIController/ProjectileManager itself (LevelGameLoop.tsx:13-23). useLevelBlueprintRuntime is imported only there. The authored HUD pipeline (HUDCanvas/componentRegistry/DynamicHUDComponent) is imported only by HUDEditor.tsx:3,7 and HUDLibrary.tsx:4 (grep for imports of HUDCanvas|componentRegistry|DynamicHUDComponent), so neither play path shows the user's HUD. Play uses the hard-coded SandboxUI instead (LevelGameLoop.tsx:17).
- **Done looks like:** One play-in-editor entry point plays the current or startup level through a single runtime composition: level objects, level blueprint, actor blueprints, physics/AI, audio and the project's authored HUD layout bound to runtime state. The Sandbox arena becomes a sample level instead of a second runtime. This is the same composition PLAT-02's player will boot.

#### PLAT-M5 — No decided shipping runtime: the native Rust world/renderer and the Three.js gameplay path are parallel engines, and native sits on the edit critical path without representing gameplay content

- **Severity:** major (found by verifier) · **Kind:** debt · **Complexity:** S · **Roadmap:** Phase 1
- **Evidence:** Gameplay, terrain, sky, audio, HUD and blueprints exist only in the Three.js path. README.md:112-139 says WebGL2 remains the default editor path and native is a separate baseline viewport behind ?renderer=native. Native hydration receives only a field subset of worlds/scenes/levels/environment/models/animations/materials/objects (Auvra/desktop/project_host.py:256-266): no terrainData, blueprints, graphs, audio or hud. Yet every applyChanges must pass native validation and then rehydrates native (project_host.py:663,673). REFACTOR.md:42-46 calls the native renderer the 'production baseline', while native/src has no input, audio, physics or scripting (0 grep hits). Rendering features are being built twice with no stated plan for which runtime the exported player uses.
- **Done looks like:** An architecture decision recorded in the repo names the player runtime for v1. A Three.js/WebGL2 player is the realistic choice given where gameplay lives. Native is either taken off the synchronous edit path (async or optional validation) and scoped as a future accelerator, or given a concrete roadmap to parity. PLAT-01/02/06 are then planned against that single runtime.

#### PLAT-09 — No project-format migration framework or engine-version stamping beyond schemaVersion 1

- **Severity:** minor (auditor: major; verifier: partial) · **Kind:** missing · **Complexity:** M · **Roadmap:** Phase 2
- **Evidence:** Auvra/project/repository.py:101 rejects any descriptor whose schemaVersion != 1 ('unsupported project version'). Every domain schema pins "schemaVersion":{"const":1} (Auvra/project/schemas.py:57-58; project/v1/*.schema.json). The descriptor has no engine or editor version field (project/v1/project.schema.json). The only migrations are the read-only legacy .forge importer (Auvra/project/legacy.py) and an ad-hoc in-validator transform normalization (schemas.py:87-92).
- **Done looks like:** The descriptor records the engine version and per-domain versions. An ordered vN->vN+1 migration registry runs on open with an automatic backup and a dry-run report. Newer-than-supported projects get a clear refusal message. There is a fixture project for every released schema version, plus tests that migrate each fixture to current.
- **Verification:** Accurate as stated (repository.py:101; schemas.py:57; project.schema.json has no engine version). However, a clear refusal for unsupported versions already exists (UnsupportedVersionError 'unsupported project version', repository.py:101). There is also a working staged-migration pattern to reuse (ProjectService.migrate_legacy, service.py:77-105; legacy.py). Only schemaVersion 1 has ever existed, so nothing is broken today. This is a latent prerequisite for the first format change, not a current barrier to shipping a game.

#### PLAT-12 — No engine/editor extension API (plugins are limited to AI-provider capabilities)

- **Severity:** minor (auditor: major; verifier: partial) · **Kind:** missing · **Complexity:** L · **Roadmap:** Phase 3
- **Evidence:** Auvra/plugins/package.py:27 _CAPABILITIES = {"text","code","commands","media.generate","media.edit"}. The plugin wire protocol is 'auvra.provider/1' (Auvra/plugins/protocol.py:13). Nothing lets a user add blueprint nodes, components or behaviours, importers, editor panels/tools, or runtime modules.
- **Done looks like:** A versioned, documented extension API for custom blueprint nodes, gameplay components, asset importers, and editor panels/commands. It loads in both the editor and exported players (runtime extensions are cooked into the build) and comes with a sample extension and compatibility tests.
- **Verification:** Confirmed that no general extension API exists (plugins/package.py:27 capabilities are AI-only; plugins/protocol.py:13 'auvra.provider/1'). Against this completion bar, editor panels, importers and editor commands as plugins are not needed to ship a small game. The part that matters is user-authored gameplay code. Actor blueprints are config plus animation graph only (types.ts:267-282), and the level-blueprint runtime has about 25 fixed node types (hooks/useLevelBlueprintRuntime.ts). That gap belongs to the scripting area, where it is blocker or major. As a platform extension API it is minor.
- **Depends on:** PLAT-02

#### PLAT-13 — Provider plugin SDK is not integrated into the host or editor, contrary to README/REFACTOR claims

- **Severity:** minor (auditor: minor; verifier: confirmed) · **Kind:** claim-mismatch · **Complexity:** M · **Roadmap:** Deferred (§5)
- **Evidence:** README.md:165 and REFACTOR.md:56 say provider extensions have per-project permissions, revocation and restricted out-of-process execution. But nothing outside Auvra/plugins imports it (grep -rn 'plugin' Auvra --include=*.py excluding Auvra/plugins/ returned no hits). The host protocol has no plugin.* methods (protocol/v1/auvra-host.schema.json:23), and the only frontend 'plugin' hit is a Babel plugin (components/HUDEditor/DynamicHUDComponent.tsx:20).
- **Done looks like:** Host methods to install, list, grant, revoke and uninstall plugins, a settings UI, and provider routing that dispatches to PluginWorker-backed providers. A WebView2 smoke installs a signed fixture plugin and runs one job through it. Alternatively, the README is corrected to say the SDK is not yet user-reachable.
- **Verification:** I re-ran the grep for plugins|PluginWorker|auvraplugin across Auvra/**/*.py outside Auvra/plugins: 0 hits. The schema has no plugin.* methods (auvra-host.schema.json:23 enum). The frontend hits are only the Babel plugin (DynamicHUDComponent.tsx:20,87). README.md:163-166 and REFACTOR.md:56-57 overclaim. The SDK is test-only (tests/plugins/test_sdk.py).

#### PLAT-14 — Third-party license notices are not shipped in packages (and no plan exists for exported games)

- **Severity:** minor (auditor: major; verifier: partial) · **Kind:** missing · **Complexity:** S · **Roadmap:** Phase 4
- **Evidence:** CI stages only Auvra's own LICENSE as the licenses input (.github/workflows/verify.yml:263). native/THIRD_PARTY_NOTICES.md lists only 5 direct crates, yet says redistribution must retain notices for the complete lock tree, and it is never staged (grep THIRD_PARTY in *.py/*.yml/*.ps1 returned no hits). The SBOM adds npm and cargo components without license fields (release/pipeline.py:396-413 call _sbom_component without license_name). No NOTICE file exists for the Apache-2.0 project (find for *NOTICE*/THIRD* at depth 3 found only native/THIRD_PARTY_NOTICES.md).
- **Done looks like:** A generated THIRD_PARTY_NOTICES with full license texts from package-lock.json, Cargo.lock and uv.lock (runtime dependencies only), staged into licenses/ and verified by the pipeline. SBOM license fields are populated. The game exporter emits an equivalent notice file covering only the runtime dependencies that ship in the player.
- **Verification:** Mostly accurate. Only Auvra's LICENSE is staged as the licenses input (verify.yml:263). native/THIRD_PARTY_NOTICES.md is not staged (grep THIRD_PARTY in py/yml/ps1: 0 hits). npm and cargo SBOM components carry no license field (pipeline.py:399-413). Some notices do ship, though. The WebView2 SDK input carries LICENSE.txt and NOTICE.txt (Auvra/desktop/sdk.py:39,101), and the embedded Python plus site-packages carry their own license and dist-info files. So this is a compliance fix of size S, not a barrier to authoring or shipping a game. The game-export half belongs inside PLAT-01's definition of done.

#### PLAT-17 — No signed editor distribution; only unsigned CI dev MSIX, signing and release are manual

- **Severity:** minor (auditor: minor; verifier: confirmed) · **Kind:** missing · **Complexity:** S · **Roadmap:** Phase 4
- **Evidence:** .github/workflows/verify.yml is the only workflow. It uploads an unsigned dev MSIX and states it 'intentionally does not claim MSIX installation, upgrade, rollback, or uninstall success' (verify.yml:304). Signing is a manual helper (release/pipeline.py:775 sign_msix). Package branding is hardcoded with flat-color generated logos (pipeline.py:334-346, _write_png at :352-362), and there are no .auvra/.auvrapack file associations (grep FileTypeAssociation returned no hits).
- **Done looks like:** A tag-triggered release workflow in a protected environment that builds, signs and publishes stable/beta MSIX plus AppInstaller feeds, and runs the opt-in Windows lifecycle smoke (release/windows_lifecycle.py) on a clean runner. Real icons and file-type associations for .auvra/.auvrapack.
- **Verification:** verify.yml is the only workflow, and it says 'Unsigned CI intentionally does not claim MSIX installation...' (verify.yml:304). sign_msix is a manual helper (pipeline.py:775). Logos are flat generated PNGs (pipeline.py:628-631, _write_png). The grep FileTypeAssociation has 0 hits: .auvrapack appears only in file-dialog filters (Auvra/desktop/dialogs.py:103-123).
- **Depends on:** PLAT-08

### 7.5 Repo-wide capability sweep

*Audited:* Whole-repo engine capability sweep (21 capabilities, frontend + Python host + Rust native) against a Godot 4 / early-Unity "ship a small-to-mid 3D indie game" bar

Auvra is a well-built editor shell around a prototype gameplay sandbox. The shell is solid and heavily tested: the Python host, schema-validated project persistence with recovery, signed MSIX packaging of the editor, provider/plugin security and diagnostics (372 Python test functions, 44 Rust #[test]). The only working game runtime is the WebGL2/three.js play mode inside the editor (LevelGameLoop.tsx). It is hard-wired to one third-person-shooter template (player and enemy blueprints, spawners, projectiles, blood, hardcoded HUD and menus). It uses kinematic circle-push "physics", hardcoded WASD/LMB input and a level blueprint of about 20 node types with 3 events. Nothing can be shipped yet: there is no game export or standalone player (the release pipeline packages only the editor), no entity/component model, hierarchy or prefabs, no physics engine, no text scripting or debugger, no save-game API, no gamepad support, no navmesh, and HUDs made in the HUD editor are never shown in play mode. README:130-133 and REFACTOR stage 8 call the native Rust/wgpu renderer a "production baseline", but it is really a contract/test scaffold. It draws one clip-space triangle per entity with a shader that multiplies light counts by constants, loads no meshes or textures (cooked artifacts are never read), and its vertex layout does not match its data (stride bug). The asset pipeline imports FBX only, re-parses the source FBX on every project open, and the cooker only validates and copies (no KTX2/BCn, no meshopt, no reimport). Gameplay subsystems have no behavioural tests, and there are no user docs, samples or templates. Against the bar this is an editor prototype plus a single-genre sandbox. Player export, an entity/component model, scripting, physics and runtime UI are each multi-month efforts and come first.

**What exists:**

- **[basic]** 01 Rendering - WebGL2/three.js editor+play path (PBR, shadows, IBL, post) — three MeshStandardMaterial from FBX import (utils/processing/ModelMaterials.ts:21-22), ACES tone mapping renderer/AuvraCanvas.tsx:46, single sun directional shadow SkySystem.tsx:88-95 (mapSize 2048, NO shadow-camera bounds: grep 'shadow-camera|shadow\.camera|CSM|cascad' -> 0 hits, so three's default +/-5 unit shadow frustum), IBL via drei Lightformers Scene/LocalEnvironment.tsx:16-26, fixed Bloom+Vignette only in play LevelGameLoop.tsx:281-286. No placeable lights (grep '<pointLight|<spotLight' in components -> 0), no lightmaps/GI (grep 'lightmap|lightProbe|irradiance' -> only ModelMaterials.ts:21-22 field copy), no material editor UI.
- **[stub]** 01b Rendering - native wgpu 'production baseline' — gpu.rs:938-969 builds one triangle per entity; gpu.rs:1021-1050 projected_triangle uses entity.position directly as clip-space coords (no camera/view-proj; grep 'draw_indexed|view_proj|camera|base_color_texture' in gpu.rs -> 0); animation = x offset gpu.rs:1022-1025; 'PBR' fs = light counts x constants gpu.rs:1143-1151; shadow pass rasterizes same screen-space tris and samples with screen UV gpu.rs:715-717,1136; 10 floats/vertex emitted (gpu.rs:950-961) vs 36-byte stride gpu.rs:1231 and draw len/9 gpu.rs:717,737,766 -> misread vertices. Contradicts README.md:130-133.
- **[stub]** 02 Physics — No physics dependency (package.json deps; native/Cargo.toml only pollster/serde/serde_json/wgpu/winit). grep 'rapier|cannon|ammo|physx|jolt|rigidbod|collider|joint' -> only BloodSystem.tsx:11 gravity const and glTF skin joints assets.rs:1310-1315. Player: circle-push vs scale-derived radius usePlayerPhysics.ts:191-209, world clamp +/-100 :213-215, Y snapped to heightfield :224; no gravity/jump (isJumping only sets anim var PlayerController.tsx:99). Overlaps = distance check useLevelBlueprintRuntime.ts:344; projectile hits = cylinder test ProjectileManager.tsx:63-85; raycasts are editor picking only.
- **[basic]** 03 Audio — THREE.AudioListener/PositionalAudio emitters with volume/loop/refDistance/rolloff (types.ts AudioConfig; AudioSystem.tsx:37,98); full-buffer decode via THREE.AudioLoader AudioSystem.tsx:113-114, usePlayerCombat.ts:39-43 (no streaming); only master mute AudioSystem.tsx:46,56; no buses/mixer; no audio node in level blueprint (types.ts:232-234).
- **[basic]** 04 Input — Hardcoded WASD/ShiftLeft/Space/KeyF/LMB usePlayerControls.ts:66-80; per-animation-graph keyboard key->variable InputBinding types.ts:159; pointer lock LevelGameLoop.tsx:209-232. grep 'getGamepads|gamepad|touchstart|TouchEvent' -> only lucide icon BlackboardInputs.tsx:2,44. No action maps or rebinding.
- **[basic]** 05 Scripting - visual (level blueprint) — Node types types.ts:232-234; events only BeginPlay/Tick/Overlap LevelBlueprintEditor.tsx:103-116; actions only PrintString/DestroyActor/LevelAction(Restart|EndGame)/Branch/VariableSet useLevelBlueprintRuntime.ts:224-276; recursive find()-based evaluation :78-80. No spawn/transform/timer/input/audio/UI/load-level nodes.
- **[stub]** 05b Scripting - text, hot reload, debugger — Only text code path is HUD JSX compiled by @babel/standalone (DynamicHUDComponent.tsx:84-87) and run in sandboxed iframe (hud-frame.tsx:63); no gameplay script API. grep 'hot.?reload|import\.meta\.hot|debugger|breakpoint' -> 0 hits.
- **[stub]** 06 Entity/component model & prefabs — Fixed enum LevelObjectType = prop|foliage|spawn_point|audio_emitter|terrain|sky_sphere (types.ts:72) with per-type optional configs (types.ts:125-138); BlueprintType only 'Player Character'|'Enemy Controller' (types.ts:259), stats consumed only 'Health'/'Damage' (SandboxEntity.tsx:69, SandboxWorld.tsx:69), traits unused; grep -i 'prefab' -> 0 hits; native Entity has fixed optional render/light/animation fields with deny_unknown_fields (world.rs:93-112).
- **[basic]** 07 Scene graph & serialization — Serialization solid: Python project repository (Auvra/project/repository.py, 51 tests in tests/project/test_repository.py), JSON schemas project/v1/*.schema.json, content-addressed assets Auvra/project/assets.py, recovery points. Scene graph flat: objects.schema.json has no parent field (grep 'parentId|"parent"' project/v1 -> 0); only bone attachments/sockets (types.ts AttachmentData.parentModelId/boneName).
- **[basic]** 08 Animation - WebGL runtime — Skinned FBX clips, flat state machine + Blend2D, name-based retarget via SkeletonUtils.retargetClip utils/animationBinding.ts:2,153; transitions hardcode fadeIn(0.2) useGraphAnimator.ts:36,55 while GraphTransition.duration (types.ts:206) is never read (grep '\.duration' in AnimationGraph/hooks -> 0); grep 'CCDIK|IKSolver|twoBone|fabrik|rootMotion|AnimationBlendMode' -> 0; no notifies. Native has no skinning (gpu.rs:1022-1025). Detail in CHARACTER_ANIMATION_UNREAL_GAP_AUDIT.md section 0.
- **[stub]** 09 Particles/VFX — grep 'particle|THREE\.Points|emitter|vfx' -> only hardcoded BloodSystem.tsx:10-122 (400 instanced quads with gravity) and muzzle-flash sprite SocketController.tsx:97,288; no emitter object type (types.ts:72), no editor.
- **[basic]** 10 Terrain & foliage — Single heightfield PlaneGeometry with one MeshStandardMaterial TerrainObject.tsx:45,245-247; sculpt raise/lower/flatten/smooth TerrainSculptor.tsx:97-109; foliage brush FoliageBrushTool.tsx:80-119 rendered via InstancedMesh InstancedLevelLayer.tsx:128, but each instance is a LevelObject document (EnvironmentScene.tsx:349); no splat layers, chunking, LOD, culling or wind.
- **[stub]** 11 Navigation/AI — Hardcoded AI FSM (IDLE/PATROL/CHASE/ATTACK/RETURNING) AIStateMachine.ts:34+; straight-line steering with random strafe useAILocomotion.ts:60-106. 'NavMeshVisualizer' just draws a square boundary NavMeshVisualizer.tsx:8-17; grep 'navmesh|pathfind|recast|detour|steering|behavior ?tree' -> no real implementation.
- **[broken]** 12 UI runtime, fonts, localization — HUD editor saves a 'hud-main' document (HUDEditor.tsx:21), but grep 'hud-main|HUD_DOCUMENT_ID|DynamicHUDComponent|HUDCanvas' only matches components/HUDEditor/*, so authored HUDs never appear in play mode. Play HUD and menus are hardcoded in SandboxUI.tsx:68 (game over), :122 (lobby), :241 (HUD). Fonts are system-ui only (styles.css:6). grep 'i18n|locali[sz]|intl\.|msdf|troika' -> 0 relevant hits.
- **[stub]** 13 Save-game API for games — MISSING: grep 'save.?game|savegame|player.?prefs|SaveSlot' over all TS/Rust/Python -> 0 hits; only editor project saving exists.
- **[basic]** 14 Asset pipeline (import/cook/compress/stream/hot reload) — Model import is FBX-only (accept='.fbx' at BrowserToolbar.tsx:121 and ContentBrowser.tsx:70): worker FBX->GLB (fbxImport.worker.ts:119-124) -> GLTFLoader (modelLoader.ts:117), re-run for every model on each project open (useScenePersistence.ts:318,430). The native cooker only validates and copies glTF (assets.rs:463-552, 981-1026); FBX is limited to the ASCII 7.x Vertices/PolygonVertexIndex subset (assets.rs:1472-1549). Cooked artifacts are never loaded (main.rs:1794 mesh_id=stable_id(asset_hash)). grep 'ktx2|basis|draco|meshopt|gltf-transform|toktx' -> 0; grep 'watchdog|fs\.watch|FileSystemWatcher|reimport' -> 0.
- **[stub]** 15 Game build/export & standalone player — MISSING for games. Editor MSIX pipeline is solid (release/pipeline.py, policy.json:3 product 'Auvra'). grep 'export ?game|game ?build|build ?game|standalone|player ?build|exportGame|buildGame' -> only @babel/standalone, ajv standalone, standaloneTextures. Vite builds only editor+hud entries (vite.config.ts:63-67); native binary refuses to start without host session token and only runs IPC/self-tests (main.rs:3321-3345).
- **[basic]** 16 Platform targets — Editor is Windows 11 24H2 x64 only (README.md:25; release/policy.json:4-5 win-x64, build 26100); WebView2 host gated on os.name=='nt' (Auvra/desktop/webview2.py:302,359). Native crate builds on ubuntu in CI (.github/workflows/verify.yml native matrix) but nothing is packaged for any non-Windows target, and there are no game targets.
- **[stub]** 17 Networking/multiplayer — MISSING: grep 'websocket|webrtc|multiplayer|replicat|netcode|matchmak' -> only Auvra/desktop/policy.py:121 comment; SandboxUI.tsx:122 'LOBBY SCREEN' is a single-player start screen.
- **[stub]** 18 Profiler/debug tools — renderer/registry.ts:199-219 records frame ms, draw calls, triangles and geometry/texture counts, but grep 'gpuFrameMs|frameMetrics|metrics\.' in components/App/context/hooks -> 0 UI consumers. Native GpuTiming (gpu.rs:26-104) is used for reference/self-tests. Logging and diagnostics are solid (Auvra/diagnostics/core.py, frontend diagnostics/runtime.ts), but there is no profiler panel or overlay.
- **[basic]** 19 Editor extensibility/plugin API — Signed .auvraplugin with out-of-process worker and permissions is solid (Auvra/plugins/package.py, worker.py, security.py; 18 tests), but capabilities are limited to {text, code, commands, media.generate, media.edit} (package.py:28-29). There is no editor UI/tool/importer/component/node extension API (grep 'registerPanel|registerTool|registerNode' -> 0).
- **[stub]** 20 Docs, samples, templates, onboarding — find for docs/doc/examples/samples/templates/tutorial dirs -> none; find for *.fbx/*.glb/*.gltf/*.wav/*.mp3/*.png/*.auvra/*.auvrapack -> none. README.md and fbx-viewer (1)/README.md cover developer setup only; the only templates are default player/enemy blueprints data/blueprints/player.ts, enemy.ts.
- **[basic]** 21 Automated tests per subsystem — Infrastructure is solid: 372 Python test functions (tests/**), 44 Rust #[test] (assets 11, world 11, main 12, render_world 8, gpu 2), and CI in .github/workflows/verify.yml. Frontend has only 5 test files / 109 LOC (fbx-viewer (1)/tests/frontend/*). Gameplay runtimes (blueprint, animation, AI, physics, audio, terrain) have no behavioural tests; scripts/project/verify.mjs:269-273 only regex-matches source text.
- **[basic]** Native deterministic fixed-step world — 60 Hz fixed step, replay hashing and transactions (world.rs:12-16, 473-560), but simulation is only position += velocity (world.rs:703-722). It is not used by gameplay, which runs frame-variable in React useFrame (LevelGameLoop.tsx, usePlayerPhysics.ts).

#### CAPA-01 — No game build/export pipeline or standalone player runtime

- **Severity:** blocker (auditor: blocker; verifier: confirmed) · **Kind:** missing · **Complexity:** XL · **Roadmap:** Phase 1
- **Evidence:** grep -iE 'export ?game|game ?build|build ?game|standalone|player ?build|exportGame|buildGame' -> only @babel/standalone, ajv standalone, standaloneTextures (useScenePersistence.ts:77). vite.config.ts:63-67 builds only 'editor' and 'hud' entries. release/policy.json:3 product 'Auvra', and its requiredInputs (frontend, python-embed, webview2, native, host) package the editor. native main.rs:3321-3345 exits without AUVRA_NATIVE_SESSION_TOKEN and only runs IPC or self-tests. Play mode (LevelGameLoop.tsx) is an editor tab that reads all state from SceneContext, and its models are re-parsed from source FBX on project open (useScenePersistence.ts:318,430).
- **Done looks like:** An editor 'Build Game' command with export presets produces a self-contained folder or exe. It contains a runtime-only bundle (no editor UI, Vite, provider stack or dev tooling), cooked assets, and project settings (game name, icon, startup level, window mode/resolution). It launches straight into the game with a quit path and runs on a clean machine without Node or Python dev tooling. CI exports a sample project and smoke-launches it.
- **Verification:** Verified. vite.config.ts:63-67 has only the editor and hud rollup inputs. release/policy.json:3,55-63 packages the editor (frontend, python-embed, webview2, native, host), and pipeline.py:526-560 writes a packaged startup that launches the editor frontend. These greps return 0 hits in py/rs/json/toml/ps1: `\bplayer\b|play_mode|playmode|runtime_only|game_mode|fullscreen`, and the standalone/export-game grep. The only 'standalone' hits are @babel/standalone and the ajv standalone validator (host/protocol.ts:5). No player runtime exists under any other name.
- **Depends on:** CAPA-02, CAPA-05, CAPA-08

#### CAPA-02 — No generic entity/component model, scene hierarchy, or prefabs

- **Severity:** blocker (auditor: blocker; verifier: confirmed) · **Kind:** missing · **Complexity:** XL · **Roadmap:** Phase 2
- **Evidence:** types.ts:72 fixed LevelObjectType enum (prop|foliage|spawn_point|audio_emitter|terrain|sky_sphere); types.ts:125-138 per-type optional config blobs; project/v1/objects.schema.json additionalProperties:false with no parent field (grep 'parentId|"parent"' project/v1 -> 0); grep -i prefab -> 0 hits; BlueprintType limited to 'Player Character'|'Enemy Controller' (types.ts:259); native Entity fixed fields + deny_unknown_fields (world.rs:93-112). No light, camera, collider, trigger or script object types exist.
- **Done looks like:** Entities with stable IDs and parent/child transforms, plus a component registry (Transform, MeshRenderer, Light, Camera, Collider, RigidBody, AudioSource, Script, ParticleEmitter, AnimationGraph, UI). The inspector is generated from component schemas. Prefab assets support nesting and per-instance overrides, with apply/revert. Persistence schemas are versioned, with a migration from existing LevelObject and Blueprint documents.
- **Verification:** Verified: types.ts:72 is a fixed enum, there is no parent field in project/v1/objects.schema.json, and `prefab` has 0 hits. Two nuances. (1) Bone-socket parenting exists through AttachmentData/SocketData {parentModelId, boneName} (types.ts:20-50), and HierarchyPanel.tsx:27-28 nests attachments under models. That is one level of model-to-bone parenting, not a scene graph. (2) The native Entity has optional light and animation components (world.rs:93-112), but it is a fixed-field DTO with deny_unknown_fields. The schema 'type' field is a free string while the TS type is an enum. Neither changes the conclusion.

#### CAPA-03 — No general gameplay scripting; play mode is hard-wired to one third-person-shooter template

- **Severity:** blocker (auditor: blocker; verifier: confirmed) · **Kind:** missing · **Complexity:** XL · **Roadmap:** Phase 3
- **Evidence:** The only text code path is HUD JSX (DynamicHUDComponent.tsx:84-87, hud-frame.tsx:63). The level blueprint has 3 events (LevelBlueprintEditor.tsx:103-116), and its runtime actions are only Print/DestroyActor/Restart/EndGame/VariableSet (useLevelBlueprintRuntime.ts:224-276). LevelGameLoop.tsx:13-19 hardcodes Player/AI/Projectile/Blood/SandboxUI systems. Only the 'Health' and 'Damage' stats are consumed (SandboxEntity.tsx:69, SandboxWorld.tsx:69). grep 'hot.?reload|import\.meta\.hot|debugger|breakpoint' -> 0.
- **Done looks like:** A documented, typed script API (TS/JS components with onStart/onUpdate/onCollision/onTrigger). It gives access to entities/components, input actions, physics queries, audio, UI, timers and scene loading. Scripts are sandboxed and hot-reload in play mode, with errors mapped to source lines. Visual scripting covers the same API (spawn, transform, delay/timers, loops, custom events/functions, input, play sound, UI binding, load level). Both get breakpoints, step and watch. The TPS logic becomes an optional template.
- **Verification:** Verified. LevelBlueprintEditor.tsx:90-120 offers only BeginPlay, Tick and Overlap. The runtime executes PrintString, DestroyActor, LevelAction (Restart/EndGame) and VariableSet (useLevelBlueprintRuntime.ts:224-276). `new Function|eval(` hits only hud-frame.tsx:63 and verify scripts. LevelGameLoop.tsx:240-246 refuses to run without a Player Blueprint ('Player Configuration Missing'), so a game that is not a TPS cannot enter play mode. VariableSet's Enemy target is also dead (enemyApiRef={{current: undefined}} at LevelGameLoop.tsx:372).
- **Depends on:** CAPA-02

#### CAPA-04 — No physics engine (rigid bodies, colliders, queries, character controller, joints)

- **Severity:** blocker (auditor: blocker; verifier: confirmed) · **Kind:** missing · **Complexity:** L · **Roadmap:** Phase 3
- **Evidence:** No physics dependency in fbx-viewer (1)/package.json or native/Cargo.toml. grep -iE 'rapier|cannon|ammo|physx|jolt|rigidbod|collider|joint' -> only BloodSystem.tsx:11 GRAVITY and glTF skin joints (assets.rs:1310-1315). Player movement is kinematic circle-push using scale-derived radii (usePlayerPhysics.ts:191-209), a hard clamp to +/-100 (:213-215) and snapping to terrain height (:224); Space only sets an anim variable (PlayerController.tsx:99). Overlap events are distance checks (useLevelBlueprintRuntime.ts:344) and projectile hits are cylinder tests (ProjectileManager.tsx:63-85).
- **Done looks like:** An integrated physics engine (e.g. Rapier) stepping at a fixed rate inside play mode and the player. It supports static, dynamic and kinematic bodies and box/sphere/capsule/convex/trimesh/heightfield colliders authored in the inspector with debug draw. Triggers, collision layers/masks and raycast/shape-cast/overlap queries are exposed to scripts. A character controller handles gravity, jump, slopes and steps, and basic joints are available.
- **Verification:** Verified. Cargo.toml has only pollster/serde/wgpu/winit. @dimforge/rapier3d-compat appears only in package-lock.json:570,2003 as a transitive dependency of @types/three, and no source file imports it (`rapier` grep on ts/tsx -> 0). usePlayerPhysics.ts:188-224 is a circle push plus a ±100 clamp plus a terrain snap. Projectiles ignore level geometry (ProjectileManager only tests registered hittables).
- **Depends on:** CAPA-02

#### CAPA-05 — Runtime UI: authored HUDs never reach play mode; no authored menus, font assets, or localization

- **Severity:** blocker (auditor: blocker; verifier: confirmed) · **Kind:** broken · **Complexity:** L · **Roadmap:** Phase 3
- **Evidence:** grep 'hud-main|HUD_DOCUMENT_ID|DynamicHUDComponent|HUDCanvas' matches only components/HUDEditor/*, so the HUD document saved by HUDEditor.tsx:21 is never rendered in play. The play HUD, lobby and game-over screens are hardcoded in SandboxUI.tsx:241, :122 and :68. Fonts are system-ui only (styles.css:6). grep 'i18n|locali[sz]|intl\.|msdf|troika' -> 0 relevant hits.
- **Done looks like:** The runtime renders authored HUD/menu documents over the game view. Widgets bind to entity and script variables (health, ammo, score), and widget events (button -> start/quit/settings) reach scripts. Screen flow (main menu, pause, settings, game over) is authored, not hardcoded. Font assets can be imported with fallbacks, string tables support runtime locale switching, layouts anchor independently of resolution, and UI can be navigated with keyboard or gamepad.
- **Verification:** Verified. COMPONENT_REGISTRY (componentRegistry.tsx:33) is used only by HUDCanvas.tsx:162 inside the HUD editor. Play mode imports only the ScopeReticle widget component (SandboxUI.tsx:5), not the authored 'hud' document. The 'hud' domain is loaded by useScenePersistence.ts:185 but nothing in Sandbox/ or Environment/ reads it. Fonts are system-ui only (styles.css:6, tailwind.config.cjs:12).
- **Depends on:** CAPA-03

#### CAPA-06 — Input system: hardcoded keys; no action maps, rebinding, gamepad, or touch

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** stub · **Complexity:** M · **Roadmap:** Phase 3
- **Evidence:** usePlayerControls.ts:66-80 hardcodes KeyW/A/S/D, ShiftLeft, Space, KeyF and mouse button 0. InputBinding (types.ts:159) maps a keyboard key to a variable per animation graph. grep 'getGamepads|gamepad|touchstart|TouchEvent' -> only the lucide Gamepad2 icon (BlackboardInputs.tsx:2,44).
- **Done looks like:** A project-level input actions asset (buttons and axes) with keyboard/mouse/gamepad bindings, deadzones and composite axes. Gamepad API polling supports hot-plug. Players can rebind at runtime, and bindings persist. Scripts and visual nodes query actions, not raw keys.
- **Verification:** Verified: usePlayerControls.ts:66-80 hardcodes the keys. The animation-graph InputBinding (useInputHandler.ts:13-31, BlackboardInputs.tsx) is authorable per graph but keyboard-only, and only drives animation variables. A `getGamepads|gamepad|touchstart` grep hits only lucide Gamepad2 icons. The kind 'stub' is fair because of the per-graph key binding.
- **Depends on:** CAPA-03

#### CAPA-07 — No save-game / persistence API for shipped games

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** missing · **Complexity:** M · **Roadmap:** Phase 1
- **Evidence:** grep -iE 'save.?game|savegame|player.?prefs|SaveSlot' across TS/Rust/Python -> 0 hits. Project saving (Auvra/project/repository.py) is editor-only authoring persistence through the Python host.
- **Done looks like:** A runtime API with save/load slots and key-value prefs, writing to per-user app data in the standalone player. Entity/component state is serialized through versioned schemas with migrations. The API is exposed to scripts and visual nodes, and player settings (audio, bindings, graphics) persist.
- **Verification:** Verified: `save.?game|savegame|player.?prefs|SaveSlot|checkpoint` returns 0 relevant hits in the frontend. localStorage/indexedDB appear only as a read-only legacy migration source (utils/db.ts:65,138) and as a forbidden pattern in verify scripts. Project persistence is editor-only.
- **Depends on:** CAPA-01, CAPA-02

#### CAPA-08 — Asset pipeline not shippable: FBX-only import, passthrough cooker, no texture compression/mesh optimization/reimport

- **Severity:** major (auditor: major; verifier: partial) · **Kind:** stub · **Complexity:** L · **Roadmap:** Phase 2
- **Evidence:** Model import accepts only '.fbx' (BrowserToolbar.tsx:121, ContentBrowser.tsx:70), and the source FBX is re-parsed FBX->GLB->three on every project open (useScenePersistence.ts:318,430; modelLoader.ts:117). The native cook copies glTF JSON/BIN verbatim (assets.rs:463-552, 981-1026). FBX support is limited to the ASCII 7.x vertex/index subset, and binary FBX is rejected (assets.rs:1472-1549). Cooked artifacts are never read (main.rs:1794; grep 'artifact' in render_world.rs/gpu.rs -> 0). grep 'ktx2|basis|draco|meshopt|gltf-transform|toktx' -> 0; grep 'watchdog|fs\.watch|FileSystemWatcher|reimport' -> 0. release/asset_cooking.py only copies and hashes.
- **Done looks like:** Import of glTF/GLB/OBJ and binary FBX, with import settings (scale, axes, material extraction, clip splitting). Assets are cooked to a runtime format (meshopt-compressed GLB, KTX2/Basis or BCn textures with mips, decoded audio choices) that both play mode and the player load directly. Includes LOD generation, a dependency graph with incremental re-cook, file-watch reimport, and per-platform cook settings.
- **Verification:** Mostly correct (accept='.fbx' in BrowserToolbar.tsx:121 and ContentBrowser.tsx:70; FBX re-parsed on open at useScenePersistence.ts:318,430; passthrough cooker), but one claim is overstated. The 'ASCII-only, binary rejected' limit is only in the native cooker (assets.rs:1483), which is not on the working path. The editor imports through three's FBXLoader in fbxImport.worker.ts:4,119, which parses binary FBX, so 'binary FBX' is not a gap for the working runtime. What remains: no glTF/GLB/OBJ import UI despite GLTFLoader already being used internally (modelLoader.ts:3,117), no import settings, no runtime cooked format, and no reimport or file watching.

#### CAPA-09 — No navigation mesh, pathfinding, or authorable AI behaviors

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** missing · **Complexity:** M · **Roadmap:** Phase 3
- **Evidence:** grep -iE 'navmesh|pathfind|recast|detour|steering|behavior ?tree' -> only NavMeshVisualizer.tsx:8-17, which draws a square boundary line, plus a comment at AIController.tsx:68. AI moves in straight lines toward the destination with random strafe (useAILocomotion.ts:60-106), and the FSM is fixed in code (AIStateMachine.ts:34+).
- **Done looks like:** Navmesh baking from level geometry and terrain (e.g. recast-navigation) with agent radius/height/slope settings and dynamic obstacles. Path queries, path following and local avoidance are exposed to scripts, with nav debug draw. AI behaviours are authored (behaviour tree or scripted FSM) instead of the hardcoded enemy FSM.
- **Verification:** Verified: NavMeshVisualizer.tsx:8-35 only draws a square boundary line and a tinted plane. `navmesh|pathfind|recast|detour|steering|behavior tree` finds nothing else under components/hooks/utils. AI is the fixed FSM in components/Sandbox/AI/AIStateMachine.ts.
- **Depends on:** CAPA-02, CAPA-03

#### CAPA-10 — Lighting/rendering authoring gaps in the only working renderer (WebGL2)

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** missing · **Complexity:** L · **Roadmap:** Phase 3
- **Evidence:** No light object type (types.ts:72); grep '<pointLight|<spotLight' in components -> 0; scenes get sun + ambient only (SkySystem.tsx:88-98). The sun shadow sets mapSize but no shadow camera bounds (SkySystem.tsx:88-95; grep 'shadow-camera|shadow\.camera|CSM|cascad' -> 0), so three's default +/-5 unit ortho frustum shadows about 10x10 units of a +/-100 world (usePlayerPhysics.ts:213-215). No lightmaps, GI or probes (grep 'lightmap|lightProbe|irradiance' -> only the ModelMaterials.ts:21-22 field copy). The post chain is fixed Bloom+Vignette (LevelGameLoop.tsx:281-286). materials.schema.json defines metallic/roughness/normal, but no UI edits them.
- **Done looks like:** A Light component (point/spot/directional) with per-light shadows, and camera-fitted or cascaded sun shadows. Baked lightmaps or light/reflection probes. A per-level post-processing volume (exposure, tone mapping, bloom, AO, AA, color grading). A PBR material editor with texture slots, and player-facing quality presets.
- **Verification:** Verified for the working WebGL renderer: no point/spot lights in components; the sun shadow sets only bias and mapSize (SkySystem.tsx:88-95) with sunPosition r=100 (SkySystem.tsx:43); the post chain is fixed (LevelGameLoop.tsx:281-286). Two nuances. (1) The scenes do get a procedural IBL reflection environment (LocalEnvironment.tsx:16-27, used by SkySystem.tsx:101), so it is not only sun + ambient, but it is not authorable. (2) levels/worlds/environment schemas already accept lights, ibl and postEffects arrays (project/v1/levels.schema.json; Auvra/desktop/project_host.py:258-261). Only the native renderer consumes them (main.rs:2288-2305, 2641-2650). The editor never writes them and WebGL play ignores them.
- **Depends on:** CAPA-02

#### CAPA-11 — Native wgpu 'production renderer' is a placeholder; README/REFACTOR and findings F-044 overstate it

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** claim-mismatch · **Complexity:** XL · **Roadmap:** Phase 0
- **Evidence:** README.md:130-133 and REFACTOR.md:25 claim PBR, animation, shadows, IBL and more. In code, gpu.rs:1021-1050 emits one triangle per entity using entity.position as clip-space coords, with no camera (grep 'draw_indexed|view_proj|camera|base_color_texture' in gpu.rs -> 0). The fs multiplies light counts by constants (gpu.rs:1143-1151), shadow sampling uses screen UV (gpu.rs:1136), and animation is just an x offset (gpu.rs:1022-1025). The data is 10 floats/vertex (gpu.rs:950-961) but the stride is 36 bytes (gpu.rs:1231) and draws use len/9 (gpu.rs:717,737,766), so vertices are misread. Cooked meshes are never loaded (main.rs:1794). findings.md:381 marks F-044 'Completed' although the projected-triangle geometry it cites remains. The native world only integrates velocity (world.rs:703-722) and runs no gameplay, so gameplay and the native world are two divergent runtimes.
- **Done looks like:** Immediately: README and REFACTOR describe native as contract/test scaffolding, F-044 is reopened, and the stride/draw-count mismatch is fixed. Strategically: choose the shipping runtime. If it is native, it must load cooked meshes/textures, use a camera view-projection, do GPU skinning, use light-space shadow maps and a real BRDF, and run gameplay systems. Otherwise, retire the native renderer claims and invest in the WebGL/WebGPU runtime.
- **Verification:** Verified in gpu.rs. The vertex builder emits 10 floats per vertex (gpu.rs:950-961 and 974-985), the layout stride is 36 bytes for 9 floats (gpu.rs:1231), and draws use len/9 (gpu.rs:717,737,766), so vertices are misread. projected_triangle (gpu.rs:1020-1049) clamps world position into clip space with no camera. The fragment shader multiplies light counts by constants (gpu.rs:1143-1151). findings.md:383 marks F-044 Completed. README.md:126-131 hedges ('not a claim that ... every authored project asset exercises every feature') but still lists PBR, shadows and IBL as a baseline. Severity stays major as a strategic runtime fork, though it is off the default path (?renderer=native).

#### CAPA-12 — No authorable particle/VFX system

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** missing · **Complexity:** L · **Roadmap:** Phase 3
- **Evidence:** grep -iE 'particle|THREE\.Points|emitter|vfx' -> only BloodSystem.tsx:10-122 (hardcoded 400 instanced quads with gravity) and the muzzle flash in SocketController.tsx:97,288. There is no emitter object type (types.ts:72) and no VFX editor.
- **Done looks like:** A ParticleEmitter component with an editor: rate/burst, emission shapes, lifetime, velocity/gravity/drag, color and size over life curves, flipbook textures, blend modes. It has a GPU-instanced runtime, previews in the editor, and can be triggered from scripts. Blood and muzzle flash are rebuilt as assets.
- **Verification:** Verified: the `particle|THREE.Points|<points|vfx|trail|decal` grep hits only BloodSystem.tsx (PARTICLE_COUNT=400 instanced quads) and 'VFX' comments in SandboxWorld.tsx and LevelGameLoop.tsx. There is no emitter object type or editor.
- **Depends on:** CAPA-02

#### CAPA-13 — Animation lacks IK, root motion, layered/additive blending, events; transition durations ignored

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** stub · **Complexity:** L · **Roadmap:** Phase 3
- **Evidence:** useGraphAnimator.ts:36,55 hardcode fadeIn(0.2), and GraphTransition.duration (types.ts:206) is never read (grep '\.duration' in components/AnimationGraph/hooks -> 0). grep 'CCDIK|IKSolver|twoBone|fabrik|rootMotion|AnimationBlendMode' -> 0. No notifies/events (grep 'notif|onAnimationEvent' in AnimationGraph/hooks -> 0). Native has no skinning (gpu.rs:1022-1025). Full list in CHARACTER_ANIMATION_UNREAL_GAP_AUDIT.md section 0.
- **Done looks like:** Transition durations are honoured with real crossfades. 1D and triangulated 2D blend spaces. Masked/layered and additive blending (upper-body aim/fire). Animation events that feed scripts (footsteps, hit frames). Root motion drives the character controller. Two-bone/foot/look IK, and a skeleton asset for retargeting.
- **Verification:** Verified: useGraphAnimator.ts:36,55 hardcode fadeIn(0.2), and a `.duration` grep finds only modelLoader.ts:173 (clip duration), so GraphTransition.duration is never read. No IK, root-motion, additive or notify code exists. A reduced 2D blend space does exist: the Blend2D state type (types.ts:166-172) uses inverse-distance weighting (useGraphAnimator.ts:63-124), so the 'blend spaces' part of done-looks-like is partly met already.
- **Depends on:** CAPA-04

#### CAPA-15 — No user documentation, sample projects, or project templates

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** missing · **Complexity:** M · **Roadmap:** Phase 4
- **Evidence:** find for docs/doc/examples/samples/templates/tutorial directories -> none. find for *.fbx/*.glb/*.gltf/*.wav/*.mp3/*.png/*.auvra/*.auvrapack -> none. README.md and fbx-viewer (1)/README.md (85 lines) cover developer setup only, and New Project has no templates beyond the default player/enemy blueprints (data/blueprints/*.ts).
- **Done looks like:** A user manual: editor workflow, scripting API reference, and physics/UI/input/audio/export guides. At least 2 sample projects with CC0 assets (the current TPS sandbox as a template, plus a different genre). 'New Project' templates. A getting-started tutorial that ends in an exported standalone build.
- **Verification:** Verified: find for docs/doc/examples/samples/templates/tutorial* directories returns nothing. No .fbx/.glb/.gltf/.wav/.mp3/.ogg/.png/.jpg/.auvra* files exist outside ignored paths. The only .md files are README, REFACTOR, findings, the animation audit, the fbx-viewer README and THIRD_PARTY_NOTICES. data/blueprints has only player.ts, enemy.ts and index.ts.
- **Depends on:** CAPA-01, CAPA-03

#### CAPA-16 — Audio has no mixer buses, streaming, or script-driven playback

- **Severity:** major (auditor: major; verifier: confirmed) · **Kind:** stub · **Complexity:** M · **Roadmap:** Phase 3
- **Evidence:** THREE.AudioLoader fully decodes every file (AudioSystem.tsx:113-114, usePlayerCombat.ts:39-43). The only global control is master mute (AudioSystem.tsx:46,56). grep 'master ?volume|sfxVolume|musicVolume' -> only a BlueprintInspectorPanel.tsx:293 label. There is no audio node in the level blueprint node set (types.ts:232-234).
- **Done looks like:** A mixer with master/music/SFX/UI/voice buses (volume, mute, ducking). Streamed music. Play/stop/one-shot APIs for scripts and visual nodes. Audio settings persist in the player. Optional reverb/low-pass effects.
- **Verification:** Verified: AudioSystem.tsx:46,56 provide only a listener master mute, and no gain/bus code exists. What does exist: per-emitter volume, loop, autoplay, spatial falloff and loop regions (types.ts:82-95, AudioSystem.tsx:98-160) and blueprint weapon sounds. Gameplay cannot trigger any other sound because there is no audio node among the LogicNode types (types.ts:232-235).
- **Depends on:** CAPA-03

#### CAPA-M01 — Play mode is not isolated from authored data: in-game DestroyActor permanently deletes level objects from the saved project

- **Severity:** major (found by verifier) · **Kind:** broken · **Complexity:** M · **Roadmap:** Phase 0
- **Evidence:** LevelGameLoop.tsx:95 takes the editor's removeLevelObject from useScene() and passes it into the runtime at :373. useLevelBlueprintRuntime.ts:240-243 handles DestroyActor (e.g. an overlap 'pickup') by calling removeLevelObject(context.otherActorId). useLevelManager.ts:482-489 then calls dbOperations.deleteLevelObject, which reaches the host through utils/db.ts:465-466 (canonicalChange('objects','remove')). Play mode also renders the live editor levelObjects array with no runtime copy (LevelGameLoop.tsx:95,189-198). Related dead path: LevelGameLoop.tsx:372 passes enemyApiRef={{ current: undefined }}, so the 'Enemy' target the inspector offers (LevelBlueprintInspector.tsx:173) silently does nothing.
- **Done looks like:** Entering play mode builds a runtime world: a deep copy of the level/entity state, separate from the editor documents. Runtime destroy/spawn/transform operations affect only that copy. Exiting play mode discards it, with an optional 'keep simulation changes' action. Nothing in the gameplay runtime can reach the project-mutation APIs (enforced by a lint/verify check). Every target the level-logic UI offers resolves to a live runtime entity.
- **Depends on:** CAPA-02

#### CAPA-M02 — Terrain cannot be textured or painted (hardcoded grey flat-shaded material; TerrainData.textureId unused)

- **Severity:** major (found by verifier) · **Kind:** stub · **Complexity:** M · **Roadmap:** Phase 3
- **Evidence:** TerrainObject.tsx:45-52 creates a fixed MeshStandardMaterial({color:'#555555', flatShading:true}) with no map. TerrainData.textureId is declared at types.ts:100, but a `textureId` grep under components/Environment returns 0 hits, and a `map|texture` grep in TerrainObject.tsx returns 0 hits. The sculpt tool exists (TerrainSculptor.tsx), but there are no splat layers or paint tools, and no terrain material reaches play mode (LevelGameLoop.tsx:291-301 renders the same TerrainObject).
- **Done looks like:** A terrain material with 4+ blendable layers (albedo/normal/roughness, tiling) and a painted splat map stored in the project. A paint brush in the environment editor. The TerrainData.textureId override actually applies. The same material renders in play mode and in exported builds, with heightfield collision once CAPA-04 lands.
- **Depends on:** CAPA-08

#### CAPA-M03 — No runtime level flow: play always runs the editor's open level from the editor camera; no level transitions or authored player start

- **Severity:** major (found by verifier) · **Kind:** missing · **Complexity:** M · **Roadmap:** Phase 1
- **Evidence:** LevelAction supports only 'Restart' | 'EndGame' (LevelBlueprintEditor.tsx:147), and EndGame just calls onExit, leaving play mode (LevelGameLoop.tsx:376). A `loadLevel|currentLevelId` grep over components/Sandbox, LevelGameLoop.tsx and useLevelBlueprintRuntime.ts returns 0. loadLevel exists only as an editor action (EnvironmentSidebar.tsx:140, useLevelManager.ts:362). Player spawn is the editor camera position (EnvironmentEditor.tsx:72 spawnPosition={state.editorCameraPos.current}, LevelGameLoop.tsx:185-187), falling back to [0,0.5,0]. No spawn object places the player.
- **Done looks like:** A project-level startup level. A runtime scene manager that can load/unload/switch levels, with a loading screen and carry-over state, exposed as 'Open Level' in scripts and visual nodes. An authorable Player Start entity used by play mode and the exported player. Play-from-here stays an editor-only option.
- **Depends on:** CAPA-02, CAPA-03

#### CAPA-M04 — Undo/redo covers only level-object edits; blueprint, animation-graph, level-logic and HUD editors have none, while edits persist to the host immediately

- **Severity:** major (found by verifier) · **Kind:** missing · **Complexity:** M · **Roadmap:** Phase 2
- **Evidence:** The only history stack is useLevelManager.ts:131-161 (history = { past: LevelObject[][], future }), wired to Ctrl+Z only in components/Environment/hooks/useEnvironmentHotkeys.ts:30-37,65. A `history|past|future|snapshot` grep over components/{AnimationGraph,LevelBlueprint,HUDEditor,Blueprint} returns 0 hits. Level-blueprint changes live on LevelData, not in the LevelObject history, so deleting a logic node or graph state cannot be undone except through a project recovery point.
- **Done looks like:** A single editor command/transaction stack that every authoring surface uses: level objects, terrain, blueprints, animation graphs, level logic, HUD, materials and import settings. It supports grouped and coalesced operations (drags, sculpt strokes), global Ctrl+Z/Ctrl+Y, and an undo history panel, and stays consistent with host persistence revisions.

#### CAPA-14 — No automated tests for gameplay subsystems

- **Severity:** minor (auditor: major; verifier: confirmed) · **Kind:** debt · **Complexity:** M · **Roadmap:** Phase 4
- **Evidence:** The frontend has only 5 test files / 109 LOC (fbx-viewer (1)/tests/frontend: editorSession, hudTypes, rendererRecovery, scrubbableInput, select). Searching tests and scripts for useLevelBlueprintRuntime|useGraphAnimator|usePlayerPhysics|evaluateNextState|AudioSystem|ProjectileManager finds only regex source checks (scripts/project/verify.mjs:39-40,269-273) and a diagnostics allow-list. By contrast there are 372 Python and 44 Rust tests for infrastructure.
- **Done looks like:** Unit tests cover blueprint evaluation and execution, the animation state machine and blending, the AI FSM, terrain height sampling, physics/character controller, input mapping, and save/load round-trips. A headless deterministic play-mode test loads a sample project, runs N fixed steps and asserts outcomes. These gate CI.
- **Verification:** Verified: the frontend has 5 test files totalling 109 LOC (tests/frontend/*), and vitest includes only tests/frontend/**. Severity is downgraded because this is engineering debt, not a user-facing capability against the ship-a-game bar. The gameplay systems it would cover (CAPA-02/03/04) are slated for replacement, so behavioural and headless play tests belong in those items' done criteria rather than a standalone gap.

#### CAPA-17 — Windows-only; no export targets for other platforms

- **Severity:** minor (auditor: major; verifier: confirmed) · **Kind:** missing · **Complexity:** L · **Roadmap:** Phase 1
- **Evidence:** release/policy.json:4-5 is win-x64 with minimum build 26100. README.md:25 requires Windows 11 24H2 x64 and WebView2. Auvra/desktop/webview2.py:302,359 gate on os.name=='nt'. There is no game export at all (CAPA-01).
- **Done looks like:** Export presets and player builds for Windows x64, Linux and macOS, with a Web export option that the WebGL runtime makes natural. Each target gets a CI smoke launch.
- **Verification:** Verified: policy.json:4-5 is win-x64 only. Severity is downgraded because a Windows-only first export target is acceptable for an indie team at this bar. The real blocker is CAPA-01: there is no export target at all.
- **Depends on:** CAPA-01

#### CAPA-18 — No profiler or debug overlay despite collected metrics

- **Severity:** minor (auditor: minor; unverified (minor, not sent to verifier)) · **Kind:** stub · **Complexity:** S · **Roadmap:** Phase 4
- **Evidence:** renderer/registry.ts:199-219 records frame ms, draw calls, triangles and geometry/texture counts. grep 'gpuFrameMs|frameMetrics|metrics\.' in components/App.tsx/context/hooks -> 0 UI consumers. Native GpuTiming (gpu.rs:26-104) feeds only reference/self-test paths.
- **Done looks like:** An in-editor and in-play overlay and panel showing CPU/GPU frame-time graphs, draw calls, triangles, texture/geometry/JS-heap memory, and per-system timings (scripts, physics, animation, AI, audio), with capture and export.

#### CAPA-19 — Terrain and foliage do not scale (single material, no LOD/chunking, per-instance documents)

- **Severity:** minor (auditor: minor; unverified (minor, not sent to verifier)) · **Kind:** stub · **Complexity:** M · **Roadmap:** Phase 2
- **Evidence:** Terrain is a single PlaneGeometry heightfield with one MeshStandardMaterial (TerrainObject.tsx:45,245-247); sculpt modes are raise/lower/flatten/smooth only (TerrainSculptor.tsx:97-109). Each foliage instance is a LevelObject (EnvironmentScene.tsx:349). grep 'lod|cull|wind' in InstancedLevelLayer.tsx and FoliageBrushTool.tsx -> 0.
- **Done looks like:** Splat-mapped multi-layer terrain material with a paint tool, chunked terrain with LOD and a heightfield collider, and foliage stored as compact per-type instance buffers with distance culling, LOD/billboards and wind.
- **Depends on:** CAPA-04

#### CAPA-20 — No editor extension API (plugins limited to AI providers)

- **Severity:** minor (auditor: minor; verifier: confirmed) · **Kind:** missing · **Complexity:** L · **Roadmap:** Deferred (§5)
- **Evidence:** Auvra/plugins/package.py:28-29 limits plugin capabilities to {text, code, commands, media.generate, media.edit}. grep 'registerPanel|registerTool|registerNode' in the frontend -> 0.
- **Done looks like:** A documented editor extension API for custom components/inspectors, menu commands, importers, tool panels and visual-script node packs. Project- and user-level plugins load under the existing signing and permission model.
- **Verification:** Verified: Auvra/plugins/package.py:28 _CAPABILITIES = {text, code, commands, media.generate, media.edit}. No frontend registration API exists.
- **Depends on:** CAPA-02, CAPA-03

#### CAPA-21 — No networking/multiplayer

- **Severity:** minor (auditor: minor; verifier: confirmed) · **Kind:** missing · **Complexity:** XL · **Roadmap:** Deferred (§5)
- **Evidence:** grep -iE 'websocket|webrtc|multiplayer|replicat|netcode|matchmak' -> only an Auvra/desktop/policy.py:121 comment; SandboxUI.tsx:122 'LOBBY SCREEN' is a single-player start screen.
- **Done looks like:** Optional for this bar. A transport layer (WebSocket/WebRTC or ENet in the player), entity/component replication with ownership, RPCs, and a listen-server sample.
- **Verification:** Verified: `new WebSocket|RTCPeerConnection|multiplayer|replicat|netcode|matchmak` -> 0 hits in ts/tsx/py/rs. Optional for this bar; keep it only as a low-priority note.
- **Depends on:** CAPA-01, CAPA-02, CAPA-03

---

*End of roadmap. Documentation only; no source files were modified.*
