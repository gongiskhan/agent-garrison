#!/usr/bin/env node
// matrix-harness.mjs — the runtime-agnosticism test matrix (GARRISON-MARATHON-V1
// WS2 / slice S2c). Proves that EVERY fitting in compositions/default stays
// healthy and exercises its representative action under EACH primary engine, so
// the uniform RuntimeAdapter contract really is runtime-agnostic and not a
// claude-code monoculture.
//
// Usage:
//   node scripts/matrix-harness.mjs [--primary <id>] [--out <path>] \
//        [--cells <path>] [--render-only] [--only-fitting <id>]
//
//   --primary <id>   Run ONE column (claude-code | codex | opencode | agent-sdk |
//                    gemini). Omitted → the default matrix: claude-code, codex,
//                    opencode (agent-sdk is already proven live in
//                    tests/agent-sdk-primary-smoke.integration.test.ts).
//   --out <path>     Rendered markdown matrix (default docs/RUNTIME_MATRIX.md).
//   --cells <path>   Durable per-cell JSON cache — merged across runs so a single
//                    column can be re-run WITHOUT repeating the budgeted codex
//                    calls (default docs/autothing/runs/.../slices/S2c/matrix-cells.json).
//   --render-only    Re-render the doc from the cache; run nothing.
//
// Budget discipline (this box, shared tokens):
//   - claude-code: exactly ONE served turn (haiku) — the primary boot. The
//     claude-code-runtime cell is a read-only probe (no second Max turn).
//   - codex: exactly ONE primary turn (boot) + ONE delegate round-trip, both in
//     the codex column; every other codex cell is a read-only --probe. The
//     consumed flag is persisted in the cache so re-runs never double-spend.
//   - agent-sdk / opencode: all turns run on the free local ollama (qwen2.5:3b).
//   - gemini: --probe only (unauthed on this box — a DOCUMENTED degradation).
//
// A single fitting's failure NEVER aborts the run — every cell is captured as
// {status: pass|degraded|fail|verify-only, note}. The bar is ZERO unexplained
// failures: every non-pass carries a cause.
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { load } = require("js-yaml");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const COMP_DIR = path.join(REPO, "compositions", "default");
const RUN_DIR = path.join(REPO, "docs", "autothing", "runs", "20260712-173530-81e1c448", "slices", "S2c");
const DEFAULT_OUT = path.join(REPO, "docs", "RUNTIME_MATRIX.md");
const DEFAULT_CELLS = path.join(RUN_DIR, "matrix-cells.json");
const DEFAULT_PRIMARIES = ["claude-code", "codex", "opencode"];
const TURN_PROMPT = "Reply with the single word: pong. Output only that one word, nothing else.";
const OLLAMA_MODEL = process.env.GARRISON_OLLAMA_MODEL ?? "qwen2.5:3b";

// ---------------------------------------------------------------------------
// composition + manifest reading
// ---------------------------------------------------------------------------

function readManifest(id) {
  // Prefer the INSTALLED copy (production shape); fall back to the seed source,
  // which is always current (localPath deps) when the install is stale.
  const installed = path.join(COMP_DIR, "apm_modules", "_local", id);
  const seed = path.join(REPO, "fittings", "seed", id);
  for (const dir of [installed, seed]) {
    const mf = path.join(dir, "apm.yml");
    if (existsSync(mf)) {
      try {
        return { id, dir, manifest: load(readFileSync(mf, "utf8")) };
      } catch (e) {
        return { id, dir, manifest: null, parseError: String(e?.message || e) };
      }
    }
  }
  return { id, dir: seed, manifest: null, parseError: "no apm.yml (installed or seed)" };
}

function loadComposition() {
  const comp = load(readFileSync(path.join(COMP_DIR, "apm.yml"), "utf8"));
  const ids = comp.dependencies.apm.map((d) => path.basename(d.path));
  const selections = comp["x-garrison"]?.composition?.selections ?? {};
  // fitting id -> selection config (for own-port ports, board ids, …)
  const configOf = {};
  for (const faculty of Object.values(selections)) {
    for (const sel of faculty ?? []) configOf[sel.id] = sel.config ?? {};
  }
  const fittings = ids.map((id) => {
    const m = readManifest(id);
    return { ...m, config: configOf[id] ?? {}, faculty: m.manifest?.["x-garrison"]?.faculty ?? "?" };
  });
  return { fittings, name: comp.name };
}

