// MR0e probe — empirical JSONL reply-persistence check (BRIEF v2 §3).
//
// Spawns a live `claude` operative via @garrison/claude-pty, runs ONE turn, then
// inspects the session transcript JSONL to see whether assistant TEXT content is
// persisted (screen.mjs claims 2.1.175 does NOT persist it; a live 12.6 MB
// transcript showed it present — contradictory, hence this probe). Prints:
//   jsonl-verdict: persists  (transcript carries assistant text parts)
//   jsonl-verdict: absent    (no readable assistant text — telemetry stays screen/script primary)
//
// Either way, route telemetry stays script-call-primary (gateway writes
// decisions.jsonl at resolution time); this probe only records the ground truth.
// Re-runnable: `node scripts/probe-jsonl.mjs`.

import { mkdtempSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OperativePtySession } from "../packages/claude-pty/src/index.mjs";
import { claudeProjectDirForCwd } from "../packages/claude-pty/src/paths.mjs";

const HARD_MS = 110_000;
let decided = false;
function decide(verdict, note) {
  if (decided) return;
  decided = true;
  console.log(`jsonl-verdict: ${verdict}`);
  if (note) console.log(`(${note})`);
}
const hardTimer = setTimeout(() => {
  decide("absent", "hard timeout — live JSONL probe inconclusive; telemetry stays script-call-primary");
  process.exit(0);
}, HARD_MS);

let session;
try {
  const cwd = mkdtempSync(path.join(tmpdir(), "gar-probe-jsonl-"));
  session = await OperativePtySession.spawn({
    compositionDir: cwd,
    model: "sonnet",
    permissionMode: "bypassPermissions",
    readinessTimeoutMs: 40_000,
  });

  const turn = await session.runTurn({
    message: "Reply with exactly the single word PONG and nothing else.",
    timeoutMs: 70_000,
  });
  const sid = session.getClaudeSessionId();
  const projDir = claudeProjectDirForCwd(realpathSync(cwd));
  const jsonlPath = path.join(projDir, `${sid}.jsonl`);
  console.error(`[probe] scraped reply="${(turn.reply || "").slice(0, 40)}" sid=${sid}`);
  console.error(`[probe] transcript: ${jsonlPath}`);

  clearTimeout(hardTimer);
  if (!existsSync(jsonlPath)) {
    decide("absent", `no transcript file at ${jsonlPath}; screen-scrape is the only reply source`);
  } else {
    const lines = readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean);
    let assistantTextParts = 0;
    for (const ln of lines) {
      try {
        const ev = JSON.parse(ln);
        const content = ev?.message?.content;
        if (ev?.type === "assistant" && Array.isArray(content)) {
          for (const part of content) {
            if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
              assistantTextParts++;
            }
          }
        }
      } catch {
        /* skip non-JSON / partial lines */
      }
    }
    decide(
      assistantTextParts > 0 ? "persists" : "absent",
      `transcript ${lines.length} lines, ${assistantTextParts} assistant text part(s)`
    );
  }
} catch (err) {
  clearTimeout(hardTimer);
  console.error(`[probe] error: ${err?.stack || err}`);
  decide("absent", `live probe failed: ${err?.message}; telemetry stays script-call-primary`);
} finally {
  try {
    session?.dispose();
  } catch {
    /* ignore */
  }
  process.exit(0);
}
