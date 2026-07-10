// coord canary — self-test the FULL coordination chain (write -> detect -> inject)
// against a throwaway test repo, exercising the REAL direct-path artifacts: the
// declare_intent MCP tool (via the real server) and the real SessionStart/
// UserPromptSubmit hook command (the exact thing Claude Code fires in ANY repo —
// no Garrison checkout). Two deliberately conflicting synthetic intents are
// declared; the digest path must surface the conflict in the injected text.
// Cleans up its synthetic records (the throwaway repo's coord ledgers).
//
// Note: this drives the same artifacts a DIRECT `claude` run loads; it does not
// spawn `claude` itself (Garrison excludes `claude -p` headless as a capability
// choice, and a literal spawn is what CO6's wiring proof covers). Honest framing:
// it proves the chain's code + wiring, not the model.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { repoSlug, repoRoot } from "./repo.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(__dirname, "..");
const SERVER = path.join(SCRIPTS, "server.mjs");
const HOOK = path.join(SCRIPTS, "coord-hook.mjs");

function garrisonHome() {
  const o = process.env.GARRISON_HOME;
  return o && o.trim().length > 0 ? o : path.join(os.homedir(), ".garrison");
}

function declareViaServer(session, repo, area, reason) {
  const req = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "declare_intent", arguments: { repo, area, reason } }
  });
  execFileSync(process.execPath, [SERVER], {
    input: req + "\n",
    env: { ...process.env, COORD_SESSION: session },
    encoding: "utf8"
  });
}

function cleanupRepo(repo) {
  const slug = repoSlug(repo);
  const gh = garrisonHome();
  for (const sub of ["intents", "plans", "plan-locks"]) {
    const dir = path.join(gh, "coord", sub);
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(slug)) fs.rmSync(path.join(dir, f), { force: true });
      }
    } catch {
      /* none */
    }
  }
  // The real hook also appended a heartbeat line for this throwaway repo to the
  // SHARED log — strip those too so the canary leaves zero synthetic records.
  const hb = path.join(gh, "coord", "heartbeat.log");
  try {
    const txt = fs.readFileSync(hb, "utf8");
    const kept = txt.split("\n").filter((line) => {
      const t = line.trim();
      if (!t) return false;
      try {
        return JSON.parse(t).repo !== repo;
      } catch {
        return true; // keep unparseable lines untouched
      }
    });
    fs.writeFileSync(hb, kept.length ? kept.join("\n") + "\n" : "");
  } catch {
    /* no heartbeat log */
  }
}

export async function runCanary() {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "coord-canary-repo-"));
  let repo = tmpRepo;
  try {
    try {
      execFileSync("git", ["init", "-q"], { cwd: tmpRepo });
    } catch {
      /* git optional; repo path still works as an identity */
    }
    // Canonical repo identity — the SAME value the hook computes via repoRoot()
    // (git realpath), so the declared intents and the hook's lookup hash to the
    // same slug (macOS /tmp -> /private/tmp symlink would otherwise mismatch).
    repo = repoRoot(tmpRepo);
    const area = "src/lib/runner.ts";
    // 1. WRITE — two deliberately conflicting synthetic intents (different sessions).
    declareViaServer("canary-A", repo, area, "canary synthetic intent A");
    declareViaServer("canary-B", repo, area, "canary synthetic intent B");

    // 2. DETECT + INJECT — run the REAL hook as a direct claude SessionStart would,
    //    with a third session whose prompt names the conflicting area.
    const out = execFileSync(process.execPath, [HOOK], {
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "canary-C", cwd: repo, prompt: `please edit ${area}` }),
      env: { ...process.env },
      encoding: "utf8"
    });
    let ctx = "";
    try {
      ctx = JSON.parse(out).hookSpecificOutput.additionalContext || "";
    } catch {
      return { ok: false, error: "hook did not emit valid JSON" };
    }

    // 3. ASSERT — the conflict surfaced in the injected digest text.
    const surfaced = ctx.includes("canary-A") || ctx.includes("canary-B");
    if (!surfaced) {
      return { ok: false, error: `conflict NOT surfaced in injected digest (got ${Buffer.byteLength(ctx)}B): ${ctx.slice(0, 160)}` };
    }
    return { ok: true, detail: `injected ${Buffer.byteLength(ctx)}B naming the conflicting session` };
  } finally {
    // 4. CLEANUP — remove the throwaway repo's synthetic coord records + the repo.
    cleanupRepo(repo);
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
}
