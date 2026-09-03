# Repository findings

Review date: 2026-08-30

Reviewed revision: `ea73808`

Scope: static review of the tracked Python host, React/TypeScript editor, Rust native engine, project/archive code, release pipeline, and tests, plus focused local reproductions. No product fixes are included in this document.

## How to read this report

- **Critical**: plausible data loss, security-boundary failure, or a core workflow that can break broadly.
- **High**: material functional, reliability, or integrity defect.
- **Medium**: narrower defect, robustness issue, misleading behavior, or important maintainability concern.
- **Low**: defense-in-depth, documentation, or quality concern with limited immediate impact.
- **Confirmed** means the behavior follows directly from the implementation or was locally reproduced.
- **Risk** means a credible failure path exists but the full end-to-end exploit or field impact was not exercised.
- **Gap** means the named guarantee is not established by current verification.

The list is intentionally extensive. Related symptoms are grouped where they share one root cause, and tentative items are not presented as proven failures.

## Executive summary

The most urgent themes are revision and project-identity races in the frontend, native IPC framing failures, incomplete process ownership, crash-consistency holes in project persistence, provider state/accounting errors, and release checks that can report success without establishing the claimed result. The native viewport and project renderer also do substantially less than the public production-renderer description suggests.

The strongest locally reproduced failures were:

1. A sufficiently large `world.getReplay` or `renderer.extract` response exceeds the native 64 KiB response frame and terminates the native child.
2. The release PowerShell build and verification wrappers return process exit code 0 when their Python command fails.
3. The project schema accepts invalid object rotation data that the native hydration boundary later rejects.

## Critical and high-priority findings

### F-001 — Host wire revision authority is split across frontend clients

**Severity:** Critical · **Classification:** Confirmed

**Status:** Completed — transport-owned revision requests and the fake-host interleaving regression passed (`npm run protocol:verify`).

The transport owns the authoritative revision and rejects stale envelopes (`fbx-viewer (1)/host/nativeTransport.ts:68`, `fbx-viewer (1)/host/nativeTransport.ts:243`). `HostProviderService` reads that value before each call (`fbx-viewer (1)/services/HostProviderService.ts:297`), while `ProjectService` and `NativeEngineService` send separate cached revisions (`fbx-viewer (1)/utils/projectService.ts:276`, `fbx-viewer (1)/host/engine.ts:108`). Responses are not broadcast to peer clients (`fbx-viewer (1)/host/nativeTransport.ts:204`). A mutation through one service can therefore make the next call through another service stale before it reaches the requested host method.

### F-002 — Deferred frontend writes can mutate the wrong project

**Severity:** Critical · **Classification:** Confirmed risk

**Status:** Completed — editor-session leases now fence canonical, attachment, socket, and level queues; project-boundary verification and TypeScript typecheck passed.

Queued document closures do not capture a project identity or generation (`fbx-viewer (1)/utils/useNativeProjectDocument.ts:30`, `fbx-viewer (1)/utils/useNativeProjectDocument.ts:81`). `ProjectService.applyChanges` resolves the current project only when the closure eventually executes (`fbx-viewer (1)/utils/projectService.ts:162`), and the canonical change queue has the same current-project-at-execution behavior (`fbx-viewer (1)/utils/db.ts:131`). Attachment, socket, and level debouncers also retain timers and pending maps across project replacement (`fbx-viewer (1)/hooks/useAttachmentManager.ts:21`, `fbx-viewer (1)/hooks/useSocketManager.ts:10`, `fbx-viewer (1)/hooks/useLevelManager.ts:109`). Edits queued in project A can land in project B; failed sequential flushes clear work that is never requeued.

### F-003 — Switching native levels retains objects from the previous level

**Severity:** High · **Classification:** Confirmed

**Status:** Completed — native level switches now fetch and atomically publish the exact target object set; project-boundary verification passed.

Native hydration keeps objects for one selected level (`fbx-viewer (1)/hooks/useLevelManager.ts:310`). `loadLevel` changes only the selected ID (`fbx-viewer (1)/hooks/useLevelManager.ts:193`), while the object-fetching effect runs only in the legacy/no-native-project path (`fbx-viewer (1)/hooks/useLevelManager.ts:159`). Selecting level B after level A can therefore leave B selected with A's objects still in memory, rendering and editing the wrong state.

### F-004 — Project replacement leaks scene resources and is not atomic

**Severity:** High · **Classification:** Confirmed risk

**Status:** Completed — detached hydration, exact-once stale disposal, and synchronous resource/state publication are now verified by `npm run project:verify`.

`resetScene` is the explicit disposer and object-URL revoker (`fbx-viewer (1)/context/SceneContext.tsx:46`), but normal open, recent-open, recovery, and import do not call it (`fbx-viewer (1)/hooks/useProjectManager.ts:109`). Hydration clears live arrays without first disposing their Three.js resources and publishes asset categories progressively (`fbx-viewer (1)/hooks/useScenePersistence.ts:87`, `fbx-viewer (1)/hooks/useScenePersistence.ts:143`). Repeated switching can leak GPU objects, heap objects, and blob URLs, while cancellation or failure can leave a partially replaced project visible.

### F-005 — Partial asset failures are reported as a successful project open

**Severity:** High · **Classification:** Confirmed

**Status:** Completed — any staged asset hydration failure now aborts before publication and is surfaced as a failed open; project-boundary verification and TypeScript typecheck passed.

Texture, audio, model, animation, and attachment failures are reduced to diagnostics during hydration (`fbx-viewer (1)/hooks/useScenePersistence.ts:152`, `fbx-viewer (1)/hooks/useScenePersistence.ts:188`, `fbx-viewer (1)/hooks/useScenePersistence.ts:281`). Hydration still publishes its staged arrays and returns success (`fbx-viewer (1)/hooks/useScenePersistence.ts:271`), after which the project manager emits its success notification (`fbx-viewer (1)/hooks/useProjectManager.ts:48`). A corrupt or missing asset can silently disappear while the user is told the project opened successfully.

### F-006 — Level rotations are stored in degrees and rendered as radians

**Severity:** High · **Classification:** Confirmed

**Status:** Completed — authored rotations now persist as Three.js XYZ radians consistently; project-boundary verification and TypeScript typecheck passed.

Transform controls emit Euler radians and convert them to degrees before persistence (`fbx-viewer (1)/components/Environment/EnvironmentScene.tsx:324`). Both level render paths pass stored rotations directly to Three.js (`fbx-viewer (1)/components/Environment/InstancedLevelLayer.tsx:91`, `fbx-viewer (1)/components/Environment/LevelObjectRenderer.tsx:153`), while foliage creation stores radians (`fbx-viewer (1)/components/Environment/FoliageBrushTool.tsx:107`). A 90-degree edit is persisted as `90` and then interpreted as 90 radians; creation and edit paths also disagree on units.

### F-007 — Quad view creates four independent audio systems

**Severity:** High · **Classification:** Confirmed

**Status:** Completed — quad mode now mounts one audio system, and stale asset callbacks are identity-fenced; project-boundary verification and TypeScript typecheck passed.

Quad mode mounts four `EnvironmentScene` instances (`fbx-viewer (1)/components/Environment/EnvironmentViewport.tsx:201`), and every scene unconditionally mounts an `AudioSystem` (`fbx-viewer (1)/components/Environment/EnvironmentScene.tsx:404`). Each audio system creates and autoplays its own sources (`fbx-viewer (1)/components/Environment/AudioSystem.tsx:55`). An autoplay emitter can play four times and consume four sets of audio resources; stale asynchronous loads can also attach after an asset change.

### F-008 — Cyclic blueprint graphs can recurse until the editor crashes or freezes

