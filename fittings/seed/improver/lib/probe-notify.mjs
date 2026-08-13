// probe-notify.mjs — get the Probe's question in front of a human.
//
// The Probe has always asked by BLOCKING a Claude Code Stop hook and making the
// model relay the question through AskUserQuestion. When someone is watching
// that session it works. When nobody is, the question is written to a pending
// file, relayed into a terminal nobody has open, and then — before this change —
// swept away 90 seconds later as "dismissed". On prod a probe question sat
// unanswered from 31 July onward while the operator was reachable on three other
// surfaces the whole time.
//
// So the relay stays (it is the right thing for an attended session) and this
// module adds the other half: the same question, pushed to every running channel
// Fitting, answerable from wherever the operator actually is.
//
// Discovery is deliberately NOT a hardcoded transport map — a map is why
// slack-channel, which has existed and can post, was invisible to notifications
// for months. We ask every RUNNING own-port Fitting whether it accepts the
// channel notify contract; the ones that do not simply 404 and are skipped.
//
// COPIED, not imported: `runningFittingBases` and the fan-out shape come from
// fittings/seed/kanban-loop/lib/notify-origin.mjs:64 (`runningFittingBases` /
// `fanOutNotification`), and the tailnet resolution from
// fittings/seed/drill/lib/tailnet-serve.mjs. Cross-fitting imports are forbidden
// (each own-port Fitting installs independently), so copying with the source
// named is the house pattern.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";

function garrisonHome() {
  return process.env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
}

function statusFileUrl(fittingId) {
  try {
    const file = path.join(garrisonHome(), "ui-fittings", `${fittingId}.json`);
    if (!existsSync(file)) return null;
    const doc = JSON.parse(readFileSync(file, "utf8"));
    return typeof doc.url === "string" && doc.url.length ? doc.url : null;
  } catch {
    return null;
  }
}

/** Every running own-port Fitting, by its status file. Copied from
 *  kanban-loop/lib/notify-origin.mjs `runningFittingBases`. */
export function runningFittingBases() {
  try {
    const dir = path.join(garrisonHome(), "ui-fittings");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const id = f.replace(/\.json$/, "");
        return { id, base: statusFileUrl(id) };
      })
      .filter((e) => Boolean(e.base));
  } catch {
    return [];
  }
}

// ── Tailnet resolution ───────────────────────────────────────────────────────
// HARD RULE (CLAUDE.md): the operator's browser is almost never on the Garrison
// machine. A notification action pointing at http://127.0.0.1:<port> is
// unreachable from the phone that received the notification AND is mixed content
// under the HTTPS tailnet origin — a button that silently does nothing. So the
// answer URL is published in its tailnet form when `tailscale serve` maps the
// port, and the caller is told (`reachable`) when it could not be.
//
// Copied from fittings/seed/drill/lib/tailnet-serve.mjs (serveMapFromStatus).
const TAILSCALE_CANDIDATES = [
  "tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

const CACHE_TTL_MS = 30_000;
let cache = null; // { at, map }

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 4000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      // The CLI prints a version-skew warning to stderr but still returns valid
      // JSON on stdout, so a non-zero exit with usable stdout is fine.
      if (stdout && stdout.trim().startsWith("{")) return resolve(stdout);
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

/** Pure: `tailscale serve status --json` payload -> Map(localPort -> https URL). */
export function serveMapFromStatus(status) {
  const map = new Map();
  for (const [hostPort, web] of Object.entries(status?.Web ?? {})) {
    const proxy = web?.Handlers?.["/"]?.Proxy;
    if (!proxy) continue;
    const m = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::(\d+))/.exec(proxy);
    if (!m) continue;
    const localPort = Number(m[1]);
    if (!Number.isFinite(localPort)) continue;
    if (!map.has(localPort)) map.set(localPort, `https://${hostPort}`);
  }
  return map;
}

async function tailnetServeMap() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.map;
  let map = new Map();
  for (const bin of TAILSCALE_CANDIDATES) {
    try {
      const out = await run(bin, ["serve", "status", "--json"]);
      if (out && out.includes("{")) {
        map = serveMapFromStatus(JSON.parse(out.slice(out.indexOf("{"))));
        break;
      }
    } catch {
      // try the next candidate binary
    }
  }
  cache = { at: now, map };
  return map;
}

