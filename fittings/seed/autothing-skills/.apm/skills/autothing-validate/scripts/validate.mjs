#!/usr/bin/env node
// autothing-validate — deterministic Definition-of-Done checker for ONE slice.
//
//   node validate.mjs <runDir> <sliceId>
//   node validate.mjs --run-dir <runDir> --slice <sliceId> [--strict]
//
// Reads <runDir>/slices/<sliceId>/gate-status.json (and <runDir>/evidence-index.json
// if present), checks the per-slice DoD from gate-status.gates, writes a durable
// `validated` marker back into gate-status.json (read-fresh -> mutate -> atomic write),
// prints one human-readable `VALIDATE check <gate>: <ok|FAIL ...>` line per check, and
// ends with a single parseable verdict line — EXACTLY `Done` or `Implement`, nothing after.
//
// Exit code is 0 by default (the Kanban router parses the last stdout line, NOT the
// exit code). With --strict, a failing DoD exits non-zero for standalone CLI use.
//
// Pure Node — no deps beyond builtins.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---- arg parsing -----------------------------------------------------------
function parseArgs(argv) {
  const out = { runDir: null, slice: null, strict: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--strict") out.strict = true;
    else if (a === "--run-dir") out.runDir = argv[++i];
    else if (a === "--slice") out.slice = argv[++i];
    else if (a.startsWith("--run-dir=")) out.runDir = a.slice("--run-dir=".length);
    else if (a.startsWith("--slice=")) out.slice = a.slice("--slice=".length);
    else positional.push(a);
  }
  if (!out.runDir && positional[0]) out.runDir = positional[0];
  if (!out.slice && positional[1]) out.slice = positional[1];
  return out;
}

// ---- verdict + exit --------------------------------------------------------
// The verdict is the LAST non-empty stdout line. Nothing prints after it.
function emit(verdict, strict) {
  process.stdout.write(verdict + "\n");
  if (strict && verdict !== "Done") process.exit(1);
  process.exit(0);
}

// ---- atomic, formatting-preserving rewrite of one JSON document ------------
// Read-fresh -> mutate -> write WHOLE document via temp file + rename, so we never
// clobber concurrent fields and never leave a torn file.
function writeValidatedMarker(gateStatusPath, status, failed, atIso) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(gateStatusPath, "utf8"));
  } catch {
    return false; // can't read a fresh copy; skip the marker rather than corrupt it
  }
  doc.validated = { status, at: atIso, failed };
  const tmp = gateStatusPath + ".tmp-" + process.pid + "-" + Date.now();
  const json = JSON.stringify(doc, null, 2) + "\n";
  try {
    fs.writeFileSync(tmp, json, { mode: 0o644 });
    fs.renameSync(tmp, gateStatusPath);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    return false;
  }
}

// ---- gate readers ----------------------------------------------------------
function exitGate(gates, name) {
  const g = gates[name];
  if (!g || typeof g.exit !== "number") {
    return { ok: false, detail: g ? `exit=${JSON.stringify(g.exit)}` : "missing" };
  }
  return { ok: g.exit === 0, detail: `exit=${g.exit}` };
}