**Severity:** High · **Classification:** Confirmed

**Status:** Completed — blueprint evaluation/execution now use bounded path-aware recursion, and zero divisors remain zero; project-boundary verification and TypeScript typecheck passed.

Data evaluation and execution flow recurse without a visited set, cycle check, or depth budget (`fbx-viewer (1)/hooks/useLevelBlueprintRuntime.ts:66`, `fbx-viewer (1)/hooks/useLevelBlueprintRuntime.ts:202`). A persisted data or execution cycle can overflow the stack or loop synchronously. The same implementation also coerces a zero divisor to one before checking for zero (`fbx-viewer (1)/hooks/useLevelBlueprintRuntime.ts:143`), making its intended divide-by-zero path unreachable for literal zero.

### F-009 — Custom HUD code can synchronously freeze the editor

**Severity:** High · **Classification:** Confirmed risk

**Status:** Completed — compiled HUD loops/functions now receive a step/deadline guard inside the sandbox; frame invariants and production build passed.

Custom code is compiled in the parent and executed synchronously with `new Function` in the iframe (`fbx-viewer (1)/components/HUDEditor/DynamicHUDComponent.tsx:38`, `fbx-viewer (1)/hud-frame.tsx:48`). The sandbox and CSP restrict origin and network behavior but provide no CPU or memory isolation. Code such as an infinite loop blocks the renderer process. This is a denial-of-service boundary, not a claim of iframe escape.

### F-010 — Oversized native responses terminate the native engine

**Severity:** High · **Classification:** Confirmed and locally reproduced

Both request and response frames are capped at 64 KiB (`native/src/main.rs:298`, `native/src/main.rs:325`). `world.getReplay` and `renderer.extract` serialize complete, unpaged structures (`native/src/main.rs:741`, `native/src/main.rs:1212`, `native/src/main.rs:1271`), and a response write error escapes the IPC loop (`native/src/main.rs:1758`). A 400-entity world was sufficient for each call to terminate the child with exit code 1. The trace is marked successful before the failing write (`native/src/main.rs:1754`), so diagnostics can also record the failed operation as completed.

### F-011 — A timed-out native call permanently desynchronizes later responses

**Severity:** High · **Classification:** Confirmed

**Status:** Completed — response timeouts now invalidate and tear down the transport before any late frame can be consumed; the native-engine timeout/late-call regression passed (20 tests).

The host times out while leaving the child and response queue intact (`Auvra/desktop/native_engine.py:479`, `Auvra/desktop/native_engine.py:510`). A late response for request N remains queued; request N+1 consumes it and fails the ID check (`Auvra/desktop/native_engine.py:519`). Later responses remain shifted, so one slow call can poison every subsequent native call until restart.

### F-012 — Host queue saturation silently drops requests

**Severity:** High · **Classification:** Confirmed

**Status:** Completed — saturated browser requests now receive an immediate validated, retryable `locking` response; the controller regression suite passed (16 tests).

The desktop controller has a 64-slot request semaphore (`Auvra/desktop/controller.py:133`). When acquisition fails, it logs and returns without posting a protocol error (`Auvra/desktop/controller.py:426`). The browser receives no immediate bounded busy response and instead waits for the transport's 15-second or 120-second request timeout (`fbx-viewer (1)/host/nativeTransport.ts:9`, `fbx-viewer (1)/host/nativeTransport.ts:132`).

### F-013 — Autosave I/O failure can shut down the desktop controller

**Severity:** High · **Classification:** Confirmed risk

**Status:** Completed — autosave failures are isolated from the controller tick, retained as a dirty period, diagnosed, and retried on a bounded cadence; project-host regression tests passed (15 tests).

The project host calls `active.autosave()` without isolating I/O exceptions (`Auvra/desktop/project_host.py:140`). The controller's main loop does not catch failures from `project_host.tick()` locally (`Auvra/desktop/controller.py:374`). Disk-full, permissions, removed-volume, or similar autosave failures can therefore escape the loop and initiate application shutdown.

### F-014 — Archive validation and extraction have a pathname TOCTOU

**Severity:** Critical · **Classification:** Demonstrated security risk

**Status:** Completed — archive validation and extraction now share one open `ZipFile` handle, eliminating the validation/reopen pathname race; repository archive tests passed (42 passed, 1 skipped), including a same-handle regression.

Import validates an archive, closes it, and later reopens the same path for extraction (`Auvra/project/repository.py:352`). The validated member and size rules live in `Auvra/project/archive.py:25`, but the second archive is not revalidated before paths are joined under staging. An actor able to replace the file between opens can substitute traversal members or exceed the validated limits.

### F-015 — Partial recovery points are publishable and missing domains restore as empty

**Severity:** High · **Classification:** Confirmed

**Status:** Completed — recovery points are atomically staged and marker-published, require every domain, and snapshot/restore the content store and manifest; repository recovery coverage passed (43 passed, 1 skipped).

The final recovery directory is created before its files are copied, with no completion marker (`Auvra/project/repository.py:287`, `Auvra/project/repository.py:317`). Every directory can be listed as a recovery point, and restore substitutes an empty domain document for any missing file (`Auvra/project/repository.py:342`). A crash or copy failure can expose a partial point whose restore silently deletes domain data. Recovery points also do not snapshot assets, so otherwise complete JSON can later reference missing content.

### F-016 — Re-ingesting authentic content cannot repair a corrupt hash-named asset

**Severity:** High · **Classification:** Confirmed

**Status:** Completed — same-digest ingestion now verifies existing content and atomically repairs corrupt/truncated blobs before manifest publication; the asset repair regression and repository suite passed (44 passed, 1 skipped).

Asset ingestion verifies the new temporary content, but if the digest-named target already exists it discards the new file without verifying the existing blob (`Auvra/project/assets.py:66`, `Auvra/project/assets.py:71`). A corrupt file at the correct name is therefore preserved even when authentic content is re-uploaded, and ingestion reports the expected asset ID.

### F-017 — Save-as and import publish projects before required authority directories exist

**Severity:** High · **Classification:** Confirmed crash-consistency bug

**Status:** Completed — Save As and import now create the `.auvra/transactions` authority inside the staged tree before atomic publication; repository tests passed (45 passed, 1 skipped), including rename-boundary assertions.

Save-as and import move staging into the visible destination before creating required `.auvra` internal directories (`Auvra/project/repository.py:281`, `Auvra/project/repository.py:368`). Open-time boundary validation requires those directories (`Auvra/project/repository.py:504`). A crash between publication and directory creation leaves a destination that exists but cannot be opened.

### F-018 — Command undo can erase unrelated changes made after approval

**Severity:** High · **Classification:** Confirmed

**Status:** Completed — command undo now requires the live project revision to equal the approved transaction revision and rejects intervening edits; provider-host regression coverage passed (4 tests).

Provider command approval stores a full pre-change HUD snapshot (`Auvra/desktop/provider_host.py:657`). Undo checks project and transaction identity but does not require the current revision to match the approved transaction's result revision (`Auvra/desktop/provider_host.py:700`). Restoring the old full snapshot after a later HUD edit deletes the intervening work.

### F-019 — Cancellation during execution can leave a durable job stuck in `cancel_requested`

**Severity:** High · **Classification:** Confirmed

**Status:** Completed — a remote success racing cancellation now closes the durable lifecycle as terminal `cancelled`, and the worker emits that terminal state; provider-core coverage passed (29 tests, 16 subtests).

