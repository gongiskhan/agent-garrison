import fs from "node:fs/promises";
import path from "node:path";
import { ROOT_DIR } from "./paths";
import { sharedRuntimes, type Composition, type LibraryEntry, type SharedRuntime } from "./types";

export interface FittingSharingInfo { runtimes: SharedRuntime[]; shared: SharedRuntime[]; available: Record<SharedRuntime, boolean>; }
export function compositionSharedRuntimes(composition: Composition, library: LibraryEntry[]): SharedRuntime[] {
  const engines = (composition.selections.runtimes ?? []).flatMap(selection => library.find(entry => entry.id === selection.id)?.metadata.provides.filter(item => item.kind === "runtime").map(item => item.name) ?? []);
  return sharedRuntimes.filter(runtime => runtime === "claude-code" ? engines.some(engine => engine === "claude-code" || engine === "agent-sdk") : engines.includes(runtime));
}
export async function fittingSharingInfo(entry: LibraryEntry, composition: Composition, library: LibraryEntry[]): Promise<FittingSharingInfo> {
  const selected = Object.values(composition.selections).flat().find(item => item?.id === entry.id);
  const available: Record<SharedRuntime, boolean> = { "claude-code": false, codex: false, gemini: false };
  for (const runtime of entry.metadata.shared_default ?? []) available[runtime] = true;
  if (entry.localPath) {
    const root = path.resolve(ROOT_DIR, entry.localPath);
    for (const ref of [".apm/skills", ".apm/prompts", ".apm/instructions", ".apm/agents", "SKILL.md"]) {
      if (await fs.stat(path.join(root, ref)).then(() => true, () => false)) available["claude-code"] = true;
    }
    // Setup is the existing primitive registration contract. Inspect only the
    // fitting's shipped script/library source, never user config or artifacts.
    if (entry.metadata.setup?.length) {
      let remaining = 2_000_000;
      const scan = async (dir: string): Promise<void> => {
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const item of entries) {
          if (remaining <= 0 || item.isSymbolicLink()) continue;
          const file = path.join(dir, item.name);
          if (item.isDirectory() && item.name !== "node_modules" && !item.name.startsWith(".")) await scan(file);
          else if (item.isFile() && /\.(mjs|cjs|js|ts|sh|py)$/.test(item.name)) {
            const st = await fs.stat(file); if (st.size > remaining) continue;
            remaining -= st.size; const source = await fs.readFile(file, "utf8");
            if (/GARRISON_CLAUDE_(?:HOME|JSON|SETTINGS_PATH)|claude mcp add/.test(source)) available["claude-code"] = true;
            if (/CODEX_HOME|codex mcp add/.test(source)) available.codex = true;
            if (/GEMINI_CLI_HOME|gemini mcp add/.test(source)) available.gemini = true;
          }
        }
      };
      await scan(path.join(root, "scripts")); await scan(path.join(root, "lib"));
    }
  }
  return { runtimes: compositionSharedRuntimes(composition, library), shared: selected?.shared ?? [], available };
}
