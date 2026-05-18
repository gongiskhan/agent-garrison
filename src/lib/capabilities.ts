import {
  singletonCapabilityKinds,
  type CapabilityConsumption,
  type CapabilityKind,
  type CapabilityProvision,
  type GarrisonMetadata,
  type SerializedCapabilityGraph
} from "./types";

export const RUNTIME_FITTING_ID = "__runtime__";

export interface CapabilityGraphNode {
  fittingId: string;
  provision: CapabilityProvision;
}

export interface CapabilityGraph {
  providers: Map<string, CapabilityGraphNode[]>;
  consumers: Array<{
    fittingId: string;
    consumption: CapabilityConsumption;
    matched: CapabilityGraphNode[];
  }>;
}

export type ResolverErrorCode =
  | "missing-required"
  | "ambiguous-singleton"
  | "too-many-for-optional"
  | "unknown-kind";

export interface ResolverError {
  fittingId: string;
  code: ResolverErrorCode;
  message: string;
  kind: CapabilityKind;
  name?: string;
}

export type ResolverResult =
  | { ok: true; graph: CapabilityGraph }
  | { ok: false; graph: CapabilityGraph; errors: ResolverError[] };

export interface ResolverInput {
  id: string;
  metadata: GarrisonMetadata;
}

export function resolveCapabilities(selected: ResolverInput[]): ResolverResult {
  const providers = new Map<string, CapabilityGraphNode[]>();
  const allNodes: CapabilityGraphNode[] = [];

  const syntheticVault: CapabilityGraphNode = {
    fittingId: RUNTIME_FITTING_ID,
    provision: { kind: "vault", name: "runtime" }
  };
  indexNode(providers, syntheticVault);
  allNodes.push(syntheticVault);

  for (const fitting of selected) {
    for (const provision of fitting.metadata.provides) {
      const node: CapabilityGraphNode = { fittingId: fitting.id, provision };
      indexNode(providers, node);
      allNodes.push(node);
    }
  }

  const errors: ResolverError[] = [];

  for (const kind of singletonCapabilityKinds) {
    const matching = allNodes.filter((node) => node.provision.kind === kind);
    if (matching.length <= 1) {
      continue;
    }
    for (const extra of matching.slice(1)) {
      errors.push({
        fittingId: extra.fittingId,
        code: "ambiguous-singleton",
        kind,
        name: extra.provision.name,
        message: `more than one provider for singleton capability ${kind}`
      });
    }
  }

  const consumers: CapabilityGraph["consumers"] = [];
  for (const fitting of selected) {
    for (const consumption of fitting.metadata.consumes) {
      const matched = lookup(providers, consumption);
      consumers.push({ fittingId: fitting.id, consumption, matched });

      const cardinality = consumption.cardinality ?? "one";
      const label = consumption.name ? `${consumption.kind}:${consumption.name}` : consumption.kind;
      if (cardinality === "one") {
        if (matched.length === 0) {
          errors.push({
            fittingId: fitting.id,
            code: "missing-required",
            kind: consumption.kind,
            name: consumption.name,
            message: `capability ${label} is required by ${fitting.id} but no provider is in the composition`
          });
        } else if (matched.length > 1) {
          errors.push({
            fittingId: fitting.id,
            code: "ambiguous-singleton",
            kind: consumption.kind,
            name: consumption.name,
            message: `capability ${label} consumed by ${fitting.id} matched ${matched.length} providers; expected one`
          });
        }
      } else if (cardinality === "optional-one") {
        if (matched.length > 1) {
          errors.push({
            fittingId: fitting.id,
            code: "too-many-for-optional",
            kind: consumption.kind,
            name: consumption.name,
            message: `capability ${label} consumed by ${fitting.id} matched ${matched.length} providers; expected zero or one`
          });
        }
      } else if (cardinality === "any") {
        // any: zero-or-more providers accepted; matched array carries them all.
      }
    }
  }

  const graph: CapabilityGraph = { providers, consumers };
  if (errors.length > 0) {
    return { ok: false, graph, errors };
  }
  return { ok: true, graph };
}

// JSON-safe projection of a CapabilityGraph for use on the client. Maps don't
// serialize, so providers are dropped here — only consumer→provider wiring
// matters for the UI.
export function serializeCapabilityGraph(graph: CapabilityGraph): SerializedCapabilityGraph {
  return {
    consumers: graph.consumers.map((c) => ({
      fittingId: c.fittingId,
      consumption: {
        kind: c.consumption.kind,
        ...(c.consumption.name !== undefined ? { name: c.consumption.name } : {}),
        ...(c.consumption.cardinality !== undefined ? { cardinality: c.consumption.cardinality } : {})
      },
      providers: c.matched.map((node) => ({
        fittingId: node.fittingId,
        kind: node.provision.kind,
        name: node.provision.name
      }))
    }))
  };
}


function indexNode(
  providers: Map<string, CapabilityGraphNode[]>,
  node: CapabilityGraphNode
): void {
  const namedKey = `${node.provision.kind}:${node.provision.name}`;
  appendUnique(providers, namedKey, node);
  appendUnique(providers, node.provision.kind, node);
}

function appendUnique(
  providers: Map<string, CapabilityGraphNode[]>,
  key: string,
  node: CapabilityGraphNode
): void {
  const list = providers.get(key);
  if (list) {
    list.push(node);
    return;
  }
  providers.set(key, [node]);
}

function lookup(
  providers: Map<string, CapabilityGraphNode[]>,
  consumption: CapabilityConsumption
): CapabilityGraphNode[] {
  const key = consumption.name ? `${consumption.kind}:${consumption.name}` : consumption.kind;
  return providers.get(key) ?? [];
}
