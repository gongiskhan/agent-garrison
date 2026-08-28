// Running a named Cortex automation from a spoken command.
//
// Three things here are not obvious and all three come from the fitting's own
// skill documentation:
//
//   * The binary and base URL come from the INSTALL RECEIPT
//     (~/.garrison/cortex-client/install.json), never a baked path. Neither
//     resolving is the SHIPPED DEFAULT - Cortex is optional - so it is a state
//     to say out loud, not an error to debug.
//   * `watch` POLLS, for minutes. It must never be on the voice path. Fire
//     `run`, say "Comecei", and poll `status` in the background.
//   * Exit codes are read from a redirect, never through a pipe: a piped call
//     reports the status of the last command in the pipeline, and a failed
//     cortex call writes empty stdout.
//
// --idempotency-key is the reason this lives in the fitting rather than in a
// delegated operative turn: it is what makes a spoken command at-most-once. The
// key is the wake event id, so a transport retry of the SAME utterance cannot
// double-execute, while the same words spoken tomorrow legitimately run again.

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { normalizeTitle } from "./wake.mjs";

const DEFAULT_TIMEOUT_MS = 20_000;

export function readInstallReceipt(env = process.env) {
  const home = env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
  try {
    const doc = JSON.parse(readFileSync(path.join(home, "cortex-client", "install.json"), "utf8"));
    const bin = typeof doc?.bin === "string" ? doc.bin : null;
    return bin && existsSync(bin) ? { bin, baseUrl: doc?.base_url ?? null } : null;
  } catch {
    return null;
  }
}

export class CortexCli {
  constructor({ cfg, counters = null, env = process.env, execImpl = execFile, log = console }) {
    this.cfg = cfg;
    this.counters = counters;
    this.env = env;
    this.exec = execImpl;
    this.log = log;
    this.catalog = null; // { at, items }
  }

  receipt() {
    return readInstallReceipt(this.env);
  }

  run_(args, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const receipt = this.receipt();
    if (!receipt) return Promise.reject(Object.assign(new Error("cortex not installed"), { unavailable: true }));
    return new Promise((resolve, reject) => {
      this.exec(
        receipt.bin,
        [...args, "--json"],
        { timeout: timeoutMs, env: { ...this.env, ...(receipt.baseUrl ? { CORTEX_BASE_URL: receipt.baseUrl } : {}) } },
        (err, stdout) => {
          if (err) {
            // Exit 2 is a bad invocation or a missing variable - nothing was
            // sent. Exit 1 is the provider refusing. Both are worth saying.
            reject(Object.assign(new Error(String(err.message ?? err)), { code: err.code ?? null }));
            return;
          }
          try {
            resolve(JSON.parse(String(stdout).trim() || "{}"));
          } catch {
            reject(new Error("cortex returned unparseable JSON"));
          }
        }
      );
    });
  }

  async list() {
    const ttl = this.cfg.cortexCatalogTtlMs ?? 300000;
    if (this.catalog && Date.now() - this.catalog.at < ttl) return this.catalog.items;
    const doc = await this.run_(["automations", "list"]);
    const items = Array.isArray(doc?.automations) ? doc.automations : Array.isArray(doc) ? doc : [];
    this.catalog = { at: Date.now(), items };
    return items;
  }

  // A spoken name against a real catalog. normalizeTitle is reused because it
  // is already accent- and punctuation-insensitive, which is exactly the
  // spoken-name problem. Never guesses among several - the resolveCard doctrine.
  async resolve(spokenName) {
    if (!this.receipt()) return { status: "unavailable" };
    let items;
    try {
      items = await this.list();
    } catch (err) {
      if (err?.unavailable) return { status: "unavailable" };
      throw err;
    }
    const want = normalizeTitle(spokenName);
    if (!want) return { status: "none" };
    const named = items.map((a) => ({ id: a?.id ?? a?.slug ?? null, name: a?.name ?? a?.title ?? "" })).filter((a) => a.id);
    const exact = named.filter((a) => normalizeTitle(a.name) === want);
    if (exact.length === 1) return { status: "ok", ...exact[0] };
    const partial = named.filter((a) => normalizeTitle(a.name).includes(want));
    if (partial.length === 1) return { status: "ok", ...partial[0] };
    if (partial.length > 1) return { status: "ambiguous", candidates: partial.map((a) => a.name) };
    return { status: "none" };
  }

  async run(automationId, inputs = {}, idempotencyKey = null) {
    const args = ["automations", "run", automationId];
    for (const [k, v] of Object.entries(inputs)) args.push("--input", `${k}=${v}`);
    if (idempotencyKey) args.push("--idempotency-key", idempotencyKey);
    const doc = await this.run_(args);
    this.counters?.bump?.("cortex_runs");
    return { runId: doc?.run?.id ?? doc?.runId ?? null, created: doc?.created !== false };
  }

  async status(runId) {
    const doc = await this.run_(["automations", "status", runId]);
    return doc?.run ?? doc ?? null;
  }
}
