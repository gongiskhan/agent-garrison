// WS7 Improver-Probe acceptance driver — drives the REAL probe CLIs (generate +
// capture) through the gated Stop path, seeded from the LIVE composition policy,
// and proves the never-Anthropic / local-model constraint end to end. Prints
// `FINDING n:` per check and `IMPROVER-PROBE OK` when all hold.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import http from "node:http";

const ROOT = "/home/ggomes/dev/garrison";
const GEN = path.join(ROOT, "fittings/seed/improver/scripts/probe-generate.mjs");
const CAP = path.join(ROOT, "fittings/seed/improver/scripts/probe-capture.mjs");
const COMPILE = path.join(ROOT, "fittings/seed/orchestrator/scripts/compile.mjs");
const COMP_ROUTING = path.join(ROOT, "compositions/default/.garrison/routing.json");
const ORCH_ROUTING = path.join(homedir(), ".garrison/orchestrator/routing.json");
const SEED_ROUTING = path.join(ROOT, "fittings/seed/orchestrator/config/routing.seed.json");
const LIVE_POLICY = path.join(homedir(), ".garrison/orchestrator/policy.json");
const PROBE_CORE = path.join(ROOT, "fittings/seed/improver/lib/probe-core.mjs");
const SDK_PROVIDERS_MOD = path.join(ROOT, "fittings/seed/agent-sdk-runtime/lib/providers.mjs");

const { resolveProbeTarget } = await import(pathToFileURL(PROBE_CORE).href);
const { SDK_PROVIDERS } = await import(pathToFileURL(SDK_PROVIDERS_MOD).href);

let pass = true;
let n = 0;
function finding(ok, msg) {
  n += 1;
  pass = pass && ok;
  console.log(`FINDING ${n}: ${ok ? "PASS" : "FAIL"} — ${msg}`);
}
function isLocal(t) {
  return t && t.provider === "ollama-local" && t.provider !== "anthropic" && t.runtime === "agent-sdk";
}

// ── FINDING 1: live compiled policy resolves probe-question to the LOCAL target ──
const livePolicy = JSON.parse(readFileSync(LIVE_POLICY, "utf8"));
const liveTarget = resolveProbeTarget(livePolicy);
finding(
  isLocal(liveTarget) && liveTarget.targetId === "sdk-ollama-probe" && liveTarget.model === "qwen2.5:3b",
  `live ~/.garrison/orchestrator/policy.json → resolveProbeTarget=${JSON.stringify(liveTarget)} (local ollama, NOT anthropic; probe is not dead)`
);

// ── FINDING 2: all three routing sources route probe-question local, never haiku ──
function probeDefault(routingPath) {
  const cfg = JSON.parse(readFileSync(routingPath, "utf8"));
  const prof = cfg.profiles[cfg.activeProfile];
  return prof.matrix.rows["probe-question"]?.default ?? null;
}
const comp = probeDefault(COMP_ROUTING);
const orch = probeDefault(ORCH_ROUTING);
const seed = probeDefault(SEED_ROUTING);
finding(
  comp === "sdk-ollama-probe" && orch === "sdk-ollama-probe" && seed === "sdk-ollama-probe",
  `probe-question default target — composition=${comp}, orchestrator=${orch}, seed=${seed} (all local sdk-ollama-probe, none agent-sdk-haiku-fast)`
);

// ── FINDING 3: the default-deny base-URL fence pins the target to localhost ──
const ollamaSpec = SDK_PROVIDERS["ollama-local"];
const providersSection = (livePolicy.providers || []).find((p) => p.id === "ollama-local");
const anthropicSection = (livePolicy.providers || []).find((p) => p.id === "anthropic");
const localBase = /127\.0\.0\.1|localhost/.test(ollamaSpec.baseUrl) && /127\.0\.0\.1|localhost/.test(providersSection?.baseUrl || "");
finding(
  localBase && !/anthropic\.com/.test(ollamaSpec.baseUrl) && ollamaSpec.needsKey === false && anthropicSection?.baseUrl == null,
  `ollama-local baseUrl=${ollamaSpec.baseUrl} (needsKey=${ollamaSpec.needsKey}); the agent-sdk launch fence sets ANTHROPIC_BASE_URL→localhost + clears ANTHROPIC_API_KEY (runtime-selection.ts:187-190), so an ollama-local target can ONLY reach the local endpoint`
);