// ---- main ------------------------------------------------------------------
function run() {
  const { runDir, slice, strict } = parseArgs(process.argv.slice(2));
  const nowIso = new Date().toISOString();

  if (!runDir || !slice) {
    console.log("VALIDATE check args: FAIL — usage: node validate.mjs <runDir> <sliceId>");
    return emit("Implement", strict);
  }

  const gateStatusPath = path.join(runDir, "slices", slice, "gate-status.json");
  if (!fs.existsSync(gateStatusPath)) {
    console.log(`VALIDATE check gate-status: FAIL — no gate-status.json at ${gateStatusPath}`);
    return emit("Implement", strict);
  }

  let gs;
  try {
    gs = JSON.parse(fs.readFileSync(gateStatusPath, "utf8"));
  } catch (e) {
    console.log(`VALIDATE check gate-status: FAIL — unparseable JSON (${e.message})`);
    return emit("Implement", strict);
  }

  const gates = gs.gates && typeof gs.gates === "object" ? gs.gates : {};
  // Fail closed on a missing/invalid kind: a DoD gate must never infer the most
  // lenient kind from absent metadata — that would let a partial/garbage
  // gate-status.json skip the UI-only gates and still yield Done.
  const VALID_KINDS = ["ui", "automation", "mixed"];
  const kind = gs.kind;
  const kindValid = VALID_KINDS.includes(kind);
  const isUi = kind === "ui";
  const wantsPwTest = kind === "ui" || kind === "mixed";

  // evidence-index.json is read for context/robustness; the DoD is decided from
  // the slice gate-status (the authoritative per-slice marker).
  const evidencePath = path.join(runDir, "evidence-index.json");
  if (fs.existsSync(evidencePath)) {
    try {
      JSON.parse(fs.readFileSync(evidencePath, "utf8"));
      console.log("VALIDATE check evidence-index: ok — present");
    } catch {
      console.log("VALIDATE check evidence-index: note — present but unparseable (non-fatal)");
    }
  } else {
    console.log("VALIDATE check evidence-index: note — absent (non-fatal)");
  }

  const failed = [];

  // Kind must be a recognized value — fail closed otherwise (see VALID_KINDS).
  if (!kindValid) {
    console.log(`VALIDATE check kind: FAIL — kind=${JSON.stringify(kind ?? null)} (must be one of ${VALID_KINDS.join("|")})`);
    failed.push(`kind=${JSON.stringify(kind ?? null)} invalid`);
  } else {
    console.log(`VALIDATE check kind: ok — ${kind}`);
  }

  // Objective exit-code gates (all required).
  for (const name of ["tests", "typecheck", "lint", "build", "e2e"]) {
    const r = exitGate(gates, name);
    console.log(`VALIDATE check ${name}: ${r.ok ? "ok" : "FAIL"} — ${r.detail}`);
    if (!r.ok) failed.push(`${name} ${r.detail}`);
  }

  // UX QA — only required for UI slices. The gate passes when there is no
  // BLOCKING finding: verdict 'clean' (no findings at all), or verdict 'issues'
  // with every finding BELOW the loop-back threshold (clean-with-notes). It fails
  // when any finding is AT OR ABOVE the threshold, or when the gate is missing /
  // skipped on a UI slice (a UI slice always has a UI to walk). Severity order:
  // blocker > major > minor > note; threshold defaults to 'major'. This mirrors
  // garrison-ux-qa's own loop-back rule exactly.
  {
    const SEVERITY_RANK = { note: 0, minor: 1, major: 2, blocker: 3 };
    const uq = gates.uxQa;
    const threshold = (uq && typeof uq.severityThreshold === "string" && uq.severityThreshold) || "major";
    const thr = SEVERITY_RANK[threshold] ?? SEVERITY_RANK.major;
    if (!isUi) {
      console.log(`VALIDATE check uxQa: ok — n/a (kind=${kind})`);
    } else if (!uq || typeof uq !== "object") {
      console.log("VALIDATE check uxQa: FAIL — missing (kind=ui requires a ux-qa gate)");
      failed.push("uxQa missing");
    } else if (uq.verdict === "skipped") {
      console.log("VALIDATE check uxQa: FAIL — skipped (kind=ui always has a UI to walk)");
      failed.push("uxQa skipped");
    } else {
      const findings = Array.isArray(uq.findings) ? uq.findings : [];
      const blocking = findings.filter((f) => (SEVERITY_RANK[f && f.severity] ?? 0) >= thr);
      if (uq.verdict === "clean" || blocking.length === 0) {
        const note =
          uq.verdict === "clean"
            ? "clean"
            : `clean-with-notes (${findings.length} finding(s), all below ${threshold})`;
        console.log(`VALIDATE check uxQa: ok — ${note}`);
      } else {
        console.log(
          `VALIDATE check uxQa: FAIL — ${blocking.length} finding(s) >= ${threshold} (verdict=${JSON.stringify(uq.verdict ?? null)})`
        );
        failed.push(`uxQa ${blocking.length} finding(s) >= ${threshold}`);
      }
    }
  }

  // Fresh-context Anthropic review (autothing-adversarial-review) — 'approve' required.
  // Renamed from codexReview: this gate is no longer a Codex call (decorrelation is now
  // by fresh context, not vendor); the genuine cross-model check moved run-level to
  // autothing-codex-checkpoint (evidence-index.json globalGate.codexCheckpoint), which
  // is not part of a single slice's DoD and so is not checked here.
  {
    const v = gates.adversarialReview && gates.adversarialReview.verdict;
    if (v === "approve") {
      console.log(`VALIDATE check adversarialReview: ok — ${v}`);
    } else {
      console.log(`VALIDATE check adversarialReview: FAIL — verdict=${JSON.stringify(v ?? null)} (need approve)`);
      failed.push(`adversarialReview verdict=${JSON.stringify(v ?? null)}`);
    }
  }

  // Independent Anthropic test pass (autothing-adversarial-test) — required for ui/mixed; tolerate n/a for pure-CLI.
  {
    const r = gates.adversarialTest && gates.adversarialTest.result;
    if (!wantsPwTest) {
      // Pure non-UI (automation) slice: no running app to drive.
      console.log(`VALIDATE check adversarialTest: ok — n/a (kind=${kind})`);
    } else if (r === "pass") {
      console.log("VALIDATE check adversarialTest: ok — pass");
    } else if (isUi) {
      // A UI slice ALWAYS has an app to drive — 'n/a' is not acceptable; it must pass.
      console.log(`VALIDATE check adversarialTest: FAIL — result=${JSON.stringify(r ?? null)} (kind=ui requires pass)`);
      failed.push(`adversarialTest result=${JSON.stringify(r ?? null)} (ui requires pass)`);
    } else if (r === "n/a") {
      // A 'mixed' slice may legitimately be backend-only with no running app.
      console.log("VALIDATE check adversarialTest: ok — n/a (mixed slice, no running app to drive)");
    } else {
      console.log(`VALIDATE check adversarialTest: FAIL — result=${JSON.stringify(r ?? null)} (need pass|n/a)`);
      failed.push(`adversarialTest result=${JSON.stringify(r ?? null)}`);
    }
  }

  // Verified walkthrough video — REQUIRED. failed-but-unblocking or missing FAILS.
  {
    const v = gates.video && gates.video.status;
    if (v === "verified") {
      console.log("VALIDATE check video: ok — verified");
    } else {
      console.log(`VALIDATE check video: FAIL — status=${JSON.stringify(v ?? null)} (need verified)`);
      failed.push(`video status=${JSON.stringify(v ?? null)}`);
    }
  }

  let status = failed.length === 0 ? "Done" : "Implement";

  // The durable `validated` marker IS part of the DoD: if we cannot persist it,
  // we cannot honestly report Done — fail closed to Implement (the safe routing
  // answer; the card re-enters the loop rather than advancing on an unrecorded pass).
  const wrote = writeValidatedMarker(gateStatusPath, status, failed, nowIso);
  if (!wrote) {
    console.log("VALIDATE check validated-marker: FAIL — could not persist the validated marker into gate-status.json");
    status = "Implement";
  } else {
    console.log("VALIDATE check validated-marker: ok — persisted");
  }

  console.log(
    `VALIDATE verdict: ${status}` + (failed.length ? ` — failed: ${failed.join("; ")}` : " — all checks passed")
  );

  return emit(status, strict);
}

run();
