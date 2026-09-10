// Read-only account observations on the owning node. Credentials never leave
// this module. Account limits are not attributed to a particular agent turn.
import { spawn, execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { claudeHome, claudeJsonPath } from "./claude-home";
import { nativeCredentialPath } from "./machine-login";
import { probeAccountUsage, readUsageCache, type AccountUsage } from "./paymaster";

const exec = promisify(execFile);
export interface SessionUsageWindow { label: string; usedPercent: number; resetsAt: string | null }
export interface SessionAccountUsage {
  provider: string; account: string; plan?: string; status: "available" | "unavailable" | "stale";
  windows: SessionUsageWindow[]; checkedAt: string | null; detail?: string; dashboardUrl?: string;
}
const clean = (x: unknown) => typeof x === "string" ? x.slice(0, 160) : undefined;
const percent = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 100;
const iso = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x > 0 && x < 8.64e12 ? new Date(x * 1000).toISOString() : null;
const now = () => new Date().toISOString();
const missing = (provider: string, account = "Machine login", detail = "Usage is unavailable for this login."): SessionAccountUsage => ({ provider, account, status: "unavailable", windows: [], checkedAt: null, detail });

export function codexUsage(result: any, account: any): SessionAccountUsage {
  const buckets = result?.rateLimitsByLimitId && Object.keys(result.rateLimitsByLimitId).length
    ? Object.entries(result.rateLimitsByLimitId) : result?.rateLimits ? [["codex", result.rateLimits]] : [];
  const windows: SessionUsageWindow[] = [];
  for (const [id, raw] of buckets) {
    const bucket = raw as any;
    for (const name of ["primary", "secondary"]) {
      const w = bucket?.[name];
      if (!percent(w?.usedPercent)) continue;
      const mins = w.windowDurationMins;
      const duration = mins === 10080 ? "Weekly" : mins === 300 ? "5 hours" : typeof mins === "number" && mins > 0 ? `${mins} minutes` : "Limit";
      windows.push({ label: `${clean(bucket.limitName) || (id === "codex" ? "Codex" : clean(id) || "Codex")} · ${duration}`, usedPercent: w.usedPercent, resetsAt: iso(w.resetsAt) });
    }
  }
  return { provider: "codex", account: clean(account?.email) || "Machine login", plan: clean(account?.planType), status: windows.length ? "available" : "unavailable", windows, checkedAt: now(), ...(!windows.length ? {detail:"This login did not report subscription limits."} : {}) };
}

// The documented stdio app-server protocol needs no thread, model turn, or
// login mutation. Stop the child after the two requested account reads.
export function readCodexAccount(home = path.dirname(nativeCredentialPath("openai")), command = "codex", timeoutMs = 12_000): Promise<SessionAccountUsage> {
  return new Promise(resolve => {
    const child = spawn(command, ["app-server"], { env: { ...process.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
    let done = false, buffer = "", bytes = 0;
    const replies = new Map<number, any>();
    const finish = (value: SessionAccountUsage) => {
      if (done) return;
      done = true; clearTimeout(timer); child.stdin.destroy(); child.kill();
      const force = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1000); force.unref();
      resolve(value);
    };
    const timer = setTimeout(() => finish(missing("codex", "Machine login", "The Codex account check timed out.")), timeoutMs);
    const write = (value: object) => { if (!done) child.stdin.write(JSON.stringify(value) + "\n"); };
    child.on("error", () => finish(missing("codex", "Machine login", "Codex is unavailable on this machine.")));
    child.stdin.on("error", () => finish(missing("codex")));
    child.stderr.resume();
    child.on("close", () => finish(missing("codex")));
    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { finish(missing("codex")); return; }
      buffer += chunk.toString();
      let end;
      while (!done && (end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let value; try { value = JSON.parse(line); } catch { continue; }
        if (value.id === 0) {
          if (value.error) { finish(missing("codex")); return; }
          write({method:"initialized"});
          write({id:1,method:"account/rateLimits/read"});
          write({id:2,method:"account/read",params:{refreshToken:false}});
        } else if (value.id === 1 || value.id === 2) {
          replies.set(value.id, value.result);
          if (replies.size === 2) finish(codexUsage(replies.get(1), replies.get(2)?.account));
        }
      }
    });
    write({id:0,method:"initialize",params:{clientInfo:{name:"garrison_usage",title:"Garrison usage",version:"1.0.0"}}});
  });
}

export function claudeUsage(usage: AccountUsage, account: string): SessionAccountUsage {
  return { provider: "claude", account, status: usage.error || Date.now() - Date.parse(usage.probedAt) > 600_000 ? "stale" : "available", checkedAt: usage.probedAt,
    windows: [["5 hours", usage.fiveHour], ["Weekly", usage.weekly]].flatMap(([label, value]) => {
      const window = value as AccountUsage["fiveHour"];
      return percent(window?.pct) ? [{ label: String(label), usedPercent: window.pct, resetsAt: window.resetAt }] : [];
    }) };
}
async function readClaude(): Promise<SessionAccountUsage[]> {
  const home = claudeHome();
  const profile = JSON.parse(await fs.readFile(claudeJsonPath(home), "utf8").catch(() => "{}"));
  const account = clean(profile?.oauthAccount?.emailAddress) || "Machine login";
  let credentials: any;
  try { credentials = JSON.parse(await fs.readFile(path.join(home, ".credentials.json"), "utf8")); } catch { /* macOS uses Keychain */ }
  if (!credentials && process.platform === "darwin" && home === path.join(homedir(), ".claude")) {
    try { credentials = JSON.parse((await exec("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { timeout: 2500, maxBuffer: 128 * 1024 })).stdout); } catch { /* Never prompt for a login. */ }
  }
  let native = missing("claude", account);
  const oauth = credentials?.claudeAiOauth;
  if (typeof oauth?.accessToken === "string" && oauth.accessToken) {
    try {
      const usage = await probeAccountUsage("machine", oauth.accessToken, (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(8000) }));
      native = { ...claudeUsage(usage, account), plan: clean(oauth.subscriptionType) };
    } catch { native.detail = "Claude did not report current limits. Its login may need refreshing in Claude Code."; }
  }
  // Existing named-account observations are explicitly distinguished from the
  // machine's login; their account-wide numbers may belong to another session.
  const cache = await readUsageCache();
  return [native, ...Object.entries(cache).map(([name, usage]) => claudeUsage(usage, `Garrison · ${name}`))];
}

async function readCursor(): Promise<SessionAccountUsage> {
  const base = process.env.GARRISON_CURSOR_STATE_DB || (process.platform === "darwin"
    ? path.join(homedir(), "Library/Application Support/Cursor/User/globalStorage/state.vscdb")
    : path.join(process.env.APPDATA || process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "Cursor/User/globalStorage/state.vscdb"));
  try {
    // Explicit allow-list. Do not select access/refresh tokens or whole state.
    const { stdout } = await exec("sqlite3", ["-readonly", "-json", base, "SELECT key,value FROM ItemTable WHERE key IN ('cursorAuth/cachedEmail','cursorAuth/stripeMembershipType')"], { timeout: 2500, maxBuffer: 16 * 1024 });
    const values = Object.fromEntries(JSON.parse(stdout || "[]").map((r: any) => [r.key, r.value]));
    return { ...missing("cursor", clean(values["cursorAuth/cachedEmail"]) || "Machine login", "Current Cursor quotas are not available from this machine. Check its usage dashboard for current totals."), plan: clean(values["cursorAuth/stripeMembershipType"]), checkedAt: now(), dashboardUrl: "https://cursor.com/dashboard?tab=usage" };
  } catch { return { ...missing("cursor", "Machine login", "No readable Cursor desktop account was found on this machine. CLI usage is available in the Cursor dashboard."), dashboardUrl: "https://cursor.com/dashboard?tab=usage" }; }
}

const cache = new Map<string, {at:number; rows:SessionAccountUsage[]}>();
const pending = new Map<string, Promise<SessionAccountUsage[]>>();
export async function sessionUsage(provider: string): Promise<SessionAccountUsage[]> {
  if (!["claude", "codex", "cursor"].includes(provider)) return [];
  const prior = cache.get(provider);
  if (prior && Date.now() - prior.at < 300_000) return prior.rows;
  const active = pending.get(provider); if (active) return active;
  const task = (async () => {
    let rows: SessionAccountUsage[];
    try { rows = provider === "claude" ? await readClaude() : [await (provider === "codex" ? readCodexAccount() : readCursor())]; }
    catch { rows = [missing(provider)]; }
    // Failure never turns previously measured usage into zero.
    if (rows[0]?.status === "unavailable" && prior?.rows[0]?.windows.length) rows[0] = {...prior.rows[0], status:"stale", detail:rows[0].detail};
    cache.set(provider, {at:Date.now(),rows}); return rows;
  })().finally(() => pending.delete(provider));
  pending.set(provider, task); return task;
}
