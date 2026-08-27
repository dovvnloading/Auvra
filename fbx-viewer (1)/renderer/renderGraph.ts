import type { ResourceHandle } from "./contracts";

export type GraphResourceId = string;
export type GraphAccess = "read" | "write" | "readwrite";
export type GraphResourceKind = "texture" | "buffer";

export interface GraphResource {
  readonly id: GraphResourceId;
  readonly kind: GraphResourceKind;
  readonly external?: boolean;
}

export interface GraphPass {
  readonly id: string;
  readonly reads?: ReadonlyArray<GraphResourceId>;
  readonly writes?: ReadonlyArray<GraphResourceId>;
  readonly sideEffects?: boolean;
}

export interface RenderGraphDescription {
  readonly resources: ReadonlyArray<GraphResource>;
  readonly passes: ReadonlyArray<GraphPass>;
  readonly outputs?: ReadonlyArray<GraphResourceId>;
}

export type RenderGraphErrorCode = "duplicate-resource" | "duplicate-pass" | "duplicate-producer" | "missing-producer" | "in-pass-hazard" | "cycle" | "invalid-resource";
export interface RenderGraphDiagnostic { readonly code: RenderGraphErrorCode; readonly message: string; readonly passId?: string; readonly resourceId?: string; }

export interface ResourceLifetime { readonly firstUse: number; readonly lastUse: number; }
export interface ResourceTransition { readonly resourceId: string; readonly from: GraphAccess | "uninitialized"; readonly to: GraphAccess; readonly beforePass: string | null; readonly afterPass: string; }
export interface CompiledRenderGraph {
  readonly passes: ReadonlyArray<GraphPass>;
  readonly culledPasses: ReadonlyArray<string>;
  readonly lifetimes: Readonly<Record<string, ResourceLifetime>>;
  readonly transitions: ReadonlyArray<ResourceTransition>;
}

export class RenderGraphValidationError extends Error {
  readonly diagnostics: ReadonlyArray<RenderGraphDiagnostic>;
  constructor(diagnostics: ReadonlyArray<RenderGraphDiagnostic>) {
    super(diagnostics.map((diagnostic) => diagnostic.message).join("; "));
    this.name = "RenderGraphValidationError";
    this.diagnostics = diagnostics;
  }
}

function accesses(pass: GraphPass): Array<[string, GraphAccess]> {
  const result: Array<[string, GraphAccess]> = [];
  for (const resource of pass.reads ?? []) result.push([resource, "read"]);
  for (const resource of pass.writes ?? []) result.push([resource, "write"]);
  return result;
}