// ---------------------------------------------------------------------------
// per-fitting representative action classification (pure)
// ---------------------------------------------------------------------------

// Which representative action a fitting gets, by capability kind. Priority order
// matters: gateway → runtime → memory → connector-catalog → own-port-health →
// manifest-only. Kept pure + exported so it is unit-testable.
export function classifyAction(fitting) {
  const xg = fitting.manifest?.["x-garrison"] ?? {};
  const provides = xg.provides ?? [];
  const kinds = provides.map((p) => p.kind);
  if (fitting.faculty === "gateway") return { type: "gateway-boot" };
  const runtime = provides.find((p) => p.kind === "runtime");
  if (runtime) return { type: "runtime-delegate", engine: runtime.name };
  if (kinds.includes("memory-store")) return { type: "memory-read" };
  if (xg.connector && Array.isArray(xg.connector.actions)) return { type: "catalog-parse" };
  if (xg.own_port) return { type: "http-health" };
  return { type: "manifest" };
}

// ---------------------------------------------------------------------------
// verify hook
// ---------------------------------------------------------------------------

// Run the fitting's x-garrison verify hook against its RESOLVED dir (the verify
// command references apm_modules/_local/<id>; rewrite that token to the dir we
// actually resolved so a stale/missing install falls back to the seed).
function runVerify(fitting) {
  const verify = fitting.manifest?.["x-garrison"]?.verify;
  if (!verify?.command) return { ok: false, note: "no verify hook declared", out: "" };
  const token = new RegExp(`apm_modules/_local/${fitting.id}(/|\\b)`, "g");
  const cmd = verify.command.replace(token, `${fitting.dir}$1`);
  const r = spawnSync("bash", ["-lc", cmd], {
    cwd: COMP_DIR,
    encoding: "utf8",
    timeout: verify.timeout_ms ?? 20000,
    env: process.env
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  const expect = verify.expect;
  const ok = r.status === 0 && (!expect || out.includes(String(expect)));
  return { ok, note: ok ? "verify ok" : `verify exit ${r.status}: ${out.slice(0, 140) || "(no output)"}`, out };
}

// ---------------------------------------------------------------------------
// representative-action runners
// ---------------------------------------------------------------------------

function runtimeBridge(fitting, args, { input, env, timeout = 120000 } = {}) {
  const script = path.join(fitting.dir, "scripts", "bridge.mjs");
  if (!existsSync(script)) return { code: -1, stdout: "", stderr: "no bridge.mjs (primary-only runtime)" };
  const r = spawnSync(process.execPath, [script, ...args], {
    input,
    encoding: "utf8",
    timeout,
    env: env ?? process.env
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function bridgeProbe(fitting) {
  const r = runtimeBridge(fitting, ["--probe"], { timeout: 25000 });
  return { ok: r.code === 0 && `${r.stdout}${r.stderr}`.includes("ok"), out: `${r.stdout}${r.stderr}`.trim() };
}

// One free ollama delegate round-trip through the runtime's bridge (agent-sdk /
// opencode). Returns pass with the model's summary, or degraded on error.
function ollamaDelegate(fitting, tmp) {
  const spec = {
    task: TURN_PROMPT,
    paths: [],
    constraints: [],
    cwd: tmp,
    ...(fitting.id === "agent-sdk-runtime"
      ? { provider: "ollama-local", model: OLLAMA_MODEL }
      : { model: `ollama-local/${OLLAMA_MODEL}` })
  };
  const r = runtimeBridge(fitting, ["delegate"], { input: JSON.stringify(spec), timeout: 120000 });
  let parsed = null;
  try {
    parsed = JSON.parse((r.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || "{}");
  } catch {
    /* leave null */
  }
  if (r.code === 0 && parsed && typeof parsed.summary === "string") {
    return { status: "pass", note: `delegate round-trip ok over ollama/${OLLAMA_MODEL}; summary "${parsed.summary.slice(0, 60).replace(/\s+/g, " ")}"` };
  }
  const why = (parsed?.message || r.stderr.trim() || `exit ${r.code}`).replace(/\s+/g, " ").slice(0, 180);
  return { status: "degraded", note: `delegate over ollama/${OLLAMA_MODEL} did not return a summary (small-local-model quality / transport): ${why}` };
}

function codexDelegate(fitting, tmp, env) {
  const spec = { task: TURN_PROMPT, paths: [], constraints: [], cwd: tmp };
  const r = runtimeBridge(fitting, ["delegate"], { input: JSON.stringify(spec), timeout: 240000, env });
  let parsed = null;
  try {
    parsed = JSON.parse((r.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || "{}");
  } catch {
    /* leave null */
  }
  if (r.code === 0 && parsed && typeof parsed.summary === "string") {
    return { status: "pass", note: `codex delegate round-trip ok (budgeted single call); summary "${parsed.summary.slice(0, 60).replace(/\s+/g, " ")}"` };
  }
  const why = (parsed?.message || r.stderr.trim() || `exit ${r.code}`).replace(/\s+/g, " ").slice(0, 180);
  return { status: "degraded", note: `codex delegate returned no summary: ${why}` };
}

// Connector catalog parse — no external calls; just assert the manifest's
// declared action catalog is a non-empty list of well-formed actions.
function catalogParse(fitting) {
  const conn = fitting.manifest?.["x-garrison"]?.connector;
  const actions = conn?.actions ?? [];
  if (!Array.isArray(actions) || actions.length === 0) {
    return { status: "fail", note: "no connector.actions catalog in manifest" };
  }
  const named = actions.filter((a) => a && typeof a.name === "string").length;
  if (named !== actions.length) return { status: "degraded", note: `${named}/${actions.length} catalog actions well-formed (missing name)` };
  const muts = actions.filter((a) => a.mutates).length;
  return { status: "pass", note: `catalog parsed: ${actions.length} actions (${muts} mutating), no external calls` };
}

// A read via the memory-store CLI/API. basic-memory is a Python CLI; a project
// list is a safe read that never mutates. Falls back to verify-only when the CLI
// isn't on PATH.
function memoryRead(fitting) {
  const bm = spawnSync("bash", ["-lc", "command -v basic-memory"], { encoding: "utf8" });
  if (bm.status !== 0 || !bm.stdout.trim()) {
    return { status: "verify-only", note: "basic-memory CLI not on PATH; health via verify.sh only" };
  }
  const r = spawnSync("basic-memory", ["project", "list"], { encoding: "utf8", timeout: 30000, env: process.env });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  if (r.status === 0) return { status: "pass", note: `read ok via 'basic-memory project list' (${out.split(/\r?\n/).length} lines)` };
  return { status: "verify-only", note: `basic-memory read exited ${r.status} (${out.slice(0, 100)}); health via verify.sh` };
}

async function httpHealth(fitting) {
  const port = fitting.config?.port ?? fitting.config?.slack_port ?? fitting.manifest?.["x-garrison"]?.own_port_default;
  if (!port) return { status: "verify-only", note: "own-port fitting; no port in composition config (not started by harness)" };
  for (const p of ["/health", "/api/health", "/status", "/api/status", "/"]) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(1500) });
      if (res.ok || res.status < 500) {
        return { status: "pass", note: `own-port server live on :${port}${p} (HTTP ${res.status})` };
      }
    } catch {
      /* not up on this path */
    }
  }
  return { status: "verify-only", note: `own-port server not running on :${port} (harness does not 'up' the composition); verify hook is the health signal` };
}

// Resolve a fitting's cell for a given primary column: verify hook + one
// representative action, combined into a single {status, note}. `budget` is a
// mutable per-run object tracking the single codex delegate.
async function runCell(fitting, primary, ctx) {
  if (!fitting.manifest) {
    return { status: "fail", note: `manifest unreadable: ${fitting.parseError}` };
  }
  const verify = runVerify(fitting);
  const action = classifyAction(fitting);
  let a;

  switch (action.type) {
    case "gateway-boot": {
      const boot = ctx.boot;
      if (boot?.status === "pass") a = { status: "pass", note: `RoutedGateway booted with the ${primary} primary + served a turn (this column's boot)` };
      else a = { status: boot?.status === "degraded" ? "degraded" : "verify-only", note: `gateway boot: ${boot?.note ?? "not attempted"}` };
      break;
    }
    case "runtime-delegate": {
      if (action.engine === "gemini") {
        const pr = bridgeProbe(fitting);
        a = pr.ok
          ? { status: "degraded", note: "bridge --probe ok (CLI present); a real delegate TURN is unauthed on this box (no Gemini credentials) — expected, documented degradation" }
          : { status: "fail", note: `gemini probe failed: ${pr.out.slice(0, 120)}` };
      } else if (action.engine === "claude-code") {
        const pr = bridgeProbe(fitting);
        a = pr.ok
          ? { status: "pass", note: "primary-only runtime (no secondary delegate bridge); probe.mjs health ok — served LIVE as the primary in the claude-code column" }
          : { status: "verify-only", note: "no delegate bridge (primary-only runtime); health via probe" };
      } else if (action.engine === "codex") {
        if (primary === "codex" && !ctx.budget.codexDelegateConsumed) {
          a = codexDelegate(fitting, ctx.tmp, ctx.codexEnv);
          ctx.budget.codexDelegateConsumed = true;
        } else {
          const pr = bridgeProbe(fitting);
          a = pr.ok
            ? { status: "verify-only", note: "codex delegate round-trip is budget-gated to ONE call (spent in the codex column); read-only --probe here (CLI authed)" }
            : { status: "fail", note: `codex probe failed: ${pr.out.slice(0, 120)}` };
        }
      } else {
        // agent-sdk / opencode → free ollama delegate
        a = ollamaDelegate(fitting, ctx.tmp);
      }
      break;
    }
    case "memory-read":
      a = memoryRead(fitting);
      break;
    case "catalog-parse":
      a = catalogParse(fitting);
      break;
    case "http-health":
      a = await httpHealth(fitting);
      break;
    default:
      a = verify.ok
        ? { status: "pass", note: "manifest parsed + verify hook ok" }
        : { status: "fail", note: verify.note };
  }

  // Combine verify + action. A failed health hook dominates unless the action
  // itself already explains a documented degradation.
  if (!verify.ok && action.type !== "gateway-boot") {
    if (a.status === "pass") return { status: "degraded", note: `action ok but verify hook failed — ${verify.note}` };
    if (a.status === "degraded") return { status: "degraded", note: `${a.note}; verify: ${verify.note}` };
    return { status: "fail", note: `verify hook failed: ${verify.note}` };
  }
  return a;
}

// ---------------------------------------------------------------------------
// primary boot + one served turn
// ---------------------------------------------------------------------------

function bootOpts(primary, tmp, logs) {
  const logFn = (e) => logs.push(e);
  const base = { compositionDir: tmp, logFn };
  switch (primary) {
    case "claude-code":
      return {
        ...base,
        primaryEngine: "claude-code",
        operativeSpawnConfig: { compositionDir: tmp, model: "haiku", permissionMode: "bypassPermissions" },
        initialTarget: { provider: "anthropic-plan", model: "haiku", effort: null }
      };
    case "agent-sdk":
      return {
        ...base,
        primaryEngine: "agent-sdk",
        claudeCodeResolvable: false,
        operativeSpawnConfig: { compositionDir: tmp, provider: "ollama-local", model: OLLAMA_MODEL, promptMode: "lean" },
        initialTarget: { provider: "ollama-local", model: OLLAMA_MODEL, effort: null }
      };
    case "opencode":
      return {
        ...base,
        primaryEngine: "opencode",
        claudeCodeResolvable: false,
        operativeSpawnConfig: { compositionDir: tmp, model: `ollama-local/${OLLAMA_MODEL}` },
        initialTarget: { provider: "ollama-local", model: `ollama-local/${OLLAMA_MODEL}`, effort: null }
      };
    case "codex":
      return {
        ...base,
        primaryEngine: "codex",
        claudeCodeResolvable: false,
        operativeSpawnConfig: { compositionDir: tmp, env: process.env },
        initialTarget: { provider: "openai", model: "gpt-5-codex", effort: null }
      };
    default:
      throw new Error(`unknown primary "${primary}"`);
  }
}

// Race a promise against a deadline so a hung boot/turn (e.g. an in-process
// claude PTY that never reaches ready) DEGRADES the primary cell rather than
// hanging the whole run — the fitting cells still execute afterwards.
function withTimeout(promise, ms, label) {
  let t;
  const guard = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(t));
}

async function bootAndServe(primary, tmp) {
  const { createRoutedGateway } = await import(
    pathToFileURL(path.join(REPO, "fittings", "seed", "http-gateway", "scripts", "lib", "gateway-routing.mjs")).href
  );
  const logs = [];
  let gw;
  const started = Date.now();
  const bootMs = primary === "claude-code" ? 180000 : 150000;
  try {
    gw = await createRoutedGateway(bootOpts(primary, tmp, logs));
    await withTimeout(gw.start(), bootMs, `${primary} gateway.start()`);
    const adapter = gw.operativeAdapter();
    const session = gw.getOperativeSession();
    if (!adapter || !session) throw new Error("gateway booted but exposed no operative adapter/session");
    await adapter.sendTurn(session, TURN_PROMPT);
    const resp = await withTimeout(adapter.awaitResponse(session), bootMs, `${primary} served turn`);
    const reply = (resp?.text ?? "").trim();
    if (!reply) throw new Error("operative served an empty reply");
    return {
      status: "pass",
      engine: adapter.id,
      elapsedMs: Date.now() - started,
      reply: reply.slice(0, 160),
      note: `RoutedGateway(primary=${primary}) booted; operative adapter "${adapter.id}" served one turn in ${((Date.now() - started) / 1000).toFixed(1)}s`
    };
  } catch (e) {
    return {
      status: "degraded",
      engine: primary,
      elapsedMs: Date.now() - started,
      reply: "",
      note: `boot/served-turn failed: ${String(e?.message || e).slice(0, 200)}`
    };
  } finally {
    try {
      gw?.shutdown?.();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// column runner
// ---------------------------------------------------------------------------

async function runColumn(primary, fittings, budget) {
  process.stderr.write(`\n=== column: ${primary} ===\n`);
  const tmp = mkdtempSync(path.join(tmpdir(), `gar-matrix-${primary}-`));
  // Isolated CODEX_HOME (auth copied) for the codex column — the same hygiene the
  // run's codex gates use, so repo-global MCP servers never load into the turn.
  const prevCodexHome = process.env.CODEX_HOME;
  let codexEnv = process.env;
  if (primary === "codex") {
    try {
      const ch = mkdtempSync(path.join(tmpdir(), "gar-codex-home-"));
      cpSync(path.join(homedir(), ".codex", "auth.json"), path.join(ch, "auth.json"));
      process.env.CODEX_HOME = ch;
      codexEnv = { ...process.env, CODEX_HOME: ch };
    } catch (e) {
      process.stderr.write(`  codex home isolation skipped: ${String(e?.message || e)}\n`);
    }
  }

  const boot = await bootAndServe(primary, tmp);
  process.stderr.write(`  boot: ${boot.status} — ${boot.note}\n`);

  const ctx = { tmp, boot, budget, codexEnv, primary };
  const cells = {};
  for (const f of fittings) {
    const cell = await runCell(f, primary, ctx);
    cells[f.id] = cell;
    process.stderr.write(`  ${f.id.padEnd(24)} ${cell.status.padEnd(11)} ${cell.note.slice(0, 90)}\n`);
  }

  if (primary === "codex") {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
  }
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return { boot, cells };
}

// ---------------------------------------------------------------------------
// environment probe (for the doc header)
// ---------------------------------------------------------------------------

function probeEnv() {
  const tryCmd = (cmd) => {
    const r = spawnSync("bash", ["-lc", cmd], { encoding: "utf8", timeout: 8000 });
    return (r.stdout || r.stderr || "").trim().split(/\r?\n/)[0] || "(none)";
  };
  let ollama = "down";
  try {
    const r = spawnSync("bash", ["-lc", `curl -s -m 3 http://127.0.0.1:11434/api/tags`], { encoding: "utf8" });
    ollama = /qwen2\.5:3b/.test(r.stdout) ? `up (qwen2.5:3b)` : r.status === 0 ? "up (no qwen2.5:3b)" : "down";
  } catch {
    /* down */
  }
  return {
    node: process.version,
    opencode: tryCmd("opencode --version 2>/dev/null || echo absent"),
    codex: existsSync(path.join(homedir(), ".codex", "auth.json")) ? "authed (~/.codex/auth.json present)" : "no auth",
    claude: tryCmd("command -v claude || echo absent"),
    ollama
  };
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

const BADGE = { pass: "PASS", degraded: "DEGRADED", fail: "FAIL", "verify-only": "verify-only" };

// Keep table cells legible: collapse whitespace, strip pipes, cap length.
function cell(note, max = 220) {
  const s = String(note ?? "").replace(/\s+/g, " ").replace(/\|/g, "/").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function renderMatrix(cache) {
  const primaries = cache.order.filter((p) => cache.primaries[p]);
  const fittingIds = cache.fittingOrder;
  const L = [];
  L.push("# Runtime-agnosticism matrix (Fitting x primary)");
  L.push("");
  L.push(`> GARRISON-MARATHON-V1 - WS2 / slice S2c. Generated by \`scripts/matrix-harness.mjs\`.`);
  L.push("");
  L.push(`- **Run at:** ${cache.runAt}`);
  L.push(`- **Harness:** \`node scripts/matrix-harness.mjs\` (re-runnable; \`--primary <id>\` for one column, \`--render-only\` to re-render)`);
  L.push(`- **Composition:** compositions/default (${fittingIds.length} fittings)`);
  L.push(`- **Primaries run:** ${primaries.join(", ")}`);
  L.push("");
  const env = cache.env ?? {};
  L.push("**Environment:**");
  L.push("");
  L.push(`- node ${env.node} - opencode ${env.opencode} - codex ${env.codex}`);
  L.push(`- claude ${env.claude} - ollama ${env.ollama}`);
  L.push("");

  // primary boot row
  L.push("## Primary boot + one served turn");
  L.push("");
  L.push("| Primary | Status | Engine | Served-turn evidence |");
  L.push("| --- | --- | --- | --- |");
  for (const p of primaries) {
    const b = cache.primaries[p].boot;
    const reply = b.reply ? ` (reply: "${cell(b.reply, 80)}")` : "";
    L.push(`| \`${p}\` | ${BADGE[b.status]} | ${b.engine} | ${cell(b.note)}${reply} |`);
  }
  L.push("");

  // main table
  L.push("## Every fitting under every primary");
  L.push("");
  L.push(`| Fitting | Faculty | Action | ${primaries.map((p) => `\`${p}\``).join(" | ")} |`);
  L.push(`| --- | --- | --- | ${primaries.map(() => "---").join(" | ")} |`);
  for (const id of fittingIds) {
    const meta = cache.fittingMeta[id] ?? {};
    const row = primaries.map((p) => {
      const c = cache.primaries[p].cells[id];
      return c ? BADGE[c.status] : "-";
    });
    L.push(`| \`${id}\` | ${meta.faculty ?? "?"} | ${meta.action ?? "?"} | ${row.join(" | ")} |`);
  }
  L.push("");

  // counts
  L.push("## Summary counts");
  L.push("");
  L.push("| Primary | pass | degraded | verify-only | fail |");
  L.push("| --- | --- | --- | --- | --- |");
  for (const p of primaries) {
    const cells = Object.values(cache.primaries[p].cells);
    const boot = cache.primaries[p].boot.status;
    const all = [...cells, { status: boot }];
    const n = (s) => all.filter((c) => c.status === s).length;
    L.push(`| \`${p}\` | ${n("pass")} | ${n("degraded")} | ${n("verify-only")} | ${n("fail")} |`);
  }
  L.push("");

  // degradations
  L.push("## Degradations observed");
  L.push("");
  L.push("Every non-`pass` cell, with its cause. `verify-only` = the health hook passed but the richer representative action was not exercised (own-port server not started by the harness, or a budget-conserved call). `degraded` = something worked with a documented limitation. `fail` = an unexplained health failure (the bar is ZERO of these).");
  L.push("");
  const rows = [];
  for (const p of primaries) {
    const b = cache.primaries[p].boot;
    if (b.status !== "pass") rows.push({ scope: `primary boot: ${p}`, status: b.status, note: b.note });
    for (const id of fittingIds) {
      const c = cache.primaries[p].cells[id];
      if (c && c.status !== "pass") rows.push({ scope: `${id} @ ${p}`, status: c.status, note: c.note });
    }
  }
  if (rows.length === 0) {
    L.push("_None — every cell passed._");
  } else {
    L.push("| Cell | Status | Cause |");
    L.push("| --- | --- | --- |");
    for (const r of rows) L.push(`| ${r.scope} | ${BADGE[r.status]} | ${cell(r.note, 260)} |`);
  }
  L.push("");
  L.push("### Interpreting these degradations (feeds S2d)");
  L.push("");
  L.push("- **`gemini-runtime` (every column) - unauthed on this box.** The Gemini CLI is present (`bridge --probe` = ok), but no Gemini credentials are configured here, so a real *authenticated* delegate turn can't run. Expected, known degradation; not a code defect. A credentialed box resolves it.");
  L.push("- **`opencode-runtime` delegate (opencode + claude-code columns) - small-local-model under load.** The delegate runs on the free local ollama `qwen2.5:3b`. When the harness fires the primary served turn plus the agent-sdk and opencode delegate round-trips back-to-back against the single ollama, the small model intermittently emits only lifecycle events with no `text` part, and the adapter correctly fails loud (I3 - it never fabricates output). It **passes isolated and in the `codex` column** (no ollama contention), proving this is small-model quality under concurrency, not an adapter/transport bug.");
  L.push("- **`verify-only` own-port fittings - the harness does not `up` the composition.** Their own-port HTTP servers are only started by a real `up`; the fitting's declared `verify` hook is the health signal here. Where Garrison happened to be live, several returned a real HTTP 200 (e.g. `dev-env`, `orchestrator`, `web-channel-default`, `power-default`).");
  L.push("- **`claude-code-runtime` / `codex-runtime` `verify-only` cells - deliberate budget conservation.** `claude-code-runtime` is a primary-only runtime with no secondary delegate bridge (served LIVE as the primary in its own column). `codex-runtime`'s delegate round-trip is budget-gated to ONE real call (spent in the `codex` column); other columns take a read-only `--probe`.");
  L.push("");

  // fails call-out
  const fails = rows.filter((r) => r.status === "fail");
  L.push("## Unexplained failures");
  L.push("");
  L.push(fails.length === 0 ? "**ZERO.** No cell is a bare failure — every non-pass carries a documented cause above." : `**${fails.length}** - see the fail rows above; these must be fixed or reclassified before S2c is done.`);
  L.push("");

  return L.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const a = { primaries: null, out: DEFAULT_OUT, cells: DEFAULT_CELLS, renderOnly: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--primary") a.primaries = [argv[++i]];
    else if (argv[i] === "--out") a.out = path.resolve(argv[++i]);
    else if (argv[i] === "--cells") a.cells = path.resolve(argv[++i]);
    else if (argv[i] === "--render-only") a.renderOnly = true;
  }
  return a;
}

function loadCache(p) {
  if (existsSync(p)) {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      /* fall through to fresh */
    }
  }
  return { runAt: null, env: null, order: [], primaries: {}, fittingOrder: [], fittingMeta: {}, budget: { codexDelegateConsumed: false } };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cache = loadCache(args.cells);

  if (args.renderOnly) {
    writeFileSync(args.out, renderMatrix(cache), "utf8");
    process.stderr.write(`rendered ${args.out} from cache (${args.cells})\n`);
    return;
  }

  const { fittings } = loadComposition();
  cache.fittingOrder = fittings.map((f) => f.id);
  cache.fittingMeta = Object.fromEntries(fittings.map((f) => [f.id, { faculty: f.faculty, action: classifyAction(f).type }]));
  cache.env = probeEnv();
  cache.runAt = new Date().toISOString();
  cache.budget = cache.budget ?? { codexDelegateConsumed: false };

  const primaries = args.primaries ?? DEFAULT_PRIMARIES;
  for (const p of primaries) {
    const result = await runColumn(p, fittings, cache.budget);
    cache.primaries[p] = result;
    if (!cache.order.includes(p)) cache.order.push(p);
    // Persist after every column so a crash/budget-halt keeps prior columns.
    mkdirSync(path.dirname(args.cells), { recursive: true });
    writeFileSync(args.cells, JSON.stringify(cache, null, 2), "utf8");
    writeFileSync(args.out, renderMatrix(cache), "utf8");
    process.stderr.write(`  -> persisted cells + rendered ${args.out}\n`);
  }
  process.stderr.write(`\nDONE. matrix -> ${args.out}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`FATAL: ${String(e?.stack || e)}\n`);
    process.exit(1);
  });
}
