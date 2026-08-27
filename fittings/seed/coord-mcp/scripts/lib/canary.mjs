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
import { repoRef } from "./repo.mjs";
import { removeIntentsBySession } from "./intent-store.mjs";

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

// Release the canary's synthetic intents (set-once tombstone on the service —
// the ledger is append-only, so "cleanup" means released, never deleted) and
// strip the heartbeat lines the real hook appended for the throwaway repo. The
// throwaway repo has no origin, so its key is `local:<node>:<hash>` and is
// unique to this run: nothing else can be caught by this.
async function cleanupRepo(repoKey, repoPath) {
  for (const session of ["canary-A", "canary-B"]) {
    try {
      await removeIntentsBySession(repoKey, session);
    } catch {
      /* the canary already reported the real failure; cleanup is best-effort */
    }
  }
  const hb = path.join(garrisonHome(), "coord", "heartbeat.log");
  try {
    const txt = fs.readFileSync(hb, "utf8");
    const kept = txt.split("\n").filter((line) => {
      const t = line.trim();
      if (!t) return false;
      try {
        return JSON.parse(t).repo !== repoPath;
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
  let ref = { key: null, path: tmpRepo };
  try {
    try {
      execFileSync("git", ["init", "-q"], { cwd: tmpRepo });
    } catch {
      /* git optional; repo path still works as an identity */
    }
    // The hook only injects in repos that opted into coordination (a committed
    // `.coord` marker). The canary drives the REAL hook, so its throwaway repo
    // has to opt in too - without this it exercises the gate rather than the
    // write -> detect -> inject chain it exists to prove, and reports a
    // conflict that was never surfaced.
    fs.writeFileSync(path.join(tmpRepo, ".coord"), "");
    // Canonical repo identity — the SAME value the hook computes via repoRef()
    // (git realpath + origin), so the declared intents and the hook's lookup land
    // on the same mesh key (macOS /tmp -> /private/tmp symlink would otherwise
    // mismatch).
    ref = repoRef(undefined, tmpRepo);
    const repo = ref.path;
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
    // 4. CLEANUP — release the throwaway repo's synthetic coord records + the repo.
    if (ref.key) await cleanupRepo(ref.key, ref.path);
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
}