When a worker eventually succeeds after cancellation was requested, it calls reconciliation (`Auvra/desktop/provider_host.py:772`, `Auvra/desktop/provider_host.py:788`). Reconciliation intentionally retains `CANCEL_REQUESTED` on a success result (`Auvra/providers/jobs.py:289`). The worker then exits, leaving the terminal operation represented as in progress for the remainder of the current process. Restart reconciliation eventually fails non-durable jobs or moves durable jobs into recovery (`Auvra/providers/jobs.py:271`).

### F-020 — Retry spend is charged to the original job date

**Severity:** High · **Classification:** Confirmed financial-control defect

**Status:** Completed — durable cost reservations are timestamped as append-only events, legacy rows are backfilled, and retry charges are bucketed by their reservation time; provider-core coverage passed (30 tests, 16 subtests).

Cost updates accumulate on a job, while totals bucket the entire cumulative amount by the job's original `created_at` (`Auvra/providers/jobs.py:229`). Budget enforcement uses those totals (`Auvra/desktop/provider_host.py:859`). Retrying an old job today can attribute today's spend to an older day or month and bypass the current period's cap.

### F-021 — Update and delete command proposals are rejected before target validation

**Severity:** High · **Classification:** Confirmed

**Status:** Completed — structured command workers now pass the host-selected target binding into provider completion, making update/delete proposals reachable and safely constrained; provider-host coverage passed (5 tests).

The provider host calls `adapter.complete()` without a target element ID (`Auvra/desktop/provider_host.py:731`). The adapter consequently permits only create operations (`Auvra/providers/adapters.py:123`), so update/delete proposals fail before the later host-side revalidation that has the saved target (`Auvra/providers/commands.py:44`). The advertised update/delete flow is unreachable through the normal job path.

### F-022 — Provider model discovery depends on prior call order

**Severity:** High · **Classification:** Confirmed functional defect

**Status:** Completed — `listModels` now instantiates and queries its adapter directly, independent of prior health calls or injected transports; fresh local-provider discovery regression and provider-host coverage passed (6 tests).

Dynamic provider descriptors start with no models (`Auvra/providers/descriptors.py:95`). `listModels` invokes an adapter only if one already exists or an injected transport is present (`Auvra/desktop/provider_host.py:401`, `Auvra/desktop/provider_host.py:830`). Cloud health can instantiate an adapter incidentally, while Ollama and llama.cpp health return before doing so. Normal local-provider model discovery can therefore remain empty and prevent configuration.

### F-023 — Windows job containment begins after the child is already running

**Severity:** High · **Classification:** Confirmed risk

**Status:** Completed — Windows children launch suspended, are assigned to the private kill-on-close Job Object, and resume only after successful assignment; process lifecycle coverage passed (10 tests).

Launcher processes are created before assignment to the Windows job object (`Auvra/launcher/process.py:53`, `Auvra/launcher/platform/windows_job.py:79`), and creation flags do not include `CREATE_SUSPENDED` (`Auvra/launcher/platform/windows_job.py:15`). A fast child can spawn descendants before containment. If assignment then fails, killing the root does not guarantee recovery of already escaped descendants.

### F-024 — The native engine is not owned as a process tree

**Severity:** High · **Classification:** Confirmed risk

**Status:** Completed — native children now launch inside a private POSIX process group or suspended Windows Job Object, shutdown and transport failure terminate the owned tree, and startup-exit cleanup plus native/launcher process-tree regressions passed.

The native engine uses raw `subprocess.Popen` with `CREATE_NO_WINDOW` and no job object (`Auvra/desktop/native_engine.py:288`). Shutdown terminates or kills only the root PID (`Auvra/desktop/native_engine.py:622`). Any descendants can survive ordinary close, timeout recovery, or host failure.

### F-025 — Provider shutdown can hang indefinitely despite its timeout

**Severity:** High · **Classification:** Confirmed

**Status:** Completed — shutdown now uses a single bounded grace window, signals cooperative worker cancellation, avoids executor `wait=True`, and defers durable-store closure until any still-running worker exits; the blocked-future regression passed (7 provider-host tests).

Shutdown waits briefly for futures and ignores incomplete work, then calls executor shutdown with `wait=True` (`Auvra/desktop/provider_host.py:251`). Workers have no cooperative cancellation token and may be blocked in network or polling code. The apparent bounded shutdown is therefore followed by an unbounded wait.

### F-026 — A hung WebView thread skips owned-browser cleanup

**Severity:** High · **Classification:** Confirmed

**Status:** Completed — close now treats join failures/timeouts as a cleanup path, terminates the owned browser tree before raising, and handles pre-thread startup cleanup; WebView and controller lifecycle regressions passed (27 tests, 1 skipped).

When the UI thread remains alive after its join timeout, WebView close raises before `_terminate_owned_browser()` is reached (`Auvra/desktop/webview2.py:196`, `Auvra/desktop/webview2.py:215`). Controller cleanup cannot complete that skipped branch (`Auvra/desktop/controller.py:639`). Browser descendants and profile locks can survive shutdown.

### F-027 — The native viewport renders one frame and stops processing events

**Severity:** High · **Classification:** Confirmed

**Status:** Completed — the native runtime now keeps IPC responsive while repeatedly pumping the viewport event loop, handles close/resize/redraw events, and presents current world extraction on each tick; native cargo tests passed (34 tests) and the viewport source regression passed.

The viewport event handler exits immediately after creating the window and again from `about_to_wait` (`native/src/main.rs:503`, `native/src/main.rs:532`). Open configures the surface and calls `present_surface` exactly once (`native/src/main.rs:545`, `native/src/main.rs:593`); recovery renders one additional frame (`native/src/main.rs:646`). There is no live redraw, resize, or close-event pump after open, so later world changes are not displayed.

## Other product, integrity, and release findings

### F-028 — Public engine snapshots silently stop at 128 entities

**Severity:** High · **Classification:** Confirmed

**Status:** Completed — the host now requests and validates every bounded native snapshot page, aggregates all entities up to the protocol limit, and preserves compatibility with legacy one-page engines; 24 native-engine tests passed, including a 300-entity regression.

Native snapshot methods default to 128 entities and cap a page at 256 (`native/src/main.rs:827`, `native/src/main.rs:905`). The host calls `world.getSnapshot` without paging and projects only the returned entities, discarding page metadata (`Auvra/desktop/native_engine.py:1114`). The public result schema has no paging fields (`protocol/v1/auvra-host.schema.json:124`). Worlds larger than 128 entities are silently truncated at the browser boundary.

### F-029 — Several state-changing methods do not advance the host revision

**Severity:** Medium · **Classification:** Confirmed

**Status:** Completed — credential configure/delete, provider settings, and media discard are now explicit mutating boundaries; successful built-in mutations and sequenced dispatcher requests advance the authoritative session revision; 15 dispatcher tests passed.

The mutating-method set omits credential configuration/deletion, provider configuration, and media discard (`Auvra/host/dispatcher.py:27`). Those methods change durable or session state (`Auvra/desktop/provider_host.py:301`, `Auvra/desktop/provider_host.py:549`) while retaining the same protocol revision, weakening ordering and concurrency guarantees.

### F-030 — Event revisions advance before event validation succeeds

**Severity:** Medium · **Classification:** Confirmed

**Status:** Completed — events are built and validated against the prospective revision before session advancement, and bound-event batches are restored if conversion fails; invalid-event regressions passed (17 dispatcher tests).

`make_event` advances session state before constructing and validating the event (`Auvra/host/dispatcher.py:280`). Bound service queues are drained before all conversions complete (`Auvra/host/dispatcher.py:315`). One invalid generated event can therefore consume the batch and advance revisions without delivering it. The transport accepts nonconsecutive revisions, so the observable result is a lost event batch and an unexplained revision skip rather than a permanent protocol deadlock (`fbx-viewer (1)/host/nativeTransport.ts:200`).

