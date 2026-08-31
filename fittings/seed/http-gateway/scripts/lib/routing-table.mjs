// routing-table.mjs — provider-two step 4: per-duty ordered routes.
//
// The table is `<compositionDir>/.garrison/routing-table.json`:
//
//   {
//     "cooling_minutes": 30,
//     "duties": {
//       "implement": [
//         { "id": "codex-sub", "runtime": "codex", "provider": "openai",
//           "account": "chatgpt", "model": "gpt-5.6-sol", "effort": "medium" },
//         { "id": "anthropic-sub", "runtime": "agent-sdk", "provider": "anthropic",
//           "account": "max", "model": "claude-sonnet-5", "effort": "medium" },
//         { "id": "anthropic-api", "runtime": "agent-sdk", "provider": "anthropic",
//           "account": "api", "model": "claude-sonnet-5", "effort": "medium", "paid": true }
//       ]
//     }
//   }
//
// The FIRST entry is the duty's default and the router stays there. It moves
// down only on: an account cooling after a rate/usage limit, a capability the
// duty requires that the row lacks (`capabilities` on the row), or an explicit
// `route: <id>` line in the brief. Each provider keeps a paid API route at the
// bottom (`paid: true` is documentation, not mechanism - the walk is plain
// order), so a revoked subscription degrades to spend rather than to a stop.
// No learning, no scoring, no UI. No table file, no behaviour change.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function routingTableEnabled(env = process.env) {
  const raw = String(env?.GARRISON_HTTPGATEWAY_ROUTING_TABLE ?? "").trim().toLowerCase();
  if (raw === "false" || raw === "0" || raw === "off" || raw === "no") return false;
  return true;
}

export const DEFAULT_COOLING_MINUTES = 30;

export function readRoutingTable(compositionDir) {
  if (!compositionDir) return null;
  const file = path.join(compositionDir, ".garrison", "routing-table.json");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const doc = JSON.parse(raw);
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
    const duties = doc.duties && typeof doc.duties === "object" && !Array.isArray(doc.duties) ? doc.duties : {};
    const minutes = Number(doc.cooling_minutes);
    return {
      coolingMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_COOLING_MINUTES,
      duties,
    };
  } catch {
    // A malformed table must not park every conversation; it is ignored and
    // the ignore is loud in the gateway log (the caller logs it).
    return { error: `unparseable routing table at ${file}` };
  }
}

// ── cooling ─────────────────────────────────────────────────────────────────
// One flat file under GARRISON_HOME so a gateway restart forgets nothing.
// Key: provider/account. Value: ISO until.

function coolingFile(env = process.env) {
  const home = env?.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
  return path.join(home, "routing-cooling.json");
}

export function coolingKey(row) {
  return `${row?.provider ?? "?"}/${row?.account ?? "?"}`;
}

function readCoolingDoc(env) {
  try {
    const doc = JSON.parse(fs.readFileSync(coolingFile(env), "utf8"));
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
  } catch {
    return {};
  }
}

export function markCooling(row, minutes, { env = process.env, now = Date.now() } = {}) {
  const doc = readCoolingDoc(env);
  const until = new Date(now + minutes * 60_000).toISOString();
  doc[coolingKey(row)] = until;
  const file = coolingFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n", "utf8");
  return until;
}

export function coolingUntil(row, { env = process.env, now = Date.now() } = {}) {
  const doc = readCoolingDoc(env);
  const until = doc[coolingKey(row)];
  if (typeof until !== "string") return null;
  const t = Date.parse(until);
  if (!Number.isFinite(t) || t <= now) return null;
  return until;
}

// ── limit detection ─────────────────────────────────────────────────────────
// The shapes runtimes actually emit: codex exec's "You've hit your usage
// limit", Anthropic's rate_limit_error / overloaded_error, plain HTTP 429,
// and quota phrasing. A generic crash must NOT cool an account - cooling an
// account over a syntax error routes every later stretch to the paid lane.
const LIMIT_SHAPES = /rate.?limit|usage.?limit|quota (?:exhausted|exceeded)|hit your usage|limit reached|overloaded_error|\b429\b/i;

