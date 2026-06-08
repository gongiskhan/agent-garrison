import { claudeHome } from "./claude-home";
import { getMcpServer, type McpServerConfig } from "./mcp-writer";
import { readFilePrimitive, type FilePrimitiveSurface } from "./primitive-files";
import { getHandHookDetail } from "./hooks-crud";

// Detail fetch for a single Quarters primitive, keyed by its surface-qualified id
// (e.g. "mcp:context7", "skill:foo"). Powers the per-surface editors, which need
// the full content/config of one primitive — more than the list state model
// carries. Extended one surface at a time as CRUD lands for each.

export type PrimitiveDetail =
  | { surface: "mcp"; name: string; config: McpServerConfig | null }
  | { surface: "skill" | "command" | "rule"; name: string; content: string; path: string; exists: boolean }
  | { surface: "hook"; event: string; index: number; group: unknown };

function splitId(id: string): { surface: string; rest: string } {
  const at = id.indexOf(":");
  if (at < 0) throw new Error(`malformed primitive id: ${id}`);
  return { surface: id.slice(0, at), rest: id.slice(at + 1) };
}

// "SessionStart#0" -> { event: "SessionStart", index: 0 }
export function parseHookRest(rest: string): { event: string; index: number } {
  const hash = rest.lastIndexOf("#");
  if (hash < 0) throw new Error(`malformed hook id: ${rest}`);
  return { event: rest.slice(0, hash), index: Number(rest.slice(hash + 1)) };
}

export async function getPrimitiveDetail(id: string, home: string = claudeHome()): Promise<PrimitiveDetail> {
  const { surface, rest } = splitId(id);
  switch (surface) {
    case "mcp":
      return { surface: "mcp", name: rest, config: await getMcpServer(rest, home) };
    case "skill":
    case "command":
    case "rule": {
      const r = await readFilePrimitive(surface as FilePrimitiveSurface, rest, home);
      return { surface, name: rest, content: r.content, path: r.path, exists: r.exists };
    }
    case "hook": {
      const { event, index } = parseHookRest(rest);
      const d = await getHandHookDetail(event, index, home);
      return { surface: "hook", event: d.event, index: d.index, group: d.group };
    }
    default:
      throw new Error(`no detail provider for surface "${surface}" yet`);
  }
}