### F-031 — Recovery events omit details and force a status refresh

**Severity:** Low to Medium · **Classification:** Confirmed

**Status:** Completed — recovery events now include the bounded recovery-point list and the newly created point's opaque ID/kind; the canonical event schema and generated validator accept the payload, and focused project/dispatcher plus protocol verification passed.

Project status includes recovery points, but the project-event filter forwards only a small field subset and omits both `recoveryPoints` and a specific recovery ID (`Auvra/desktop/project_host.py:241`, `Auvra/desktop/project_host.py:307`). The generated protocol shape itself does permit `recoveryPoints` (`Auvra/host/generated/protocol_v1.py:39`). The frontend detects the missing ID and performs a separate status refresh (`fbx-viewer (1)/utils/projectService.ts:349`), so choices are delayed by an avoidable extra request rather than unavailable.

### F-032 — Upload responses above 64 KiB are silently truncated

**Severity:** Medium · **Classification:** Confirmed

**Status:** Completed — upload responses are consumed to EOF in bounded chunks, oversize bodies are rejected, and declared lengths are checked; focused provider transport regressions passed.

The production provider upload transport performs one bounded response read (`Auvra/providers/transport.py:141`, `Auvra/providers/transport.py:163`). It neither continues to EOF nor validates declared length, unlike normal request handling. A valid response larger than 64 KiB but below the configured maximum is returned incomplete.

### F-033 — Stream and upload forward caller-controlled connection headers

**Severity:** Medium · **Classification:** Latent network-policy risk

**Status:** Completed — stream/upload now strip hop-by-hop connection headers consistently with normal requests, and upload owns its framing headers; focused transport regressions passed.

Normal requests strip `Host` and `Connection` headers (`Auvra/providers/transport.py:74`), while stream and upload copy them (`Auvra/providers/transport.py:118`, `Auvra/providers/transport.py:153`). A future adapter that accepts arbitrary headers could send a misleading virtual-host value to an otherwise allowlisted resolved endpoint. No current end-to-end exploit path was established.

### F-034 — Valid nested plugin entrypoints install but cannot run

**Severity:** Medium · **Classification:** Confirmed

**Status:** Completed — nested entrypoint paths are preserved during install, validated beneath the digest root, included in ACL coverage, and accepted by the worker launcher; the full plugin suite passed.

Package validation accepts a nested entrypoint such as `payload/subdir/plugin.exe` (`Auvra/plugins/package.py:145`). Installation flattens it to its basename (`Auvra/plugins/install.py:101`), while reopen checks the original nested path and worker isolation requires `payload\\<basename>` (`Auvra/plugins/worker.py:164`). A package accepted by the manifest validator can therefore become unusable after installation.

### F-035 — `save()` marks a project clean before recovery retention succeeds

**Severity:** Medium · **Classification:** Confirmed

**Status:** Completed — recovery retention now succeeds before the repository clears its dirty flag; injected retention failures preserve dirty state, and the repository suite passed.

`save()` clears `_dirty` and only then retains a recovery point (`Auvra/project/repository.py:256`). If backup creation fails, save raises while the repository remains marked clean, misreporting state and potentially suppressing later autosave behavior.

### F-036 — Save/export destinations are not excluded from the source project tree

**Severity:** High · **Classification:** Confirmed risk

**Status:** Completed — Save As and pack export now reject paths resolving inside the live project tree before creating staging or temporary output; repository regressions passed.

`save_as()` and `export_pack()` do not reject destinations within the active project (`Auvra/project/repository.py:261`, `Auvra/project/repository.py:348`). Save-as can recursively encounter its own staging/destination subtree; export can introduce an unknown top-level archive that makes strict project validation fail.

### F-037 — Preview lookup crosses project boundaries

**Severity:** High · **Classification:** Confirmed isolation risk

**Status:** Completed — preview records are internally project-bound and all project/provider lookup, commit, discard, and ingest paths pass the active project identity; cross-project resolution regressions passed.

The session preview store resolves solely by content hash and has no project binding (`Auvra/desktop/previews.py:146`). When an active project lacks an asset, resolution falls back to that global store (`Auvra/desktop/project_host.py:598`). Project B can resolve project A's uncommitted preview if its hash is known.

### F-038 — Download staging copies persist for the entire desktop session

**Severity:** High · **Classification:** Confirmed storage concern

**Status:** Completed — staged download files are owned by their response streams, removed on close or EOF, and purged when tickets expire or the asset session closes; asset and WebView2 lifecycle tests passed.

Every download stream creates a verified private staging copy (`Auvra/desktop/assets.py:284`, `Auvra/desktop/assets.py:466`). Consuming or expiring the ticket removes registry state but not the staged file; files are deleted only when the whole registry closes (`Auvra/desktop/assets.py:510`). Repeated large downloads can consume unbounded disk during a long session.

### F-039 — Assets are committed before referencing project mutations succeed

**Severity:** High · **Classification:** Confirmed

**Status:** Completed — pending uploads are tracked and discarded when project mutations fail or sessions close; media commit validates targets before ingestion, rolls back newly ingested blobs on failure, and treats post-commit preview cleanup as best effort; focused repository, project-host, and provider-host tests passed.

Upload completion and media commit ingest permanent project blobs before the project mutation and all validation complete (`Auvra/desktop/project_host.py:570`, `Auvra/desktop/provider_host.py:567`). Revision or target validation failure leaves orphan content, and there is no asset garbage collector. A preview-discard failure after a successful apply can also report overall failure even though the project already changed.

### F-040 — Hydration defers most asset cooking with no retry path

**Severity:** High · **Classification:** Confirmed

**Status:** Completed — hydration uses the worker’s bounded deferred-ingestion path for the full asset set, retains only an explicit safety-cap backlog for retry, and no longer drops queue tails at 256; native queue and hydration regression tests passed.

The cooker queue capacity defaults to eight (`native/src/assets.rs:36`, `native/src/assets.rs:73`). Hydration attempts up to 256 assets once; queue-full submissions and all later assets are merely counted as deferred (`native/src/main.rs:1171`). No host or frontend consumer was found for `assetJobsDeferred`, so a project can remain permanently only partly cooked.

### F-041 — Asset jobs outlive project close and retain stale bookkeeping

**Severity:** Medium · **Classification:** Confirmed

**Status:** Completed — project close cancels owned asset tokens and pending IDs, terminal app tokens are reaped, and early-cancel worker paths trim terminal records; native lifecycle regressions passed.

Project close clears the app's token map without cancelling tokens (`native/src/main.rs:1163`). Worker records retain cloned tokens, so old cooking continues and can occupy the queue after another project opens. Completed app tokens are never removed (`native/src/main.rs:1240`, `native/src/main.rs:1260`), and the early-cancel worker path skips terminal-record trimming (`native/src/assets.rs:292`, `native/src/assets.rs:299`).

### F-042 — Project schemas accept transforms that native hydration rejects

**Severity:** High · **Classification:** Confirmed and locally reproduced

**Status:** Completed — object transforms are canonicalized and bounded before the native boundary converts Euler rotations to normalized four-value quaternions; socket transforms now enforce the same finite, fixed-width contract (including native-safe position and scale bounds), with legacy quaternions normalized before schema validation. Full Python validation passed (`344 passed, 5 skipped, 77 subtests`).

The object schema constrains `position` but leaves `rotation` and `scale` as arbitrary arrays (`project/v1/objects.schema.json:1`); socket transforms are similarly unconstrained (`project/v1/sockets.schema.json:1`). Native hydration requires exactly four numeric rotation values and three numeric scale values (`native/src/main.rs:1510`, `native/src/main.rs:1566`, `native/src/main.rs:1602`). The Python validator accepted `rotation: ["not", "a", "quaternion"]`, creating project data that passes persistence validation but cannot hydrate natively.

