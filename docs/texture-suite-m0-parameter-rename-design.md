# M0 — Exposed Texture Parameter Rename: Cross-Document Plan

> **Status:** Cross-asset rename with preview and undo/redo through the closed-project material command. The live editor still uses the reference guard.
>
> **Tracking:** [M0 issue #279](https://github.com/dovvnloading/Auvra/issues/279), [rename defect #291](https://github.com/dovvnloading/Auvra/issues/291).
>
> **Implementation:** `fbx-viewer (1)/texturing/graph/renameProjectParameter.ts` and `tests/frontend/textureParameterRenamePlan.test.ts`.

## Rename a parameter across a saved project

In Materials, open the texture graph, select the Graph inspector, choose Edit under Parameters, and change the formula name. If there are cross-asset references, the inspector shows the saved revision, reference counts and affected document IDs. Enter the project folder and copy the PowerShell preview command. A changed project revision or material/preset state requires refreshing the preview.

Close the project in the editor so the command can acquire the native writer lock. Install the editor dependencies with `npm ci` in `fbx-viewer (1)`. From the repository root, preview the affected assets and note the revision returned.

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

## Safe integration order (not yet implemented)

1. **Snapshot and preflight:** call `projectService.getSnapshotAll` for all required domains; validate the project identity and revision. Do not rely on only visible scene objects or partial editor lists.
2. **Preview:** present the plan's affected asset IDs/counts with a detailed collision message. Accept or cancel without changing anything.
3. **Commit once:** issue **one** `projectService.applyChanges(plan.changes)` call. The host owns the project transaction and expected revision; reject conflicts and re-plan if the host snapshot changed.
4. **Update local state:** only when host ack succeeds, update the local material library plus in-memory model, scene-object and prefab state in one coordinated editor transaction. Never optimistically update the source graph first and other assets later.
5. **Undo/redo:** push the complete before/after batch into a project-level history action. Apply `undoChanges` in one host call; after successful ack refresh local libraries and scene state. A graph-only undo would not be correct.
6. **Reload test:** close/reopen the native project and validate that all saved values, graph wiring, presets, model overrides, placed-object overrides and saved prefab overrides are preserved.

**Important:** Current `TextureGraphWorkspace.tsx` uses graph-local history. Do **not** route a cross-document rename through its existing `change({ graph, values })` callback. This feature must wait for a project-level transaction and history integration. Avoid publishing a deceptively functional UI button that only updates part of the project.

## Interim safety guard for the editor

The texture-graph Parameter Editor now preflights a public parameter rename against **five native host domains** (materials, models, objects, prefabs and metadata). The pure `readTextureRenameInventory` boundary rejects missing domains (including domains whose complete result should be an empty array), malformed or duplicate document identities, unsupported reference-bearing schemas and object overrides without model identity. It also checks that **every saved material matches the in-memory material library** before the planner is allowed to consider a graph-local edit. Unsaved/debounced material changes require completing their writes or reloading, rather than silently omitting dependencies. If the plan sees **any** dependent document beyond the source graph, the editor **refuses the local rename** and reports subgraph/Iterate, paint, model, placed-object, prefab and shared-preset reference counts.

The check includes paint on the source material and reusable smart-material layers. Export-template assets carry no graph parameter references. A graph with no outside references may still use its existing local rename/undo flow.

The preflight also refuses to rename if project identity/revision, graph **or parameter values** changed during scanning, if the project cannot be queried or is read-only, or if the planner finds a collision/unsupported document. `getSnapshotAll` now rejects page-to-page project/revision changes, malformed document lists, missing continuation pages and cursor loops. It checks the in-memory shared-presets list in addition to the persisted metadata snapshot.

**The cross-document project transaction and unified undo/redo are still unfinished.** The guard must be removed/replaced once a full atomic rename action has been implemented and tested; do not turn failed checks into best-effort changes.

## M0.2 host transaction and immediate-undo primitive

`texturing/graph/renameTransaction.ts` adds the project-host commit/undo boundary. Given a **complete impact plan computed against a specific project revision**, `commitTextureParameterRename(plan, host, expected, afterCommit)`:

- Verifies the active project, write permission and the **exact snapshot revision** before mutation.
- Sends the entire planned set of materials/models/objects/prefabs/presets through **one** `project.applyChanges` call; the host owns the atomic project revision.
- Calls `afterCommit` only after the host acknowledges the batch. A rejected write never publishes optimistic model, object or material updates.
- Returns one receipt with complete inverse snapshots, suitable for a guarded immediate `undoTextureParameterRename`.

The immediate inverse call **refuses** to run if the project has changed since the original commit. Blindly restoring old model/object snapshots after newer edits would erase legitimate work. A failure to refresh local state after the host accepted a transaction is reported as **saved but requiring rehydration**, not as an invitation to retry a possibly duplicated mutation.

This is not yet wired into the editor. A complete user-facing implementation still needs local material/model/object/prefab/preset publication as one coordinated action, pending-edit fencing, and integration with project-level undo/redo across later revisions. Until that exists, the [interim local-rename guard](../fbx-viewer%20(1)/components/Texturing/TextureGraphWorkspace.tsx) protects dependent values by refusing unsafe graph-local renames.

## Limitations and future gates

- **Not yet wired into UI:** simply adding the pure planner does not fix the user-facing Rename button; issue #291 stays open.
- **No remote/shared-library changes:** project-local material and preset metadata are the scope. Library packages can be imported later with their own dependencies and names.
- **No arbitrary unknown-schema edits:** an unsupported producer is rejected if it references the source and owns the old key; a correct future-version editor should handle it.
- **No external project rewrite:** only the open native project's domains can be committed atomically.
- **No undo claim:** the plan contains reverse snapshots, but real undo correctness requires host and scene-state integration.

## Verification

```powershell
cd "fbx-viewer (1)"
npm ci
npm run diagnostics:verify
npm run typecheck
npm run typecheck:strict
npm test -- tests/frontend/textureParameterRenamePlan.test.ts tests/frontend/textureRenameSnapshot.test.ts tests/frontend/projectSnapshotPagination.test.ts tests/frontend/textureParameters.test.ts tests/frontend/textureRenameTransaction.test.ts
npm run build
```

The focused test covers the defining graph, two nested/Iterate uses, nested fill/mask references, two model overrides, two independent placed-object overrides, saved prefab members with model-bound overrides, project shared presets, exact-key scoping, immutability, and conflict refusal.

**Merge gate:** CI and code review must pass; full issue #291 remains open until the persisted editor action, single host transaction, unified undo/redo and save/reload tests are implemented.
