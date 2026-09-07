// Mechanical sample extraction — the trust chain of the whole viewer.
//
// The model is allowed to choose coordinates (file, line range, which lines to
// highlight) and to write prose. It is never allowed to supply code text. This
// module is what makes that enforceable instead of aspirational: every sample
// carries the sha256 of the exact bytes that were extracted, and the renderer
// recomputes that hash from the repo before it will render the code pane.
//
// LINE-ENDING NORMALISATION IS LOAD-BEARING. All hashing happens over text that
// was split on /\r?\n/ and re-joined with "\n". The source of that text is
// `git show <sha>:<path>` (blob bytes), never a working-tree read — so a
// checkout with core.autocrlf=true (as on the Windows box this repo is edited
// from) cannot change a hash and silently invalidate every sample in the repo.
// The one exception is an explicitly dirty preview, which hashes its own read
// path and is excluded from refresh.
//
// Pure except for node:crypto (deterministic). No filesystem, no child process:
// that lives in git.mjs, which keeps this module unit-testable in isolation.

import { createHash } from "node:crypto";

/** Split into lines, normalising CRLF and lone CR away. */
export function splitLines(text) {
  if (typeof text !== "string") throw new TypeError("splitLines: expected a string");
  return text.split(/\r\n|\r|\n/);
}

/** sha256 of the exact text, lowercase hex. The schema pins ^[0-9a-f]{64}$. */
export function hashText(text) {
  if (typeof text !== "string") throw new TypeError("hashText: expected a string");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Cut lines [startLine, endLine] (1-indexed, inclusive) out of `text`.
 * Throws rather than clamping when the range is not fully present: a sample that
 * silently shrank is exactly the kind of quiet wrongness this tool must not have.
 */
export function sliceSpan(text, startLine, endLine) {
  assertRange(startLine, endLine);
  const lines = splitLines(text);
  if (startLine > lines.length) {
    throw new RangeError(
      `sliceSpan: startLine ${startLine} is past end of file (${lines.length} lines)`
    );
  }
  if (endLine > lines.length) {
    throw new RangeError(
      `sliceSpan: endLine ${endLine} is past end of file (${lines.length} lines)`
    );
  }
  return lines.slice(startLine - 1, endLine).join("\n");
}

function assertRange(startLine, endLine) {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
    throw new TypeError("sliceSpan: startLine and endLine must be integers");
  }
  if (startLine < 1) throw new RangeError("sliceSpan: startLine is 1-indexed");
  if (endLine < startLine) {
    throw new RangeError(`sliceSpan: endLine ${endLine} is before startLine ${startLine}`);
  }
}

/**
 * Recompute a span sample's hash from the full file text as it exists now.
 * Returns { ok, expected, actual, text, error } and never throws for the
 * ordinary failure modes — the renderer wants to show an integrity error block,
 * not crash the page.
 */
export function verifySpanSample(fileText, sample) {
  if (!sample || typeof sample !== "object") {
    return { ok: false, error: "no sample", expected: null, actual: null, text: null };
  }
  const expected = sample.extractedSha256 ?? null;
  if (fileText === null || fileText === undefined) {
    return { ok: false, error: "file not found at anchor", expected, actual: null, text: null };
  }
  let text;
  try {
    text = sliceSpan(fileText, sample.startLine, sample.endLine);
  } catch (err) {
    return { ok: false, error: err.message, expected, actual: null, text: null };
  }
  const actual = hashText(text);
  return { ok: expected === actual, expected, actual, text, error: null };
}

/**
 * Diff samples store their patch text verbatim, because a patch is anchored to
 * two immutable SHAs — storing it is not "the model retyping code", it is
 * git's own output captured by samples.mjs. The hash still covers the stored
 * text so that tampering with a manifest is detectable.
 */
export function verifyDiffSample(sample) {
  if (!sample || typeof sample !== "object") {
    return { ok: false, error: "no sample", expected: null, actual: null };
  }
  const expected = sample.extractedSha256 ?? null;
  if (typeof sample.patch !== "string") {
    return { ok: false, error: "diff sample has no patch text", expected, actual: null };
  }
  const actual = hashText(sample.patch);
  return { ok: expected === actual, expected, actual, error: null };
}

/** Extension → highlighter language id. Kept here so extraction and rendering agree. */
export function inferLang(file) {
  const m = /\.([a-z0-9]+)$/i.exec(String(file ?? ""));
  if (!m) return "txt";
  const ext = m[1].toLowerCase();
  const map = {
    ts: "ts", tsx: "tsx", mts: "ts", cts: "ts",
    js: "js", jsx: "tsx", mjs: "js", cjs: "js",
    json: "json", jsonc: "json",
    yml: "yaml", yaml: "yaml",
    sh: "sh", bash: "sh", zsh: "sh",
    md: "md", markdown: "md",
    css: "css", html: "html",
    py: "py", sql: "sql", toml: "toml",
  };
  return map[ext] ?? "txt";
}

/**
 * Normalise highlight ranges: clamp into the sample window, drop empties, sort,
 * and merge overlaps. Highlights are stored in ABSOLUTE file coordinates (not
 * offsets into the slice) so that widening a window or rebasing a span moves
 * span and highlights with one delta.
 */
export function normaliseHighlights(highlights, startLine, endLine) {
  if (!Array.isArray(highlights)) return [];
  const ranges = [];
  for (const pair of highlights) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    let [a, b] = pair;
    if (!Number.isInteger(a) || !Number.isInteger(b)) continue;
    if (b < a) [a, b] = [b, a];
    const s = Math.max(a, startLine);
    const e = Math.min(b, endLine);
    if (s > e) continue;
    ranges.push([s, e]);
  }
  ranges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/** True when `line` falls inside any normalised highlight range. */
export function isHighlighted(line, highlights) {
  if (!Array.isArray(highlights)) return false;
  for (const pair of highlights) {
    if (Array.isArray(pair) && line >= pair[0] && line <= pair[1]) return true;
  }
  return false;
}