/**
 * The base URL to put in a notification action: this Fitting's own address, in
 * the form a remote device can actually reach.
 *
 * `reachable:false` means the only address we have is loopback — the buttons
 * will work from the machine itself and nowhere else. The caller records that
 * rather than pretending delivery succeeded.
 */
export async function resolveAnswerBase(localUrl, { serveMap } = {}) {
  if (!localUrl) return { base: null, reachable: false, reason: "improver has no status URL" };
  let port = null;
  try {
    port = Number(new URL(localUrl).port);
  } catch {
    return { base: localUrl, reachable: false, reason: "unparseable status URL" };
  }
  const map = serveMap ?? (await tailnetServeMap());
  const tailnet = map.get(port) ?? null;
  if (tailnet) return { base: tailnet.replace(/\/+$/, ""), reachable: true };
  return {
    base: localUrl.replace(/\/+$/, ""),
    reachable: false,
    reason: `port ${port} is not published by 'tailscale serve' — the answer buttons only work from this machine`,
  };
}

// ── The notification ─────────────────────────────────────────────────────────

/** The answer URL for one option of one pending question. GET, because a
 *  notification action button can only navigate — see the route's own comment. */
export function answerUrl(base, pendingId, questionIndex, option) {
  const q = `question=${encodeURIComponent(String(questionIndex))}`;
  const a = `answer=${encodeURIComponent(String(option))}`;
  return `${base}/api/probe/${encodeURIComponent(pendingId)}/answer?${q}&${a}`;
}

/** The notification body: the question, verbatim, plus its options as text.
 *  Transports that cannot render buttons still show every option this way. */
export function probeNotificationText(pending) {
  const questions = Array.isArray(pending?.questions) ? pending.questions : [];
  const lines = [];
  questions.forEach((q, i) => {
    lines.push(questions.length > 1 ? `${i + 1}. ${q.question}` : String(q.question));
    if (Array.isArray(q.options) && q.options.length) lines.push(`   ${q.options.join(" · ")}`);
  });
  return lines.join("\n");
}

/**
 * Push one pending probe to every running Fitting that accepts /notify.
 *
 * Fire-and-forget in spirit — a channel being down must never cost the operator
 * a Stop — but awaited here so the caller can record WHICH surfaces took it, and
 * therefore how long the question is allowed to live before it is swept.
 * Returns { channels, answerBase, reachable, results }.
 */
export async function deliverProbeQuestion(
  pending,
  { selfUrl = statusFileUrl("improver"), fetchImpl = fetch, timeoutMs = 8000, serveMap, skipFittingIds = ["improver"] } = {}
) {
  const questions = Array.isArray(pending?.questions) ? pending.questions : [];
  if (!pending?.id || !questions.length) return { channels: [], answerBase: null, reachable: false, results: [] };
  const { base, reachable, reason } = await resolveAnswerBase(selfUrl, { serveMap });
  const text = probeNotificationText(pending);
  // The web push transport caps actions at two (a browser limit), so the option
  // list rides in the text as well and the buttons carry the first two.
  const first = questions[0];
  const actions = base
    ? (Array.isArray(first.options) ? first.options : []).map((option) => ({
        label: option,
        url: answerUrl(base, pending.id, 0, option),
      }))
    : [];
  const skip = new Set(skipFittingIds.filter(Boolean));
  const results = [];
  await Promise.all(
    runningFittingBases()
      .filter((e) => !skip.has(e.id))
      .map(async ({ id, base: fittingBase }) => {
        try {
          const res = await fetchImpl(`${fittingBase}/notify`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              title: "Garrison — one question",
              text,
              actions,
              link: base ? `${base}/` : null,
              tag: `probe-${pending.id}`,
              idempotencyKey: `probe-${pending.id}`,
            }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          // 404 = not a notify-capable channel, which is most Fittings.
          if (res.status !== 404) results.push({ id, status: res.status, ok: res.ok });
        } catch {
          // A Fitting that is starting or wedged must never block the others.
        }
      })
  );
  return {
    channels: results.filter((r) => r.ok).map((r) => r.id),
    answerBase: base,
    reachable,
    ...(reason ? { reason } : {}),
    results,
  };
}
