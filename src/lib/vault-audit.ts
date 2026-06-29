import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Tamper-evident-ish access trail for the Vault: who read which secret, when, and
// the outcome. Append-only JSONL so a security reviewer can inspect it. Best
// effort — an audit write never blocks or fails a secret delivery.

export type VaultAuditAction = "deliver" | "read" | "refresh" | "revoke" | "denied";

export interface VaultAuditEntry {
  ts: string;
  connector: string;
  secrets: string[];
  action: VaultAuditAction;
  outcome: "ok" | "denied" | "error";
  detail?: string;
}

function auditPath(): string {
  if (process.env.GARRISON_VAULT_AUDIT_PATH) return process.env.GARRISON_VAULT_AUDIT_PATH;
  const home = process.env.GARRISON_HOME ?? path.join(os.homedir(), ".garrison");
  return path.join(home, "vault-audit.jsonl");
}

// `ts` is injected by the caller (or stamped here) — kept as a param so a test
// can assert deterministic ordering. Append is atomic enough for a single-writer
// local log (O_APPEND); the data is advisory, not transactional.
export async function recordVaultAccess(entry: Omit<VaultAuditEntry, "ts"> & { ts?: string }): Promise<void> {
  try {
    const full: VaultAuditEntry = {
      ts: entry.ts ?? new Date().toISOString(),
      connector: entry.connector,
      secrets: entry.secrets,
      action: entry.action,
      outcome: entry.outcome,
      ...(entry.detail ? { detail: entry.detail } : {})
    };
    const file = auditPath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(full)}\n`, { encoding: "utf8" });
  } catch {
    // Audit is best-effort; never break a delivery on a log failure.
  }
}

// Read the most recent `limit` audit entries (newest last). Returns [] when the
// log does not exist yet.
export async function readVaultAudit(limit = 200): Promise<VaultAuditEntry[]> {
  try {
    const raw = await fs.readFile(auditPath(), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    return lines
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l) as VaultAuditEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is VaultAuditEntry => e !== null);
  } catch {
    return [];
  }
}