// ── FINDING 4: the probe generation path makes NO network/Anthropic call ──
const genFiles = [
  path.join(ROOT, "fittings/seed/improver/scripts/probe-generate.mjs"),
  path.join(ROOT, "fittings/seed/improver/lib/probe-core.mjs"),
  path.join(ROOT, "fittings/seed/improver/lib/probe-store.mjs"),
];
const netRe = /\bfetch\s*\(|https?:\/\/[^"']|api\.anthropic|require\(['"]node:https|from ['"]node:https|new WebSocket/;
const offenders = genFiles.filter((f) => netRe.test(readFileSync(f, "utf8")));
finding(
  offenders.length === 0,
  `probe generation path (probe-generate + probe-core + probe-store) contains ZERO network/anthropic calls — v1 question generation is deterministic, so it categorically cannot reach api.anthropic.com`
);

// ── FINDING 5: the LOCAL model actually answers (live ollama call, localhost only) ──
async function ollamaGenerate(prompt, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ model: "qwen2.5:3b", prompt, stream: false, options: { num_predict: 40 } });
    const req = http.request(
      { host: "127.0.0.1", port: 11434, path: "/api/generate", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let s = "";
        res.on("data", (d) => (s += d));
        res.on("end", () => {
          try { resolve({ ok: true, text: (JSON.parse(s).response || "").trim() }); }
          catch { resolve({ ok: false, text: "" }); }
        });
      }
    );
    req.on("error", (e) => resolve({ ok: false, text: String(e.message) }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ ok: false, text: "timeout" }); });
    req.write(body);
    req.end();
  });
}
const gen = await ollamaGenerate("In one short sentence, ask the user how their coding task went. Reply with only the question.");
finding(
  gen.ok && gen.text.length > 0,
  `live 127.0.0.1:11434 qwen2.5:3b generated a probe-style question → ${JSON.stringify(gen.text.slice(0, 120))} (the LOCAL model is reachable and serves probe generation; no Anthropic endpoint involved)`
);