### F-043 — The visible viewport bypasses the production render pipeline

**Severity:** High · **Classification:** Confirmed implementation mismatch

**Status:** Completed — the viewport now renders through the shared production pass encoder directly into the swapchain, including shadow/depth passes, HDR PBR lighting, picking, gizmos, and post-processing; the obsolete flat surface pipeline was removed and native tests passed.

The visible surface calls `present_extraction`, which allocates a simple vertex buffer and uses the flat surface pipeline (`native/src/gpu.rs:471`, `native/src/gpu.rs:1032`). That shader only passes through 2D positions and colors; it has no depth, PBR, lights, shadows, post-processing, or antialiasing. The more elaborate offscreen pipeline is used by `renderer.renderReference`, not the interactive viewport (`native/src/main.rs:743`).

### F-044 — Native project extraction discards most authored renderer data

**Severity:** High · **Classification:** Confirmed implementation mismatch

**Status:** Completed — renderer-authority domains now cross the native boundary; extraction preserves authored materials, texture overrides, LODs, animations, visibility, selection, radii, lights, camera, IBL, post/AA settings, and entity transforms, while GPU submission consumes rotation, scale, and depth instead of discarding those fields. Native and full Python regression suites passed.

Real project entities receive hard-coded material, LOD, animation, camera, lighting, IBL, and post-effect values (`native/src/main.rs:1276`). Project hydration maps only models, objects, and levels, sets lights and animation to none, and ignores the remaining project domains (`native/src/main.rs:1396`, `native/src/main.rs:1514`). GPU geometry is a projected triangle per entity and ignores actual mesh contents, rotation, scale, and depth (`native/src/gpu.rs:536`, `native/src/gpu.rs:619`). The hard-coded `basic` reference scene does not establish rendering of authored project content.

### F-045 — MSAA is not implemented and the FXAA label is misleading

**Severity:** Medium · **Classification:** Confirmed

**Status:** Completed — requested MSAA sample counts now select cached multisample scene color/depth pipelines and resolve into a single-sample HDR target before post-processing; FXAA is enabled only by its explicit flag/effect, and native unit plus headless GPU validation passed.

All render textures use `sample_count: 1` (`native/src/gpu.rs:513`). Requesting MSAA merely enables the post-process `use_fxaa` flag (`native/src/gpu.rs:658`); the shader never uses `requested_msaa` and applies a simple five-neighbor blur (`native/src/gpu.rs:915`, `native/src/gpu.rs:934`). Capabilities nevertheless advertise every render feature (`native/src/gpu.rs:17`).

### F-046 — Renderer metrics report placeholders as operational measurements

**Severity:** Medium · **Classification:** Confirmed

**Status:** Completed — GPU timestamp queries now populate `gpu_frame_ms` when supported, unsupported adapters retain an explicit fallback, sample-variant cache hits/misses reflect real lookups, and memory reports tracked renderer buffers/textures/readbacks instead of a width×height placeholder; native, live GPU, and full Python suites passed.

`last_gpu_ms` is initialized but never assigned, so GPU time remains unavailable despite timestamp feature detection (`native/src/main.rs:346`, `native/src/main.rs:468`). Reference renders increment cache hits without an actual lookup, misses remain zero, and reported memory is essentially width × height × 4 rather than total renderer allocation (`native/src/main.rs:415`). These values can mislead diagnostics and performance decisions.

### F-047 — The native session token is not authenticated

**Severity:** Low · **Classification:** Defense-in-depth concern

Startup checks only that `AUVRA_NATIVE_SESSION_TOKEN` exists and has a valid shape (`native/src/main.rs:1993`). `session.hello` then authenticates unconditionally without receiving or comparing the token (`native/src/main.rs:703`); the Python hello payload contains only an editor session ID (`Auvra/desktop/native_engine.py:297`). Private inherited stdio limits exposure, but the token should not be described as an authentication control.

**Status:** Completed — native `session.hello` now requires a fresh challenge and constant-time HMAC-SHA256 proof derived from the inherited session token; the token never crosses the request frame, invalid proofs remain unauthenticated, and native, Python, and live transport validation passed.

### F-048 — GPU initialization is mandatory for non-renderer native services

**Severity:** Medium · **Classification:** Reliability concern

`App::new` constructs the renderer before serving any IPC (`native/src/main.rs:675`, `native/src/main.rs:691`). If adapter discovery or required GPU features fail, native world, replay, and asset-cooker services are also unavailable even though they do not inherently need a GPU. The WebGL fallback therefore cannot preserve those services.

**Status:** Completed — renderer initialization is now optional; native session, world, replay, hydration, and asset services remain available when GPU setup fails, while capabilities and metrics expose the renderer fallback and render/viewport requests return an explicit unsupported-capability response. Native failure-path and full native tests passed.

### F-049 — Large native worlds have avoidable clone, thread, and lookup costs

**Severity:** Medium · **Classification:** Performance concern

World advance clones the complete world and replay state and clones all entities per step (`native/src/world.rs:448`, `native/src/world.rs:477`, `native/src/world.rs:523`). When more than one worker is requested, every step also spawns a fresh set of scoped OS threads (`native/src/world.rs:528`). Paged snapshots still create and hash a full snapshot first (`native/src/main.rs:827`). Rendering finds every batch entity with a linear scan and rebuilds/uploads a GPU vertex buffer (`native/src/gpu.rs:536`, `native/src/gpu.rs:471`), producing quadratic lookup behavior and allocation churn.

**Status:** Completed — bounded advances now compute position updates from borrowed entities in one worker scope without cloning the full world/replay state, cached world hashes make paged snapshots clone only the requested page, indexed extraction removes quadratic batch/gizmo lookups, and reusable GPU buffers avoid per-frame geometry/uniform allocation churn. Native unit and live headless/render validation passed.

### F-050 — Release PowerShell wrappers return success after Python failures

**Severity:** High · **Classification:** Confirmed and locally reproduced

`release/build.ps1`, `release/verify.ps1`, and `release/stage_inputs.ps1` invoke Python without checking `$LASTEXITCODE` or exiting with it (`release/build.ps1:13`, `release/verify.ps1:10`, `release/stage_inputs.ps1:40`). Both build and verify wrappers printed underlying failures for missing inputs but returned process exit code 0. Any caller relying on the wrapper status can publish or accept a failed release step.

**Status:** Completed — each release wrapper now propagates every Python subprocess exit code, and the Windows regression tests reproduce missing-input failures with the expected non-zero status.

### F-051 — Runtime pin markers do not attest the extracted runtime contents

**Severity:** High · **Classification:** Supply-chain risk

Release assembly hashes whatever staged files it receives (`release/pipeline.py:162`), while runtime-pin validation compares only marker strings to policy (`release/pipeline.py:179`). It does not reconstruct or verify the extracted tree against the pinned archive. A modified cached tree accompanied by a copied valid marker passes this boundary and becomes self-consistent in the newly generated manifest.

**Status:** Completed — runtime acquisition now records a per-file size and SHA-256 attestation for each extracted pinned tree, and assembly recomputes that attestation before accepting the marker; tampering an extracted file with a copied marker is rejected by regression coverage.

### F-052 — Signing exposes the certificate password and does not verify the result

**Severity:** High · **Classification:** Confirmed security/release concern

The CLI accepts a plaintext `--password` (`release/pipeline.py:626`) and places it in the SignTool command line with `/p` (`release/pipeline.py:590`). It can be exposed through process inspection or shell history. The signing function also supplies no timestamp service and performs no post-sign `signtool verify`, so success means only that the sign command returned zero.

