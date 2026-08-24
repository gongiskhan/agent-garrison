// Keeping the remote able to host its tunnel, without a human on that machine.
//
// THE PROBLEM THIS SOLVES. A devtunnel login lasts well under a day, and
// `devtunnel host` cannot run without one. On a machine reachable ONLY through
// the tunnel it is hosting, that is a trap: when the credential lapses the tunnel
// drops, and the only way to renew it is to be at that machine. The outage is
// self-sealing and no amount of supervision on either side can open it.
//
// THE WAY OUT. Garrison holds the account, so Garrison mints the credential. A
// host-scoped tunnel token lasts 24h and needs no interactive step to use, so this
// side mints one and pushes it over the ssh channel that is already up, on a
// cadence far shorter than its lifetime. The remote's supervisor reads it from
// disk on every restart. The remote never logs in again.
//
// SLACK, NOT PERPETUITY. Refreshing hourly against a 24h token means the tunnel
// survives roughly a day of Garrison being down, off, or unable to mint. It is not
// unbreakable - if this side cannot mint for a full day (its own login expired,
// say) the remote lapses too. That is a strictly better failure than today's,
// because it takes a day rather than nine hours AND because the repair happens
// HERE, on the machine a human can actually reach.
//
// DIRECTION. Unchanged: Garrison pushes over its own outbound ssh. The remote
// opens nothing, dials nothing, and learns nothing about Garrison's address.

import { spawn } from "node:child_process";
import { resolveDevtunnelBin, sshExec } from "./transports.mjs";

/** Where the remote's supervisor reads its token. Matches host-tunnel.sh. */
export const REMOTE_TOKEN_PATH = "$HOME/.garrison/host-token";

/** How often to push a fresh token. Far under the 24h token lifetime. */
export const DEFAULT_REFRESH_MS = 60 * 60 * 1000;

/** Run a short-lived CLI, collecting output. */
function runTool(spawnFn, bin, argv, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawnFn(bin, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(null);
    }, timeoutMs);
    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr += d; });
    child.on("close", finish);
    child.on("error", (err) => { stderr += String(err); finish(null); });
  });
}

/**
 * Mint a host-scoped token for a tunnel. Host scope is enough for BOTH hosting
 * and the supervisor's `devtunnel show` health read, so the remote needs exactly
 * one credential rather than a pair with different lifetimes.
 */
export async function mintHostToken(
  tunnelId,
  // Defaults matter here: the server calls this on a timer with no options at
  // all, so an undefined spawn or a bare "devtunnel" would fail on the first
  // tick - on a box where the CLI lives in ~/.local/bin, off PATH.
  { bin = resolveDevtunnelBin(), spawnFn = spawn, timeoutMs = 20_000 } = {}
) {
  const result = await runTool(spawnFn, bin, ["token", tunnelId, "--scopes", "host", "--json"], timeoutMs);
  const start = result.stdout.indexOf("{");
  if (start >= 0) {
    try {
      const parsed = JSON.parse(result.stdout.slice(start));
      if (parsed?.token) {
        return { ok: true, token: String(parsed.token), expiration: parsed.expiration ?? null };
      }
    } catch {
      /* fall through to the text-shaped answer */
    }
  }
  const text = `${result.stdout}\n${result.stderr}`;
  // This side's own credential is the single point of failure left, so name it
  // rather than reporting a generic mint failure.
  if (/login token expired|token (?:has )?expired|login required|not logged in/i.test(text)) {
    return { ok: false, reason: "login", error: "Garrison's own devtunnel login has lapsed, so it cannot mint a host token for the remote. Run `devtunnel user login -g -d` HERE." };
  }
  return { ok: false, reason: "mint", error: (text.trim().slice(-300) || "devtunnel token produced no token") };
}

/**
 * Write a token to the remote. Delivered on stdin and never in argv - argv is
 * world-readable in `ps` on both machines. Staged and renamed so a supervisor
 * reading concurrently sees either the old token or the new one, never a
 * half-written file, and created under `umask 077` so it is never briefly
 * readable by others.
 */
export async function pushHostToken(transport, token, { exec = sshExec, timeoutMs = 20_000 } = {}) {
  const script = [
    "umask 077",
    'mkdir -p "$HOME/.garrison"',
    `cat > ${REMOTE_TOKEN_PATH}.tmp`,
    `mv ${REMOTE_TOKEN_PATH}.tmp ${REMOTE_TOKEN_PATH}`,
    `printf 'GARRISON_TOKEN_BYTES %s\\n' "$(wc -c < ${REMOTE_TOKEN_PATH} | tr -d ' ')"`
  ].join("\n");
  const result = await exec(transport, script, { timeoutMs, input: token });
  if (result.code !== 0) {
    return { ok: false, error: (result.stderr || "").trim().slice(-300) || "ssh write failed" };
  }
  const written = Number(/GARRISON_TOKEN_BYTES (\d+)/.exec(result.stdout)?.[1] ?? 0);
  // A short write is worse than no write: the supervisor would treat a truncated
  // token as a credential and fail to authenticate with no idea why.
  if (written !== Buffer.byteLength(token)) {
    return { ok: false, error: `token landed truncated (${written} of ${Buffer.byteLength(token)} bytes)` };
  }
  return { ok: true, bytes: written };
}

/**
 * Mint and deliver for every transport that rides a devtunnel. Direct-ssh
 * transports need nothing: they have no tunnel credential to keep alive.
 *
 * Failure is per-transport and never throws - this runs on a timer beside a live
 * server, and one unreachable remote must not stop the others being refreshed.
 */
export async function refreshHostTokens(transports, opts = {}) {
  const out = [];
  const minted = new Map(); // tunnelId -> mint result; two transports can share a tunnel
  for (const transport of transports) {
    const dt = transport.via?.devtunnel;
    if (!dt) continue;
    // Bring the channel up first. At startup nothing else has, and the push is
    // plain ssh through the forward - without this it fails on every boot and the
    // remote silently keeps ageing out its token (caught live: the fitting
    // restarted and the token on the remote never changed).
    if (opts.ensure) {
      const tunnel = await opts.ensure(transport);
      if (tunnel && tunnel.ok === false) {
        out.push({ transport: transport.name, tunnel: dt.tunnel, ok: false, stage: "tunnel", error: tunnel.error });
        continue;
      }
    }
    if (!minted.has(dt.tunnel)) minted.set(dt.tunnel, await mintHostToken(dt.tunnel, opts));
    const mint = minted.get(dt.tunnel);
    if (!mint.ok) {
      out.push({ transport: transport.name, tunnel: dt.tunnel, ok: false, stage: "mint", error: mint.error });
      continue;
    }
    const push = await pushHostToken(transport, mint.token, opts);
    out.push({
      transport: transport.name,
      tunnel: dt.tunnel,
      ok: push.ok,
      stage: push.ok ? "delivered" : "push",
      expiration: mint.expiration,
      error: push.ok ? null : push.error
    });
  }
  return out;
}