/** Validates and deterministically compiles a graph. Input order is the tie-breaker. */
export function compileRenderGraph(description: RenderGraphDescription): CompiledRenderGraph {
  const diagnostics: RenderGraphDiagnostic[] = [];
  const resources = new Map<string, GraphResource>();
  for (const resource of description.resources) {
    if (!resource.id || resources.has(resource.id)) diagnostics.push({ code: "duplicate-resource", resourceId: resource.id, message: `Resource '${resource.id}' is declared more than once` });
    else resources.set(resource.id, resource);
  }
  const passes = new Map<string, GraphPass>();
  const order = new Map<string, number>();
  description.passes.forEach((pass, index) => {
    if (!pass.id || passes.has(pass.id)) diagnostics.push({ code: "duplicate-pass", passId: pass.id, message: `Pass '${pass.id}' is declared more than once` });
    else { passes.set(pass.id, pass); order.set(pass.id, index); }
  });
  const producer = new Map<string, string>();
  for (const pass of passes.values()) {
    const seen = new Map<string, GraphAccess>();
    for (const [resourceId, access] of accesses(pass)) {
      if (!resources.has(resourceId)) diagnostics.push({ code: "invalid-resource", resourceId, passId: pass.id, message: `Pass '${pass.id}' references undeclared resource '${resourceId}'` });
      const previous = seen.get(resourceId);
      if (previous) diagnostics.push({ code: "in-pass-hazard", resourceId, passId: pass.id, message: `Pass '${pass.id}' accesses '${resourceId}' as both ${previous} and ${access}` });
      seen.set(resourceId, previous === "read" && access === "write" ? "readwrite" : access);
    }
    for (const resourceId of pass.writes ?? []) {
      if (producer.has(resourceId)) diagnostics.push({ code: "duplicate-producer", resourceId, passId: pass.id, message: `Resource '${resourceId}' has producers '${producer.get(resourceId)}' and '${pass.id}'` });
      else producer.set(resourceId, pass.id);
    }
  }
  for (const pass of passes.values()) for (const resourceId of pass.reads ?? []) {
    if (!producer.has(resourceId) && !resources.get(resourceId)?.external) diagnostics.push({ code: "missing-producer", resourceId, passId: pass.id, message: `Resource '${resourceId}' read by '${pass.id}' has no producer` });
  }
  if (diagnostics.length) throw new RenderGraphValidationError(diagnostics);

  const dependencies = new Map<string, Set<string>>([...passes.keys()].map((id) => [id, new Set()]));
  for (const pass of passes.values()) for (const resourceId of pass.reads ?? []) {
    const upstream = producer.get(resourceId);
    if (upstream && upstream !== pass.id) dependencies.get(pass.id)!.add(upstream);
  }

  // Validate the complete dependency topology before liveness analysis. A
  // cycle remains an invalid graph even when none of its passes reaches an
  // exported output and would otherwise be culled.
  const allIds = [...passes.keys()];
  const allIndegree = new Map(allIds.map((id) => [id, 0]));
  const allDownstream = new Map(allIds.map((id) => [id, new Set<string>()]));
  for (const id of allIds) for (const upstream of dependencies.get(id)!) { allIndegree.set(id, allIndegree.get(id)! + 1); allDownstream.get(upstream)!.add(id); }
  const allReady = allIds.filter((id) => allIndegree.get(id) === 0).sort((a, b) => order.get(a)! - order.get(b)!);
  let allSorted = 0;
  while (allReady.length) {
    const id = allReady.shift()!;
    allSorted++;
    for (const child of [...allDownstream.get(id)!].sort((a, b) => order.get(a)! - order.get(b)!)) { allIndegree.set(child, allIndegree.get(child)! - 1); if (allIndegree.get(child) === 0) { allReady.push(child); allReady.sort((a, b) => order.get(a)! - order.get(b)!); } }
  }
  if (allSorted !== allIds.length) throw new RenderGraphValidationError([{ code: "cycle", message: "Render graph contains a dependency cycle" }]);

  const outputIds = new Set(description.outputs ?? []);
  const roots = [...passes.values()].filter((pass) => pass.sideEffects || (pass.writes ?? []).some((id) => outputIds.has(id))).map((pass) => pass.id);
  const kept = new Set<string>();
  const mark = (id: string): void => { if (kept.has(id)) return; kept.add(id); for (const upstream of dependencies.get(id) ?? []) mark(upstream); };
  roots.forEach(mark);

  const active = [...passes.keys()].filter((id) => kept.has(id));
  const indegree = new Map(active.map((id) => [id, 0]));
  const downstream = new Map(active.map((id) => [id, new Set<string>()]));
  for (const id of active) for (const upstream of dependencies.get(id)!) if (kept.has(upstream)) { indegree.set(id, indegree.get(id)! + 1); downstream.get(upstream)!.add(id); }
  const ready = active.filter((id) => indegree.get(id) === 0).sort((a, b) => order.get(a)! - order.get(b)!);
  const sorted: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    sorted.push(id);
    for (const child of [...downstream.get(id)!].sort((a, b) => order.get(a)! - order.get(b)!)) { indegree.set(child, indegree.get(child)! - 1); if (indegree.get(child) === 0) { ready.push(child); ready.sort((a, b) => order.get(a)! - order.get(b)!); } }
  }
  if (sorted.length !== active.length) throw new RenderGraphValidationError([{ code: "cycle", message: "Render graph contains a dependency cycle" }]);

  const compiledPasses = sorted.map((id) => passes.get(id)!);
  const first = new Map<string, number>();
  const last = new Map<string, number>();
  const transitions: ResourceTransition[] = [];
  const previous = new Map<string, { access: GraphAccess; pass: string }>();
  compiledPasses.forEach((pass, index) => {
    for (const [resourceId, access] of accesses(pass)) {
      first.set(resourceId, Math.min(first.get(resourceId) ?? index, index));
      last.set(resourceId, index);
      const prior = previous.get(resourceId);
      if (!prior || prior.access === "write" || access === "write") transitions.push({ resourceId, from: prior?.access ?? "uninitialized", to: access, beforePass: prior?.pass ?? null, afterPass: pass.id });
      previous.set(resourceId, { access, pass: pass.id });
    }
  });
  const lifetimes: Record<string, ResourceLifetime> = {};
  for (const resourceId of [...first.keys()].sort()) lifetimes[resourceId] = { firstUse: first.get(resourceId)!, lastUse: last.get(resourceId)! };
  const culledPasses = description.passes.map((pass) => pass.id).filter((id) => !kept.has(id));
  return Object.freeze({ passes: Object.freeze(compiledPasses), culledPasses: Object.freeze(culledPasses), lifetimes: Object.freeze(lifetimes), transitions: Object.freeze(transitions) });
}

export const buildRenderGraph = compileRenderGraph;
