import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { garrisonHome } from "./transports.mjs";

// Reuse Dev Env's exact durable PTY identity. A shared folder is never enough
// to attach: the native Claude id, ledger record and live tmux name must agree.
export function devEnvTerminals(home = garrisonHome(), exec = execFileSync) {
  const out = new Map();
  try {
    const socket = path.join(home, "tmux", "dev-env.sock");
    if (!fs.existsSync(socket)) return out;
    const ledger = JSON.parse(fs.readFileSync(path.join(home, "sessions", "state.json"), "utf8"));
    const names = new Set(String(exec("tmux", ["-S", socket, "list-panes", "-a", "-F", "#{session_name}\t#{pane_current_command}"], { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] })).trim().split("\n").flatMap(line => {
      const [name, command] = line.split("\t");
      return command && !/^-?(?:sh|bash|zsh|fish|dash|ksh|tcsh|csh)$/.test(command) ? [name] : [];
    }));
    const prefix = process.env.GARRISON_INSTANCE_ID ? `garrison_${process.env.GARRISON_INSTANCE_ID.replace(/[^A-Za-z0-9_-]/g, "_")}_` : "garrison_";
    const ambiguous = new Set();
    for (const project of Object.values(ledger.projects ?? {})) {
      for (const record of Object.values(project.sessions ?? {})) {
        if (!/^[A-Za-z0-9_-]+$/.test(record.id ?? "") || !record.claudeSessionId) continue;
        const tmuxSession = `${prefix}${record.id}-claude`;
        if (!names.has(tmuxSession)) continue;
        if (out.has(record.claudeSessionId)) ambiguous.add(record.claudeSessionId);
        out.set(record.claudeSessionId, { socket, tmuxSession, cwd: record.projectPath ?? project.path });
      }
    }
    for (const id of ambiguous) out.delete(id);
  } catch { /* Dev Env is optional or not running. */ }
  return out;
}
