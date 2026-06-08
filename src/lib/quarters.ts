import { computeStateModel, type StateModel } from "./primitive-state";
import { promote, park, unpark, type TransitionResult } from "./state-transitions";
import {
  addMcpServer,
  updateMcpServer,
  removeMcpServer,
  type McpServerConfig,
  type McpWriteResult
} from "./mcp-writer";

// Backend for the Quarters surface: a read (the loose/owned StateModel over the
// real ~/.claude), the promote/park/unpark transition dispatch, AND the CRUD
// dispatch for the surfaces Garrison is writer-of-record for (mcp.json today;
// skills/scripts/hooks files as those slices land). Thin wrapper so the API route
// stays declarative and the dispatch is unit-testable.
//
// CRUD does NOT reuse TransitionResult — its deployed/cleanedOrphans shape is
// promote/park-specific. CrudResult is the parallel result type; both carry `ok`
// so the API route's status mapping is uniform.

export interface CrudResult {
  ok: boolean;
  id?: string;
  code?: "exists" | "not-found" | "invalid" | "owned" | "unknown-action";
  error?: string;
}

export type QuartersActionRequest =
  | { action: "promote"; id: string }
  | { action: "park"; fittingId: string }
  | { action: "unpark"; slug: string; target: "owned" | "loose" }
  | { action: "mcp.add"; name: string; config: McpServerConfig }
  | { action: "mcp.update"; name: string; newName?: string; config: McpServerConfig }
  | { action: "mcp.remove"; name: string };

export async function getQuartersState(): Promise<StateModel> {
  return computeStateModel();
}

function fromMcp(r: McpWriteResult): CrudResult {
  return { ok: r.ok, id: r.name ? `mcp:${r.name}` : undefined, code: r.code, error: r.error };
}

export async function runQuartersAction(
  req: QuartersActionRequest
): Promise<TransitionResult | CrudResult> {
  switch (req?.action) {
    case "promote":
      if (!req.id) throw new Error("promote requires { id }");
      return promote(req.id);
    case "park":
      if (!req.fittingId) throw new Error("park requires { fittingId }");
      return park(req.fittingId);
    case "unpark":
      if (!req.slug) throw new Error("unpark requires { slug }");
      return unpark(req.slug, req.target === "loose" ? "loose" : "owned");
    case "mcp.add":
      return fromMcp(await addMcpServer(req.name, req.config));
    case "mcp.update":
      return fromMcp(await updateMcpServer(req.name, req.config, undefined, req.newName));
    case "mcp.remove":
      return fromMcp(await removeMcpServer(req.name));
    default:
      throw new Error(`unknown quarters action: ${(req as { action?: string })?.action}`);
  }
}