export function limitShaped(error) {
  return LIMIT_SHAPES.test(String(error ?? ""));
}

// ── the brief's explicit route ──────────────────────────────────────────────
// `route: <row-id>` anywhere in the card text or a user message.

const ROUTE_DIRECTIVE = /(?:^|\n)\s*route\s*[:=]\s*([A-Za-z0-9._/-]+)/i;

export function briefRouteFor(briefText) {
  const m = ROUTE_DIRECTIVE.exec(String(briefText ?? ""));
  return m ? m[1].trim() : null;
}

// ── model family (step 5's cross-family review lever) ───────────────────────

export function modelFamily(model) {
  const m = String(model ?? "").trim().toLowerCase();
  if (!m) return null;
  if (m.startsWith("claude")) return "claude";
  if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4")) return "gpt";
  if (m.startsWith("gemini")) return "gemini";
  return m.split(/[-._]/)[0] || null;
}

// ── the pick ────────────────────────────────────────────────────────────────

/**
 * Walk the duty's ordered rows and return {row, index, reason, skipped}.
 * reason: "default" (first eligible row is row 0), "brief-route",
 * "cooling"/"capability" (first rows skipped, reason names what moved us),
 * "cross-family" (review preference, step 5). Null when no row is eligible -
 * the caller keeps the rung route and logs that the table was exhausted.
 */
export function pickRoute({
  rows,
  briefText = null,
  requiredCapabilities = [],
  avoidFamily = null,
  env = process.env,
  now = Date.now(),
}) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const skipped = [];
  const explicit = briefRouteFor(briefText);
  if (explicit) {
    const idx = rows.findIndex((r) => String(r?.id ?? "") === explicit);
    if (idx >= 0) return { row: rows[idx], index: idx, reason: "brief-route", skipped };
    skipped.push({ index: -1, id: explicit, reason: "brief-route-unknown" });
  }
  const eligible = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const until = coolingUntil(row, { env, now });
    if (until) {
      skipped.push({ index: i, id: row?.id ?? null, reason: `cooling until ${until}` });
      continue;
    }
    const caps = Array.isArray(row?.capabilities) ? row.capabilities : null;
    const missing = requiredCapabilities.find((c) => caps !== null && !caps.includes(c));
    if (missing) {
      skipped.push({ index: i, id: row?.id ?? null, reason: `capability:${missing}` });
      continue;
    }
    eligible.push({ row, index: i });
  }
  if (!eligible.length) return null;
  // Step 5: review prefers a different model family from the one implement
  // used, whenever the table HAS one - different families have different
  // blind spots. When no cross-family row is eligible, stay put.
  if (avoidFamily) {
    const cross = eligible.find((e) => modelFamily(e.row?.model) && modelFamily(e.row.model) !== avoidFamily);
    if (cross && modelFamily(eligible[0].row?.model) === avoidFamily) {
      return { row: cross.row, index: cross.index, reason: "cross-family", skipped };
    }
  }
  const first = eligible[0];
  return {
    row: first.row,
    index: first.index,
    reason: first.index === 0 ? "default" : skipped.find((s) => s.index < first.index)?.reason ?? "advanced",
    skipped,
  };
}

/** Fold a picked row onto the rung-resolved route. Only the fields the row
 *  names move; everything else (skill, type, tool profile) stays the rung's. */
export function applyRouteRow(route, row) {
  if (!route?.target || !row) return route;
  return {
    ...route,
    targetId: row.id ?? route.targetId,
    target: {
      ...route.target,
      ...(row.runtime ? { runtime: row.runtime } : {}),
      ...(row.provider ? { provider: row.provider } : {}),
      ...(row.account ? { account: row.account } : {}),
      ...(row.model ? { model: row.model } : {}),
      ...(row.effort ? { effort: row.effort } : {}),
    },
  };
}