**Status:** Completed — signing now uses a certificate-store thumbprint or passwordless PFX without a password CLI option, requires an HTTPS timestamp service, and verifies the signed MSIX with SignTool before returning success. Command-level regression tests passed.

### F-053 — NUL bytes bypass release content scanning

**Severity:** Medium · **Classification:** Confirmed verification weakness

The release scanner treats any file whose first 4096 bytes contain NUL as binary and skips all content scans (`release/pipeline.py:129`, `release/pipeline.py:145`). UTF-16 text and crafted files can therefore bypass secret-like, absolute-path, private-content, and runtime-CDN detection. Filename and suffix checks still apply.

**Status:** Completed — content scanning now checks rolling raw and NUL-normalized windows, preserving bounded streaming behavior while detecting UTF-16 and crafted interleaved-NUL secret-like content. The new UTF-16 regression and release suite passed.

### F-054 — The generated SBOM omits most dependency identities

**Severity:** Medium · **Classification:** Confirmed completeness concern

The SBOM lists Auvra, CPython, and two WebView components (`release/pipeline.py:308`). Python site-packages are recorded only as anonymous file artifacts; Rust crates and frontend packages are not components at all. The output is not a useful complete dependency/license inventory for incident response or redistribution review.

**Status:** Completed — SBOM assembly now includes stable npm, Cargo, and uv-lock dependency components (with purls and available hashes), discovers shipped Python distribution metadata, and preserves per-file artifacts and license files. Release tests assert identities across all three ecosystems.

### F-055 — Hosted update metadata accepts non-HTTPS locations

**Severity:** Medium · **Classification:** Security configuration concern

`--appinstaller-uri` is a free string (`release/pipeline.py:618`), and generation/validation checks XML structure but not scheme or origin (`release/pipeline.py:326`, `release/pipeline.py:344`). Stable or beta update metadata can therefore be generated with `http:`, `file:`, or another unsuitable location.

**Status:** Completed — hosted App Installer metadata now requires a credential-free HTTPS `.appinstaller` URL on a public origin, with loopback/private/local targets rejected at generation and companion publication. Secure/insecure URI regression coverage passed.

### F-056 — Cross-backend verification does not compare rendered output

**Severity:** Medium · **Classification:** Confirmed verification gap

Cross-backend verification deliberately permits different pixel signatures and merely reports whether they match (`release/cross_backend.py:80`). It checks scene label and dimensions, so radically different WebGL and native pixels can pass. The current test explicitly accepts fabricated mismatched signatures (`tests/release/test_release_pipeline.py:166`).

**Status:** Completed — cross-backend evidence now validates canonical hexadecimal render digests and fails closed when the WebGL and native signatures differ; regression coverage proves both mismatch rejection and prefix/case-normalized matching.

## Frontend correctness and usability findings

### F-057 — Initial restore races itself under React StrictMode

**Severity:** High in development, Medium otherwise · **Classification:** Confirmed risk

The root enables `StrictMode` (`fbx-viewer (1)/index.tsx:20`), while the mount effect starts asynchronous restore without cleanup or a generation guard (`fbx-viewer (1)/hooks/useScenePersistence.ts:666`). React development replay launches two restores; whichever completes last wins, without disposal of the other result. The stale-completion race also exists on unmount or project change in production.

**Status:** Completed — initial restore is transition-scoped and abortable before its first await; cleanup aborts the controller and invalidates the transition, while hydration checks project identity/generation before publication and disposes detached results. Project-boundary verification covers StrictMode setup/cleanup/setup and stale completion rejection; TypeScript typecheck passes.

### F-058 — Duplicate selection authorities leave stale model and blueprint state

**Severity:** High · **Classification:** Confirmed

`useModelManager` owns a private selected ID while the UI uses `SelectionContext` (`fbx-viewer (1)/hooks/useModelManager.ts:20`, `fbx-viewer (1)/context/AssetContext.tsx:96`). Removal does not clear the UI authority, and the viewer filters using that stale ID (`fbx-viewer (1)/components/Scene/ViewerScene.tsx:94`). Blueprint manager/editor repeat the same split (`fbx-viewer (1)/hooks/useBlueprintManager.ts:9`, `fbx-viewer (1)/components/Blueprint/BlueprintEditor.tsx:13`). Deleting a selected item can hide remaining models or leave an unusable selection.

**Status:** Completed — model and blueprint managers now consume the shared `SelectionContext` instead of keeping private selected IDs. Conditional clear actions prevent stale asynchronous deletes from clearing a newer selection, and placement/removal no longer performs a second competing synchronization. Project-boundary verification and TypeScript typecheck pass.

### F-059 — FBX cancellation neither stops parsing nor disposes late output

**Severity:** High · **Classification:** Confirmed

The abort listener covers only the worker phase and is removed before `GLTFLoader.parseAsync` runs on the main thread (`fbx-viewer (1)/utils/modelLoader.ts:70`, `fbx-viewer (1)/utils/modelLoader.ts:111`). Abort is checked only after parsing, and the error path does not dispose a scene produced before cancellation or a later normalization failure (`fbx-viewer (1)/utils/modelLoader.ts:139`). Cancel can therefore leave expensive CPU work running and leak the discarded scene.

**Status:** Completed — the main-thread GLTF handoff now races cancellation, observes late parser failures, disposes a scene produced after cancellation, and the outer loader disposes any partially normalized scene before revoking its URL. Project verification, TypeScript, and production frontend build pass.

### F-060 — Graph preview mutates canonical model materials

**Severity:** High · **Classification:** Confirmed

`GraphPreview` receives the shared model object and writes newly loaded textures directly into its materials (`fbx-viewer (1)/components/AnimationGraph/GraphPreview.tsx:58`, `fbx-viewer (1)/components/AnimationGraph/GraphPreview.tsx:84`). It neither restores old maps nor disposes replacement textures. Merely changing or closing a preview can permanently change the model used elsewhere and leak texture resources.

**Status:** Completed — graph previews now render a skeleton-aware, material/texture-owned clone (including attachments), load overrides with cancellation, restore the cloned base maps, and dispose only preview-owned resources. Project verification, TypeScript, and production frontend build pass.

### F-061 — Failed optimistic mutations leave UI and host state divergent

**Severity:** Medium · **Classification:** Confirmed pattern

Graph, blueprint, socket, level, and model-placement managers update local state but generally only log persistence failures (`fbx-viewer (1)/hooks/useGraphManager.ts:12`, `fbx-viewer (1)/hooks/useBlueprintManager.ts:50`, `fbx-viewer (1)/hooks/useSocketManager.ts:35`, `fbx-viewer (1)/hooks/useLevelManager.ts:223`, `fbx-viewer (1)/hooks/useModelManager.ts:118`). Revision conflict, read-only, or host failure can leave ghost edits until reload. Several host side effects also run inside React state updaters, risking duplicate work under replay.

**Status:** Completed — simple mutations now publish only after host persistence succeeds; debounced socket and level-object edits retain an identity-checked pre-edit snapshot and roll back on failed writes; graph/blueprint persistence no longer runs inside React state updaters; model deletion disposal and parent cleanup are outside setters. Project-boundary verification, TypeScript, production build, and release tests pass.

### F-062 — Host delete cascades are not reflected in live editor domains

**Severity:** Medium · **Classification:** Confirmed

