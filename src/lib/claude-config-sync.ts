// garrison config — the drift sync tying the live ~/.claude to the
// agent-garrison seed (GARRISON-UNIFY-V1 S8, D25). Three verbs:
//   status  — show drift between ~/.claude and the claude-config payload
//   pull    — write the payload into ~/.claude (seed → ~/.claude)
//   commit  — copy ~/.claude drift into the payload, then commit + push
//             agent-garrison with a generated message (git side in the CLI)
//
// Direct edits in ~/.claude are legitimate; `garrison config commit` is how
// they reach the repo. A breadcrumb README lands in ~/.claude naming the
// command. The payload tree mirrors ~/.claude: commands/, agents/, hooks/,
// templates/, mcp.json. settings-fragments/ is a managed artifact (merged by
// installers), NOT a live ~/.claude mirror, so it is excluded from diffing.
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const MIRRORED_SUBPATHS = ["commands", "agents", "hooks", "templates", "mcp.json"] as const;

// Path fragments never mirrored into the seed: machine-local runtime state and
// a security command's adversarial self-test fixtures (which trip injection
// scanners by design and are not user config to sync).
const IGNORED_FRAGMENTS = ["/test-examples/", "/logs/", ".security-key"];

function isIgnored(rel: string): boolean {
  const norm = "/" + rel.replace(/\\/g, "/");
  return IGNORED_FRAGMENTS.some((frag) => norm.includes(frag));
}

export interface ConfigDrift {
  addedInHome: string[]; // in ~/.claude, not in the payload (commit captures)
  addedInPayload: string[]; // in the payload, not ~/.claude (pull writes)
  modified: string[]; // in both, different content
  unchanged: string[];
}

const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

async function walk(root: string, base: string): Promise<Array<{ rel: string; sha: string }>> {
  const out: Array<{ rel: string; sha: string }> = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(root, e.name);
    if (e.isDirectory()) out.push(...(await walk(abs, base)));
    else if (e.isFile()) out.push({ rel: path.relative(base, abs), sha: sha(await fs.readFile(abs)) });
  }
  return out;
}

async function collectMirrored(root: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const sub of MIRRORED_SUBPATHS) {
    const abs = path.join(root, sub);
    if (!existsSync(abs)) continue;
    const st = await fs.stat(abs);
    if (st.isDirectory()) for (const f of await walk(abs, root)) { if (!isIgnored(f.rel)) map.set(f.rel, f.sha); }
    else if (st.isFile()) map.set(sub, sha(await fs.readFile(abs)));
  }
  return map;
}

export async function computeDrift(claudeHome: string, payloadDir: string): Promise<ConfigDrift> {
  const home = await collectMirrored(claudeHome);
  const payload = await collectMirrored(payloadDir);
  const drift: ConfigDrift = { addedInHome: [], addedInPayload: [], modified: [], unchanged: [] };
  for (const [rel, hsha] of home) {
    if (!payload.has(rel)) drift.addedInHome.push(rel);
    else if (payload.get(rel) !== hsha) drift.modified.push(rel);
    else drift.unchanged.push(rel);
  }
  for (const rel of payload.keys()) if (!home.has(rel)) drift.addedInPayload.push(rel);
  for (const k of ["addedInHome", "addedInPayload", "modified", "unchanged"] as const) drift[k].sort();
  return drift;
}

export function driftIsClean(drift: ConfigDrift): boolean {
  return drift.addedInHome.length === 0 && drift.addedInPayload.length === 0 && drift.modified.length === 0;
}

async function copyFile(src: string, dest: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
}

// pull: payload → ~/.claude. Only touches files that differ; returns the list.
export async function configPull(claudeHome: string, payloadDir: string): Promise<string[]> {
  const drift = await computeDrift(claudeHome, payloadDir);
  const toWrite = [...drift.addedInPayload, ...drift.modified];
  for (const rel of toWrite) await copyFile(path.join(payloadDir, rel), path.join(claudeHome, rel));
  return toWrite;
}

// commit (copy phase): ~/.claude drift → payload. Returns payload files
// written. The git commit/push is done by the CLI (side-effecting).
export async function configCaptureIntoPayload(claudeHome: string, payloadDir: string): Promise<string[]> {
  const drift = await computeDrift(claudeHome, payloadDir);
  const toWrite = [...drift.addedInHome, ...drift.modified];
  for (const rel of toWrite) await copyFile(path.join(claudeHome, rel), path.join(payloadDir, rel));
  return toWrite;
}

export const BREADCRUMB_NAME = "GARRISON-MANAGED.md";
export const BREADCRUMB_BODY = `# This folder is Garrison-managed

The shared surfaces under \`~/.claude\` (commands, agents, hooks, templates,
mcp.json) are versioned in the **agent-garrison** repo, under the
\`claude-config\` seed fitting. The former \`claude-share\` repo is archived.

Direct edits here are legitimate. To sync them back to the repo:

    garrison config status    # show drift between ~/.claude and the seed
    garrison config pull      # write the seed into ~/.claude
    garrison config commit    # capture ~/.claude drift into the seed, commit + push agent-garrison

Do not \`git push\` from this directory — its origin (claude-share) is archived.
`;

export async function writeBreadcrumb(claudeHome: string): Promise<string> {
  const p = path.join(claudeHome, BREADCRUMB_NAME);
  await fs.writeFile(p, BREADCRUMB_BODY, "utf8");
  return p;
}

export function formatStatus(drift: ConfigDrift): string {
  if (driftIsClean(drift)) return "garrison config: in sync (no drift between ~/.claude and the seed)";
  const lines: string[] = ["garrison config: drift detected"];
  for (const rel of drift.addedInHome) lines.push(`  + ${rel}   (in ~/.claude, not in seed — commit captures it)`);
  for (const rel of drift.modified) lines.push(`  M ${rel}   (differs — pull overwrites ~/.claude, commit captures ~/.claude)`);
  for (const rel of drift.addedInPayload) lines.push(`  - ${rel}   (in seed, not in ~/.claude — pull writes it)`);
  return lines.join("\n");
}

export function generateCommitMessage(written: string[]): string {
  const n = written.length;
  const head = `chore(claude-config): sync ${n} ~/.claude file${n === 1 ? "" : "s"} into the seed`;
  const body = written.slice(0, 20).map((f) => `- ${f}`).join("\n");
  const more = written.length > 20 ? `\n- …and ${written.length - 20} more` : "";
  return `${head}\n\n${body}${more}\n`;
}
