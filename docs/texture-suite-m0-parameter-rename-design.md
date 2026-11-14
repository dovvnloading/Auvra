# M0 — Exposed Texture Parameter Rename: Cross-Document Plan

> **Status:** Cross-asset rename has a verified live-editor preview, one native transaction, whole-project rehydration and guarded session undo/redo. The closed-project material command remains available for durable receipt-based undo/redo. Full Windows editor and standalone-player fidelity still need end-to-end verification.
>
> **Tracking:** [M0 issue #279](https://github.com/dovvnloading/Auvra/issues/279), [rename defect #291](https://github.com/dovvnloading/Auvra/issues/291).
>
> **Implementation:** `fbx-viewer (1)/texturing/graph/renameProjectParameter.ts` and `tests/frontend/textureParameterRenamePlan.test.ts`.

## Rename a parameter from the live editor

Open a writable project, select a texture graph material, open its Graph inspector and choose **Edit** under Parameters. Changing a formula name now performs an authoritative five-domain preflight and displays a project-level preview: material, model, object, prefab and metadata document identities; paint/subgraph reference counts; and the exact project revision. Inspect the affected documents, then choose **Apply rename to project**.

The editor first flushes queued World Editor, material, shared-preset and Paint saves; blocks further Paint edits; and submits all affected documents in **one revision-checked** `project.applyChanges` request. It never performs an optimistic graph-local rename. After the native host acknowledges the commit, the editor rehydrates the project so graph, model, object and preset views use the committed names. Project rename **Undo**/**Redo** buttons in the Graph inspector replay the full document set, refusing to overwrite a dependent document modified since the previous action **or a newly added dependent reference**. An unrelated intervening project revision is allowed only if every affected document still matches and no new dependent has appeared.

A preview becomes stale after any project revision or material/preset update; refresh it before applying. If pending saves advance the revision during the operation, the action safely refuses and requires a new preview. A native write failure retains existing in-memory values; if the native commit succeeded but rehydration fails, reopen the project rather than blindly retrying the rename. Pending Paint saves are also flushed before ordinary save, export, close and project replacement. Delayed Paint writes are scoped to the original project ID, material-library generation and editor-session generation so they cannot silently write into a replacement project. The in-session undo/redo journal clears when the project is replaced or reopened: it is **not** a persistent receipt.

## Closed-project command and durable receipts

Alternatively, from Materials copy the PowerShell preview command after entering the project folder. Close the project in the editor so the command can acquire the native writer lock. Install the editor dependencies with `npm ci` in `fbx-viewer (1)`. From the repository root, preview the affected assets and note the revision returned.

```sh
python -m Auvra.project.material_commands ./MyProject rename-parameter living-crate Wetness Patina
```

If the preview reports revision 7, the following applies that exact revision. Choose a new receipt file outside the project. The receipt contains the previous versions of affected documents and is written before the native transaction begins.

```sh
python -m Auvra.project.material_commands ./MyProject rename-parameter living-crate Wetness Patina --apply-revision 7 --receipt ./rename.json
python -m Auvra.project.material_commands ./MyProject undo-rename ./rename.json
python -m Auvra.project.material_commands ./MyProject redo-rename ./rename.json
```

Each operation saves one native project revision. Undo and redo recheck the project ID, all five reference-bearing domains, and replay of the original plan. They refuse to overwrite later edits to those domains. Reopen the project to hydrate all editor caches from the committed documents. The cross-document command uses the same TypeScript planner as the editor preflight, including promoted parameter pins and their incoming wires.

## Why the old local rename is unsafe

`renameParameter` in `texturing/graph/parameters.ts` correctly renames a parameter and its local expressions, bindings and presets **inside the currently edited graph**. A parameter is also consumed elsewhere:

1. A **Subgraph** or **Iterate** node stores its public parameter values under the used graph's name (with `node.params.graph` holding the dependency's stable asset ID).
2. An editable **paint fill** and **mask generator** may store a `graphId` and a dictionary of exposed parameter values, including nested folders.
3. Model material bindings store a `materialId` and `MaterialParameterSetting[]` values keyed by name.
4. Placed-object material overrides inherit which asset is assigned through their model, with their own `MaterialParameterSetting[]`.
5. Saved prefab objects keep independent copies of their material overrides and resolve assignments through their models.
6. The project-wide **Shared presets** document (metadata ID `texture-graph-presets`) holds values and associates each preset with an asset `graphId`.

If the graph's public parameter name changes without renaming these dependent values in the same project revision, the next load can restore a default or discard an intended override.

## What the pure plan provides

`planTextureParameterRename` takes an **authoritative, complete** snapshot of materials, models, placed objects, prefab objects and metadata. Each matching prefab contributes one complete document to the forward and inverse batches, including its hierarchy, members without models, and unrelated slot overrides. It validates a source material and a new parameter name, then returns:

- A deterministic **impact inventory** of material assets, model documents, placed objects, saved prefabs, metadata and reference counts.
- Full-document `ProjectChange[]` upserts for a single host `project.applyChanges` batch.
- Full-document reverse changes for a **single atomic undo** operation.
- Changed material-asset objects that can be published to the local material library **only after** the host has accepted the batch.

The function never touches the host or the material library, never mutates its inputs, and fails on conflicts instead of guessing:

- Same-name field collision in a dependent node, paint fill/mask, preset or override.
- New name invalid for a formula, reserved name or another exposed parameter in the source.
- A matching dependency in an unsupported graph/paint schema.
- Missing model evidence for an object's matching parameter name.
- Collision with same-named shader/material parameters in model, placed-object or prefab overrides, including a shader parameter using the proposed name.

It ignores unrelated assets that merely happen to have a parameter of the same name. The implementation validates graph *asset IDs* rather than labels and only touches matching graph-valued paint references.

## Implemented integration order

1. **Snapshot and preflight:** `projectService.getSnapshotAll` loads all required domains and validates project identity/revision and saved material values, including unloaded dependents.
2. **Preview:** present affected asset IDs and reference counts with collision diagnostics; no files are changed yet.
3. **Commit once:** flush queued writers, fence Paint/session work, and issue **one** `projectService.applyChanges(plan.changes)` call. The host owns the project transaction and expected revision; reject conflicts and require re-preview if the host snapshot changed.
4. **Update local state:** after host acknowledgement, rehydrate detached native project state and publish it via the scene hydration boundary. Never optimistically update only the source graph.
5. **Undo/redo:** keep a session-level project history receipt with full before/after records, verify every affected document and scan the **full current inventory for newly introduced dependents** against a fresh authoritative snapshot, then replay one native batch and rehydrate again. A graph-only undo would not be correct.
6. **Reload and standalone tests:** verify saved parameters, graph wiring, presets, model/placed-object/prefab overrides and standalone cook on the supported native host and player. These remain required M0 completion evidence.

**Important:** `TextureGraphWorkspace.tsx` still uses graph-local history for ordinary graph edits. Parameter renames use the **project** command and project-specific undo/redo; do not route a cross-document rename through the graph-local `change({ graph, values })` callback.

## Live editor preflight and safety guard

The texture-graph Parameter Editor now preflights a public parameter rename against **five native host domains** (materials, models, objects, prefabs and metadata). The pure `readTextureRenameInventory` boundary rejects missing domains (including domains whose complete result should be an empty array), malformed or duplicate document identities, unsupported reference-bearing schemas and object overrides without model identity. It also checks that **every saved material matches the in-memory material library** before the planner is allowed to consider a graph-local edit. Unsaved/debounced material changes require completing their writes or reloading, rather than silently omitting dependencies. If the plan sees **any** dependent document beyond the source graph, the editor **previews** the project-wide rename and requires explicit application. It reports subgraph/Iterate, paint, model, placed-object, prefab and shared-preset reference counts.

The check includes paint on the source material and reusable smart-material layers. Export-template assets carry no graph parameter references. A graph without outside references now uses the same project transaction so that undo/redo cannot be split between graph-local and project-level history.

The preflight also refuses to rename if project identity/revision, graph **or parameter values** changed during scanning, if the project cannot be queried or is read-only, or if the planner finds a collision/unsupported document. `getSnapshotAll` now rejects page-to-page project/revision changes, malformed document lists, missing continuation pages and cursor loops. It checks the in-memory shared-presets list in addition to the persisted metadata snapshot.

**The live editor now uses the cross-document project transaction and a guarded session-level undo/redo path.** It still fails closed rather than attempting best-effort writes on incomplete snapshots, stale revisions, unsupported schemas, or unsaved changes.

## M0.2 host transaction and immediate-undo primitive

`texturing/graph/renameTransaction.ts` adds the project-host commit/undo boundary. Given a **complete impact plan computed against a specific project revision**, `commitTextureParameterRename(plan, host, expected, afterCommit)`:

- Verifies the active project, write permission and the **exact snapshot revision** before mutation.
- Sends the entire planned set of materials/models/objects/prefabs/presets through **one** `project.applyChanges` call; the host owns the atomic project revision.
- Calls `afterCommit` only after the host acknowledges the batch. A rejected write never publishes optimistic model, object or material updates.
- Returns one receipt with complete inverse snapshots, suitable for a guarded immediate `undoTextureParameterRename`.

The immediate inverse call **refuses** to run if the project has changed since the original commit. Blindly restoring old model/object snapshots after newer edits would erase legitimate work. A failure to refresh local state after the host accepted a transaction is reported as **saved but requiring rehydration**, not as an invitation to retry a possibly duplicated mutation.

The editor now invokes the transaction through `useProjectManager`, fences pending writers and Paint sessions, and rehydrates all native project state after native acknowledgement. `replayTextureParameterRename` supports session undo/redo across unrelated later revisions by comparing *all* affected full documents before another atomic batch. The original immediate-undo helper remains useful for strict adjacent-revision callers.

## Limitations and future gates

- **Native runtime validation:** automated TypeScript and planner tests are not a substitute for a supported Windows WebView2 project save/reopen and standalone-game cook test.
- **No remote/shared-library changes:** project-local material and preset metadata are the scope. Library packages can be imported later with their own dependencies and names.
- **No arbitrary unknown-schema edits:** an unsupported producer is rejected if it references the source and owns the old key; a correct future-version editor should handle it.
- **No external project rewrite:** only the open native project's domains can be committed atomically.
- **Session history only:** the editor journal does not survive a project reopen; use the closed-project CLI receipt for durable undo and redo. A future persistent editor journal would need a safe recovery contract.

## Verification

```powershell
cd "fbx-viewer (1)"
npm ci
npm run diagnostics:verify
npm run typecheck
npm run typecheck:strict
npm test -- tests/frontend/textureParameterRenamePlan.test.ts tests/frontend/textureRenameSnapshot.test.ts tests/frontend/projectSnapshotPagination.test.ts tests/frontend/textureParameters.test.ts tests/frontend/textureRenameTransaction.test.ts tests/frontend/textureRenameReplay.test.ts tests/frontend/parameterRenamePreview.test.tsx
npm run build
```

The focused test covers the defining graph, two nested/Iterate uses, nested fill/mask references, two model overrides, two independent placed-object overrides, saved prefab members with model-bound overrides, project shared presets, exact-key scoping, immutability, and conflict refusal.

**Merge gate:** CI, code review and supported native-host smoke must pass. Do not close all of #291 on the strength of source tests alone: save/reload, standalone-game cook and complete live multi-domain fidelity remain explicit acceptance gates.