Host-side model deletion cascades through level references (`fbx-viewer (1)/utils/db.ts:286`), but live AssetContext cleanup omits the level manager (`fbx-viewer (1)/context/AssetContext.tsx:105`). Texture and audio host cascades update dependent domains (`fbx-viewer (1)/utils/db.ts:455`, `fbx-viewer (1)/utils/db.ts:502`), while their React managers remove only the primary array (`fbx-viewer (1)/hooks/useTextureManager.ts:119`, `fbx-viewer (1)/hooks/useAudioManager.ts:108`). Persisted and live state disagree until reload.

**Status:** Completed — successful native model, texture, and audio deletes now publish project-scoped cascade events; live model overrides, blueprint links/sounds, socket flash references, and level objects are reconciled, with pending level writes invalidated so deleted records cannot be resurrected. Project verification, TypeScript, and production frontend build pass.

### F-063 — Level undo/redo omits fields and consumes history before persistence succeeds

**Severity:** Medium · **Classification:** Confirmed

The history diff compares only a subset of position, rotation, scale, terrain, and sky fields (`fbx-viewer (1)/hooks/useLevelManager.ts:11`). It omits position Y, rotation X/Z, scale Y/Z, name, type, audio, spawn, and other editable data. Undo/redo mutate stacks before awaiting host synchronization and have no rollback (`fbx-viewer (1)/hooks/useLevelManager.ts:78`), so failures permanently consume history and omitted changes can reappear after reload.

**Status:** Completed — level persistence now compares complete authored objects, undo/redo keep history untouched until synchronization succeeds, guard concurrent history commands, and perform a bounded inverse sync when a multi-object write partially fails. Project verification, TypeScript, and production frontend build pass.

### F-064 — Camera and selection state are saved and restored inconsistently

**Severity:** Medium · **Classification:** Confirmed

The project manager receives camera and selected IDs but save/save-as ignore them (`fbx-viewer (1)/hooks/useProjectManager.ts:16`, `fbx-viewer (1)/hooks/useProjectManager.ts:97`). Normal open applies different metadata than recent-open, recovery, and import (`fbx-viewer (1)/hooks/useProjectManager.ts:109`), while hydration clears selected model state (`fbx-viewer (1)/hooks/useScenePersistence.ts:312`). The same project can restore differently depending on entry point.

**Status:** Completed — camera and selection are stored in one native `metadata/editor-state` document before Save and Save As, restored by the shared hydration path for open/recent/recovery/import, and validated against the loaded domains while preserving the single-selection invariant. Orbit/free camera changes are captured while active. Project verification, TypeScript, and production frontend build pass.

### F-065 — Rapid blueprint creation can violate the single-player invariant

**Severity:** Medium · **Classification:** Confirmed race

`addBlueprint` checks a closed-over array before awaiting persistence (`fbx-viewer (1)/hooks/useBlueprintManager.ts:13`), and the Add control is not disabled while the call is in flight (`fbx-viewer (1)/components/Blueprint/BlueprintListPanel.tsx:20`). Two rapid activations can both observe no player blueprint and each persist one.

**Status:** Completed — player creation now reserves the singleton synchronously with a ref-backed in-flight guard and current blueprint ref, while both Blueprint Editor and Browser toolbar Add controls disable during the request. Project verification, TypeScript, and production frontend build pass.

### F-066 — Project-operation errors become unhandled promise rejections

**Severity:** Medium · **Classification:** Confirmed

The project operation wrapper catches, notifies, and then rethrows (`fbx-viewer (1)/hooks/useProjectManager.ts:69`). Header handlers pass these async functions directly or discard their promises without a catch (`fbx-viewer (1)/components/UI/Header.tsx:17`, `fbx-viewer (1)/components/UI/Header.tsx:82`). A cancelled or failed dialog can produce both the expected notification and an unhandled rejection.

**Status:** Completed — Header project actions now run through a single UI boundary that consumes rejected promises after the manager records the user-facing error notification; project verification, TypeScript, and production frontend build pass.

### F-067 — Renderer recovery limits lifetime losses rather than consecutive failures

**Severity:** Medium · **Classification:** Confirmed concern

The registry increments recovery counts but does not reset them after successful restoration or unregister (`fbx-viewer (1)/renderer/registry.ts:156`, `fbx-viewer (1)/renderer/registry.ts:180`). `AuvraCanvas` allows only two attempts (`fbx-viewer (1)/renderer/AuvraCanvas.tsx:51`). After two unrelated successful recoveries, a later context loss no longer receives the normal timeout-driven recovery path.

**Status:** Completed — renderer recovery streaks and attempt budgets now reset after successful restoration and unregister/remount; renderer behavior verification, TypeScript, and production frontend build pass.

### F-068 — HUD coordinates are not scaled to the editing surface

**Severity:** Medium · **Classification:** Confirmed

HUD documents and new widgets use a fixed 1920×1080 coordinate system (`fbx-viewer (1)/components/HUDEditor/HUDEditor.tsx:21`, `fbx-viewer (1)/components/HUDEditor/HUDEditor.tsx:139`). `HUDCanvas` applies those coordinates as raw CSS pixels inside the available pane (`fbx-viewer (1)/components/HUDEditor/HUDCanvas.tsx:76`) while the UI labels the view as 1920×1080 at 100%. Items can spawn outside a smaller pane, and dragging has no bounds clamp, making elements unreachable.

**Status:** Completed — HUD editing now fits a logical document stage to the available pane, converts pointer coordinates through the active scale, clamps element positions to the layout, and reports the actual zoom; project verification, TypeScript, and production frontend build pass.

### F-069 — Keyboard, pointer, and accessibility behavior is incomplete

**Severity:** Medium · **Classification:** Confirmed usability concern

The custom Select lacks combobox/listbox semantics and keyboard navigation (`fbx-viewer (1)/components/UI/Select.tsx:80`). The scrubbable input's primary surface is a non-focusable `div`, has no keyboard adjustment, and lacks pointer-cancel cleanup (`fbx-viewer (1)/components/UI/Properties/ScrubbableInput.tsx:50`). HUD and blueprint rows use clickable non-focusable containers (`fbx-viewer (1)/components/HUDEditor/HUDLibrary.tsx:93`, `fbx-viewer (1)/components/Blueprint/BlueprintListPanel.tsx:47`). Global movement listeners neither exclude editable targets nor clear stuck keys on blur (`fbx-viewer (1)/components/Scene/SceneCamera.tsx:72`, `fbx-viewer (1)/components/Sandbox/hooks/usePlayerControls.ts:13`).

**Status:** Completed — Select now exposes combobox/listbox semantics with keyboard navigation; scrubbing supports keyboard adjustment and pointer-cancel/unmount cleanup; HUD/blueprint rows are keyboard focusable; and global movement ignores editable targets and clears on blur/hidden visibility. Project verification, TypeScript, and production frontend build pass.

## Verification, testing, and documentation concerns

### F-070 — The frontend lacks conventional unit/component coverage and uses relaxed compiler checks

**Severity:** Medium · **Classification:** Gap

The frontend has custom protocol, project, provider, renderer, diagnostics, and frame verifier scripts, several of which execute meaningful behavioral checks (`fbx-viewer (1)/package.json:15`, `fbx-viewer (1)/package.json:19`). It has no conventional unit/component test framework or tracked `*.test.*`/`*.spec.*` suite. `tsconfig.json` does not enable project-wide `strict`, `noImplicitAny`, or unused checks and uses `allowJs` and `skipLibCheck` (`fbx-viewer (1)/tsconfig.json:2`). Current typecheck and custom gates pass, but they do not cover the interleaving, lifecycle, disposal, and interaction failures identified above.

**Status:** Completed — Vitest/jsdom unit and component coverage now exercises HUD bounds, Select keyboard semantics, scrubbing cancellation/keyboard input, renderer recovery reset, and stale editor leases; the main frontend typecheck enables strict/noImplicitAny and disallows JS, while a strict boundary config enforces unused checks for covered production/test modules. Both gates, tests, project verification, and production build pass, and CI runs the new checks.

