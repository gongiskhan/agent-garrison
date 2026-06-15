import { computeStateModel, type StateModel } from "./primitive-state";
import { promote, park, unpark, type TransitionResult } from "./state-transitions";
import {
  addMcpServer,
  updateMcpServer,
  removeMcpServer,
  type McpServerConfig,
  type McpWriteResult
} from "./mcp-writer";
import {
  createFilePrimitive,
  updateFilePrimitive,
  deleteFilePrimitive,
  type FilePrimitiveSurface,
  type FilePrimitiveResult
} from "./primitive-files";
import {
  createHandHook,
  updateHandHook,
  deleteHandHook,
  type HookCrudResult
} from "./hooks-crud";
import { removePlugin, type PluginRemoveResult } from "./plugin-writer";
import { reconcile } from "./reconcile";

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
  | { action: "mcp.remove"; name: string }
  | { action: "file.create"; surface: FilePrimitiveSurface; name: string; content: string }
  | { action: "file.update"; surface: FilePrimitiveSurface; name: string; content: string }
  | { action: "file.delete"; surface: FilePrimitiveSurface; name: string }
  | { action: "hook.create"; event: string; matcher?: string; command: string; timeout?: number }
  | { action: "hook.update"; event: string; index: number; matcher?: string; command: string; timeout?: number }
  | { action: "hook.delete"; event: string; index: number }
  | { action: "plugin.remove"; key: string };

export async function getQuartersState(): Promise<StateModel> {
  return computeStateModel();
}

function fromMcp(r: McpWriteResult): CrudResult {
  return { ok: r.ok, id: r.name ? `mcp:${r.name}` : undefined, code: r.code, error: r.error };
}

function fromFile(r: FilePrimitiveResult): CrudResult {
  return { ok: r.ok, id: r.id, code: r.code, error: r.error };
}

function fromHook(r: HookCrudResult): CrudResult {
  return { ok: r.ok, id: r.id, code: r.code, error: r.error };
}

function fromPlugin(r: PluginRemoveResult): CrudResult {
  return { ok: r.ok, id: r.key ? `plugin:${r.key}` : undefined, code: r.code, error: r.error };
}

// Backend half of the writer-of-record invariant: a delete is refused for an
// APM-OWNED file primitive (the lock manages it) — the caller must Park it. The
// UI hides the Delete button for owned records, but the dispatch enforces it too
// (never trust the client).
async function guardedFileDelete(surface: FilePrimitiveSurface, name: string): Promise<CrudResult> {
  const model = await computeStateModel();
  const rec = model.records.find((r) => r.id === `${surface}:${name}`);
  if (rec?.state === "owned") {
    return {
      ok: false,
      code: "owned",
      error: `"${name}" is APM-managed (owned) — Park it to remove, don't delete behind the lock.`
    };
  }
  return fromFile(await deleteFilePrimitive(surface, name));
}

// After Garrison authors a loose file primitive (skill/command/rule), capture it
// into the Seed store so it can be promoted to owned — this closes the previously
// unwired reconcile("post-authoring") gap (reconcile() had no production caller).
// Best-effort: a reconcile failure must never fail the authoring action. Scoped
// to the touched surface so it doesn't rescan every surface.
async function reconcilePostAuthoring(surface: FilePrimitiveSurface): Promise<void> {
  try {
    await reconcile({ trigger: "post-authoring", surfaces: [surface] });
  } catch (err) {
    console.warn(
      `[garrison] post-authoring reconcile failed for ${surface}: ${(err as Error).message}`
    );
  }
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
    case "file.create": {
      const r = fromFile(await createFilePrimitive(req.surface, req.name, req.content));
      if (r.ok) await reconcilePostAuthoring(req.surface);
      return r;
    }
    case "file.update": {
      const r = fromFile(await updateFilePrimitive(req.surface, req.name, req.content));
      if (r.ok) await reconcilePostAuthoring(req.surface);
      return r;
    }
    case "file.delete": {
      const r = await guardedFileDelete(req.surface, req.name);
      if (r.ok) await reconcilePostAuthoring(req.surface);
      return r;
    }
    case "hook.create":
      return fromHook(await createHandHook({ event: req.event, matcher: req.matcher, command: req.command, timeout: req.timeout }));
    case "hook.update":
      return fromHook(await updateHandHook(req.event, req.index, { event: req.event, matcher: req.matcher, command: req.command, timeout: req.timeout }));
    case "hook.delete":
      return fromHook(await deleteHandHook(req.event, req.index));
    case "plugin.remove":
      return fromPlugin(await removePlugin(req.key));
    default:
      throw new Error(`unknown quarters action: ${(req as { action?: string })?.action}`);
  }
}