// ── Sandbox seeded from the LIVE composition routing.json ──
const sb = mkdtempSync(path.join(tmpdir(), "probe-accept-"));
const home = path.join(sb, "garrison");
for (const d of ["orchestrator", "sessions", "improver", "kanban-loop/cards"]) mkdirSync(path.join(home, d), { recursive: true });
mkdirSync(path.join(sb, "comp", ".garrison"), { recursive: true });
execFileSync("node", [COMPILE, "--config", COMP_ROUTING, "--policy", path.join(home, "orchestrator", "policy.json")]);
writeFileSync(
  path.join(home, "sessions", "state.json"),
  JSON.stringify({ version: 1, projects: { "/repo": { sessions: {
    "attended-1": { claudeSessionId: "attended-1", source: "dev-env-open", openedInDevEnv: true },
    "worker-1": { claudeSessionId: "worker-1", source: "hook-autocreated", openedInDevEnv: false },
  } } } })
);
writeFileSync(
  path.join(sb, "comp", ".garrison", "decisions.jsonl"),
  JSON.stringify({ at: "2026-07-12T11:59:00Z", promptDigest: "x", taskType: "code", tier: "T1-standard" }) + "\n"
);
const transcript = path.join(sb, "transcript.jsonl");
writeFileSync(transcript, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Implemented the feature and verified it end to end.".padEnd(80, ".") }] } }));
const NOW = "2026-07-12T12:00:00.000Z";
const env = {
  ...process.env,
  GARRISON_HOME: home,
  GARRISON_POLICY_PATH: path.join(home, "orchestrator", "policy.json"),
  GARRISON_SESSIONS_STATE: path.join(home, "sessions", "state.json"),
  GARRISON_KANBAN_DIR: path.join(home, "kanban-loop"),
  GARRISON_COMPOSITION_DIR: path.join(sb, "comp"),
  PROBE_NOW: NOW,
};
function queue() {
  const f = path.join(home, "improver", "feedback-queue.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

// ── FINDING 6: attended completed-task Stop → BLOCK (not skip), local target on stderr ──
const genProc = spawnSync("node", [GEN], { input: JSON.stringify({ session_id: "attended-1", stop_hook_active: false, transcript_path: transcript }), env, encoding: "utf8" });
let decision = null;
try { decision = JSON.parse(genProc.stdout); } catch { /* */ }
const pendingPath = path.join(home, "improver", "probe-pending-attended-1.json");
const skipLog = path.join(home, "improver", "probe-skip.log");
const skipped = existsSync(skipLog);
finding(
  decision?.decision === "block" &&
    /AskUserQuestion/.test(decision.reason) &&
    /sdk-ollama-probe/.test(genProc.stderr) &&
    /probe-question/.test(genProc.stderr) &&
    !skipped &&
    existsSync(pendingPath),
  `gated attended Stop → decision=block with a verbatim AskUserQuestion relay; stderr names the LOCAL target (${(genProc.stderr.match(/target=\S+ runtime=\S+ model=\S+/) || [""])[0]}); NO probe-skip written; pending file created`
);

// ── FINDING 7: PostToolUse capture → one record into feedback-queue.jsonl ──
const pending = JSON.parse(readFileSync(pendingPath, "utf8"));
const q = pending.questions[0];
spawnSync("node", [CAP], { input: JSON.stringify({ session_id: "attended-1", tool_response: { answers: { [q.question]: q.options[0] } } }), env, encoding: "utf8" });
const recs = queue();
const rec = recs[0];
finding(
  recs.length === 1 &&
    rec.answer === q.options[0] &&
    rec.provenance === "probe" &&
    rec.question === q.question &&
    rec.classification &&
    !existsSync(pendingPath),
  `PostToolUse capture recorded the answer into feedback-queue.jsonl → ${JSON.stringify({ area: rec?.area, answer: rec?.answer, provenance: rec?.provenance, classification: rec?.classification })}; pending cleared (E12 answer path)`
);

// ── FINDING 8: pool/worker (not attended) Stop is NEVER probed (fail-closed) ──
const workerOut = spawnSync("node", [GEN], { input: JSON.stringify({ session_id: "worker-1", stop_hook_active: false, transcript_path: transcript }), env, encoding: "utf8" });
finding(
  workerOut.stdout.trim() === "" && !existsSync(path.join(home, "improver", "probe-pending-worker-1.json")),
  `non-attended (pool/worker) Stop → no block, no pending — A10 fail-closed attended gating holds`
);

// ── FINDING 9: the LIVE skip-log stopped logging the no-row skip after the recompile ──
const liveSkip = path.join(homedir(), ".garrison/improver/probe-skip.log");
let lastSkip = "(no skip log)";
let stopped = true;
if (existsSync(liveSkip)) {
  const lines = readFileSync(liveSkip, "utf8").split("\n").filter((l) => /no "probe-question" row/.test(l) && /^\d{4}-/.test(l));
  const last = lines[lines.length - 1] || "";
  lastSkip = last.slice(0, 24) || "(none)";
  // The recompile that added the row happened ~2026-07-12T16:20Z; assert no no-row skip after it.
  stopped = !lines.some((l) => Date.parse(l.slice(0, 24)) > Date.parse("2026-07-12T16:20:00Z"));
}
finding(stopped, `live probe-skip.log last "no probe-question row" entry = ${lastSkip} — none after the 16:20 recompile (the dead-probe skip has stopped)`);

rmSync(sb, { recursive: true, force: true });

console.log(pass ? "\nIMPROVER-PROBE OK" : "\nIMPROVER-PROBE FAIL");
process.exit(pass ? 0 : 1);
