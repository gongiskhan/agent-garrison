// gates.mjs — the apply gates for a skill body edit (v1). A candidate SKILL.md
// passes only when ALL hold:
//   (a) frontmatter parses and carries name + description;
//   (b) byte size is within the limit;
//   (c) frontmatter is BYTE-IDENTICAL to the original — v1 skill edits are
//       body-append-only, never frontmatter rewrites;
//   (d) loads-smoke: non-empty content that parsed.
// Pure: takes content + options, returns { ok, failures[] }. js-yaml is already
// a workspace dep.

import yaml from "js-yaml";

// Split a SKILL.md into its raw frontmatter block (the `---\n...\n---`) and body.
// Returns { frontmatter:null, body } when there is no leading frontmatter.
export function splitFrontmatter(content) {
  const text = String(content ?? "");
  const m = text.match(/^(---\n[\s\S]*?\n---)(?:\n([\s\S]*))?$/);
  if (!m) return { frontmatter: null, body: text };
  return { frontmatter: m[1], body: m[2] ?? "" };
}

// Parse the frontmatter block into an object (or null if absent/invalid).
export function parseFrontmatter(content) {
  const { frontmatter } = splitFrontmatter(content);
  if (!frontmatter) return null;
  const inner = frontmatter.replace(/^---\n/, "").replace(/\n---$/, "");
  try {
    const doc = yaml.load(inner);
    return doc && typeof doc === "object" ? doc : null;
  } catch {
    return null;
  }
}

export function runGates(content, { sizeLimit = 64 * 1024, originalFrontmatter = null } = {}) {
  const failures = [];
  const text = String(content ?? "");

  // (d) loads-smoke — content present at all
  if (!text.trim()) failures.push("empty-content");

  // (a) frontmatter valid + required keys
  const fm = parseFrontmatter(text);
  if (!fm) {
    failures.push("frontmatter-invalid");
  } else {
    if (!fm.name) failures.push("frontmatter-missing-name");
    if (!fm.description) failures.push("frontmatter-missing-description");
  }

  // (b) size under limit
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > sizeLimit) failures.push(`size-over-limit:${bytes}>${sizeLimit}`);

  // (c) frontmatter byte-identical (body-append-only)
  if (originalFrontmatter != null) {
    const cur = splitFrontmatter(text).frontmatter;
    if (cur !== originalFrontmatter) failures.push("frontmatter-changed");
  }

  return { ok: failures.length === 0, failures };
}