### F-071 — Default local release discovery uses placeholders and skips opt-in smokes

**Severity:** Medium · **Classification:** Gap

Release unit tests accept dummy runtime, SDK, Python, and native bytes (`tests/release/test_release_pipeline.py:18`), and packaged-launcher tests mock verification, SDK loading, and frame creation (`tests/launcher/test_packaged_release.py:12`, `tests/launcher/test_packaged_release.py:41`). Real packaged, native/WebView, and trace smokes skip during ordinary local discovery unless environment variables and external artifacts are supplied (`tests/desktop/test_release_smoke.py:69`, `tests/desktop/test_native_smoke.py:379`, `tests/desktop/test_native_trace_smoke.py:12`). CI does explicitly enable the native trace and WebView smokes and assembles, unpacks, verifies, and starts an unsigned dev package (`.github/workflows/verify.yml:180`, `.github/workflows/verify.yml:234`, `.github/workflows/verify.yml:268`). The gap is default local coverage and reproducibility, not absence of those CI paths.

**Status:** Completed — ordinary release discovery now includes a cross-platform local contract smoke that assembles, verifies, and inspects a staged package; the strict Windows/WebView2/native smoke remains opt-in and fails closed when enabled without required artifacts. Release discovery coverage passes (15 tests).

### F-072 — Release lifecycle verification is an in-memory model, not Windows lifecycle testing

**Severity:** Medium · **Classification:** Gap

`release/lifecycle.py` explicitly implements a side-effect-free dictionary model (`release/lifecycle.py:1`, `release/lifecycle.py:12`). The CI release job does invoke MakeAppx, unpack and verify the unsigned package, launch its packaged Python entrypoint, and run the packaged startup smoke (`.github/workflows/verify.yml:268`). It intentionally does not sign or install the package and explicitly disclaims installation, upgrade, rollback, and uninstall success (`.github/workflows/verify.yml:298`). The in-memory lifecycle test (`tests/release/test_release_pipeline.py:132`) is therefore useful logic coverage but not evidence for those signed Windows lifecycle operations.

### F-073 — Important Windows security boundaries lack production-path tests

**Severity:** Medium · **Classification:** Gap

Credential tests use only `MemoryCredentialStore`, not Windows Credential Manager (`tests/providers/test_core.py:41`; production at `Auvra/providers/credentials.py:44`). Plugin signature tests inject a fake verifier rather than the CNG path (`tests/plugins/test_sdk.py:141`; production at `Auvra/plugins/security.py:46`). Plugin resource-ceiling tests cover one happy request but not CPU/wall overage, malformed output, stuck readers, or kill escalation (`tests/plugins/test_sdk.py:217`; production at `Auvra/plugins/worker.py:510`).

### F-074 — Several tests do not exercise the boundary their names imply

**Severity:** Medium · **Classification:** Gap

The repository's “nested content” test uses an invalid descriptor and fails before reaching the nested-content guard (`tests/project/test_repository.py:232`; guard at `Auvra/project/repository.py:446`). The desktop SDK “symlink” test adds a traversal filename but no symlink member (`tests/desktop/test_sdk.py:48`; guard at `Auvra/desktop/sdk.py:139`). Transaction fault injection catches and ignores `OSError`, accepts either old or new data, and does not assert no hybrid state or journal cleanup (`tests/project/test_repository.py:99`). These tests can remain green while the intended boundary regresses.

### F-075 — Diagnostics follow state grows without a bound and trace gates rely on source tokens

**Severity:** Medium · **Classification:** Confirmed concern and gap

Diagnostics follow mode retains every `(runId, sequence)` in `seen` for the process lifetime (`Auvra/diagnostics/core.py:1726`). Long-running use across rotations can grow memory indefinitely. Program-trace tests classify Python and Rust paths using imports, `.emit(` tokens, and raw source strings (`tests/diagnostics/test_program_trace.py:58`, `tests/diagnostics/test_program_trace.py:157`), so comments or dead code can satisfy parts of the gate; the real native trace smoke invokes only `world.getSnapshot` (`tests/desktop/test_native_trace_smoke.py:30`).

### F-076 — Some tests can hang, false-pass, or become green skips

**Severity:** Low to Medium · **Classification:** Gap

The project subprocess-lock test performs a blocking `readline()` with no timeout (`tests/project/test_repository.py:164`). Multiple controller/WebView tests use strict sub-second wall-clock thresholds, and native navigation checks rely on a fixed sleep (`tests/desktop/test_controller.py:258`, `tests/desktop/test_webview2.py:102`, `tests/desktop/test_native_smoke.py:836`). AppContainer and long-path failures can turn supported-platform regressions into skips (`tests/plugins/test_sdk.py:260`, `tests/project/test_repository.py:276`).

### F-077 — Public renderer and verification documentation is ahead of the implementation

**Severity:** Medium · **Classification:** Documentation concern

The README describes a production native baseline including PBR, animation, lights, shadows, IBL, picking, HDR, ACES, antialiasing, and post-processing (`README.md:124`), while the visible viewport and project extraction paths described in F-043 through F-045 do not implement that behavior. The local verification command list also omits several checks now present in CI (`README.md:182`). `REFACTOR.md` still labels the native renderer stage “In review” (`REFACTOR.md:25`), creating additional status drift.

### F-078 — Diagnostics can mark a run clean while its writer is still active

**Severity:** Medium · **Classification:** Confirmed

Diagnostics close waits only one second for the writer, records `drainIncomplete` when it remains alive, but still removes the current-run marker and proceeds to close storage (`Auvra/diagnostics/core.py:1030`). The next launch can therefore miss an unclean run, while the old writer may still race the stream and storage teardown.

### F-079 — An output callback exception can stop pipe draining and deadlock a child

**Severity:** Medium · **Classification:** Confirmed risk

Launcher output-reader threads invoke callbacks without catching callback exceptions (`Auvra/launcher/process.py:71`, `Auvra/launcher/process.py:192`). If a callback raises, that reader stops draining the pipe. A verbose child can then block on a full stdout/stderr pipe while the parent waits for process completion.

### F-080 — Frontend port selection has a bind race and weak readiness identity

**Severity:** Medium · **Classification:** Local-origin risk

The launcher selects a loopback port and releases the socket before Vite binds it (`Auvra/launcher/cli.py:154`, `Auvra/launcher/cli.py:494`). Readiness accepts any complete HTTP response while only confirming that the Vite root process remains alive (`Auvra/launcher/readiness.py:20`, `Auvra/launcher/readiness.py:49`). Another loopback process that wins the bind can be mistaken for the editor frontend.

## Checks that did not produce a finding

- `npm run typecheck -- --pretty false` passed at the reviewed revision.
- `npm audit --audit-level=low --json` reported zero known vulnerabilities in the current installed frontend dependency graph.
- The focused tracked-file scan did not find a committed credential or secret; test-only placeholders were excluded from secret findings.
- Dependency and generated directories were not treated as source findings.
- Concerns above do not imply that every code path is exploitable remotely; local-only and defense-in-depth boundaries are labeled accordingly.

## Review limitations

This was a source audit with focused reproductions, not an exhaustive penetration test, accessibility conformance audit, long-duration soak, large-world benchmark, signed-package installation run, or full manual editor usability pass. Existing green tests establish their named paths only; they do not invalidate source-confirmed races and lifecycle failures outside their coverage. Findings should be reproduced in focused regression tests before fixes are merged, especially where timing, Windows APIs, GPU adapters, or external providers affect the outcome.
