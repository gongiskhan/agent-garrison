// The composition file allow-list — the same split composition-transfer.ts
// already litigated (EXPORT_FILE_RULES + NEVER_TRANSFER), promoted to guard
// the state-service API: PUT /v1/compositions/<id>/files/<path> rejects any
// path the exporter could not have produced, so node-local files stay
// node-local because they are UNSTORABLE, not because a caller remembered.
//
// Kept in lockstep with src/lib/composition-transfer.ts by
// tests/state-transferable-path.test.ts. A new authored file type needs a rule
// in BOTH places (one edit each) or it will not travel.

const EXPORT_FILE_RULES = [
  { dir: "", pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/, label: "composition doc" },
  { dir: "", pattern: /^routing\.[A-Za-z0-9._-]+\.json$/, label: "alternate routing policy" },
  { dir: ".garrison", pattern: /^routing\.json$/, label: "routing policy" },
  { dir: ".garrison", pattern: /^orchestrator-authored\.json$/, label: "authored orchestrator blocks" },
  { dir: ".garrison/prompts", pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/, label: "authored prompt" }
];

const NEVER_TRANSFER = new Set([".env", "local.yml", "apm.lock.yaml", "apm.yml"]);
const LEGACY_IDENTITY_SOURCE_REL = ".garrison/prompts/soul.md";

export function compositionPathAllowed(relativePath) {
  if (!relativePath) return false;
  const normalized = String(relativePath).replace(/\\/g, "/");
  if (normalized === LEGACY_IDENTITY_SOURCE_REL) return false;
  if (normalized.startsWith("/") || normalized.includes("\0")) return false;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  const base = segments[segments.length - 1];
  if (NEVER_TRANSFER.has(base)) return false;
  const dir = segments.slice(0, -1).join("/");
  return EXPORT_FILE_RULES.some((rule) => rule.dir === dir && rule.pattern.test(base));
}
