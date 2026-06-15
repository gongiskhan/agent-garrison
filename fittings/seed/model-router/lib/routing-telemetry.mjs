// routing-telemetry.mjs — route telemetry (BRIEF v4 §2 "Route telemetry").
//
// The gateway is the SOURCE OF TRUTH for routing decisions (it made them), so it
// writes every Stage-A decision to decisions.jsonl AT RESOLUTION TIME — no
// transcript scraping (MR0e: jsonl-verdict=absent). The operative still ends
// each reply with a [route: …] token; because the gateway also captures the
// reply text, it diff-checks the token against the resolved route and logs
// honored:false on a mismatch — the misroute signal the Improver feeds on.
import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";

export function promptDigest(prompt) {
  return createHash("sha256").update(String(prompt)).digest("hex").slice(0, 16);
}

// Build the decision record written at resolution time. `at` (ISO string) is
// passed in so the record builder stays pure/testable.
export function decisionRecord({ prompt, classification, route, at }) {
  return {
    at: at ?? null,
    promptDigest: promptDigest(prompt ?? ""),
    taskType: classification?.taskType ?? null,
    tier: classification?.tier ?? null,
    matchedException: classification?.matchedException ?? null,
    role: route?.role ?? null,
    ruleId: route?.ruleId ?? null,
    targetId: route?.targetId ?? null,
    profile: route?.profile ?? null,
    via: route?.via ?? null
  };
}

// The reply token the operative must emit (matches the compiled routing.md duty).
export function formatRouteToken(route) {
  return `[route: ${route?.targetId ?? "?"} | rule: ${route?.ruleId ?? "?"} | profile: ${route?.profile ?? "?"}]`;
}

const ROUTE_TOKEN_RE = /\[route:\s*([^|\]]+?)\s*\|\s*rule:\s*([^|\]]+?)\s*\|\s*profile:\s*([^|\]]+?)\s*\]/i;

// Parse the LAST [route: …] token in a reply (the operative ends with it).
export function parseRouteToken(replyText) {
  if (typeof replyText !== "string") return null;
  let match = null;
  const re = new RegExp(ROUTE_TOKEN_RE, "gi");
  for (const m of replyText.matchAll(re)) match = m;
  if (!match) return null;
  return { targetId: match[1].trim(), ruleId: match[2].trim(), profile: match[3].trim() };
}

// Diff the operative's token against the route the gateway resolved.
export function checkHonored(route, replyText) {
  const parsed = parseRouteToken(replyText);
  const expected = { targetId: route?.targetId ?? null, profile: route?.profile ?? null };
  if (!parsed) return { honored: false, reason: "no route token in reply", expected, actual: null };
  const honored = parsed.targetId === expected.targetId && parsed.profile === expected.profile;
  return { honored, expected, actual: parsed, reason: honored ? "match" : "token target/profile mismatch" };
}

// Append a decision record as one JSON line. honored is patched in after the
// reply is captured (the gateway appends at resolution, then updates — here we
// write a single complete line for simplicity; callers may append a follow-up
// honored record keyed by promptDigest).
export async function appendDecision(filePath, record) {
  await appendFile(filePath, JSON.stringify(record) + "\n", "utf8");
}

export async function readDecisions(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
