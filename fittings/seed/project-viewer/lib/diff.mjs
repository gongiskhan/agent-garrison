// Unified-diff rendering, GitHub style, with no diff2html dependency.
//
// A commit walkthrough is a flow whose spine is the diff hunks, so this is the
// second of the viewer's two sample renderers. It shares the highlighter with
// the flow sample renderer so a commit page and a flow page look like the same
// product rather than two bolted-together tools.
//
// Pure. Parsing is separated from rendering so the parser can be tested against
// real `git diff` output without asserting on HTML.

import { escapeHtml, highlightLine } from "./highlight.mjs";
import { inferLang } from "./extract.mjs";

/**
 * Parse one hunk's text into rows carrying both old and new line numbers, which
 * is what lets the side gutters show real coordinates instead of an index.
 */
export function parseHunk(patch) {
  const lines = String(patch ?? "").split("\n");
  const header = lines[0] ?? "";
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(header);
  if (!m) {
    return { header: header || null, context: "", rows: [], oldStart: 0, newStart: 0 };
  }
  let oldNo = Number(m[1]);
  let newNo = Number(m[3]);
  const rows = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    const marker = line[0];
    const text = line.slice(1);
    if (marker === "+") {
      rows.push({ type: "add", oldNo: null, newNo, text });
      newNo += 1;
    } else if (marker === "-") {
      rows.push({ type: "del", oldNo, newNo: null, text });
      oldNo += 1;
    } else if (marker === " " || marker === undefined || line === "") {
      rows.push({ type: "ctx", oldNo, newNo, text });
      oldNo += 1;
      newNo += 1;
    }
  }
  return {
    header,
    context: (m[5] ?? "").trim(),
    rows,
    oldStart: Number(m[1]),
    newStart: Number(m[3]),
  };
}

/** Parse a whole multi-hunk patch for one file. */
export function parseFilePatch(patch) {
  const text = String(patch ?? "");
  const pieces = text.split(/^(?=@@ )/m).filter((p) => p.trim());
  return pieces.map(parseHunk).filter((h) => h.rows.length > 0 || h.header);
}

/** Render a single hunk as a two-gutter table. */
export function renderHunk(patch, { lang = "ts", file = "" } = {}) {
  const hunk = parseHunk(patch);
  const rows = hunk.rows
    .map((r) => {
      const cls = r.type === "add" ? "d-add" : r.type === "del" ? "d-del" : "d-ctx";
      const sign = r.type === "add" ? "+" : r.type === "del" ? "-" : " ";
      const dataLine = r.newNo ?? r.oldNo ?? "";
      return (
        `<tr class="diff-line ${cls}" data-line="${dataLine}">` +
        `<td class="ln" aria-hidden="true">${r.oldNo ?? ""}</td>` +
        `<td class="ln" aria-hidden="true">${r.newNo ?? ""}</td>` +
        `<td class="sign" aria-hidden="true">${sign}</td>` +
        `<td class="lc"><code>${highlightLine(r.text, lang) || "&nbsp;"}</code></td>` +
        `</tr>`
      );
    })
    .join("");

  const caption = hunk.header
    ? `<caption class="hunk-header">${escapeHtml(hunk.header.split("@@")[1] ? `@@${hunk.header.split("@@")[1]}@@` : hunk.header)}` +
      (hunk.context ? ` <span class="hunk-ctx">${escapeHtml(hunk.context)}</span>` : "") +
      `</caption>`
    : "";

  return (
    `<table class="code diff" data-file="${escapeHtml(file)}" data-lang="${escapeHtml(lang)}">` +
    `${caption}<tbody>${rows}</tbody></table>`
  );
}

/**
 * Render every hunk of a file patch, with a file header.
 *
 * `emptyLabel` is passed in rather than hardcoded so this module stays free of
 * UI copy — the caller knows the reader's language, this one only knows diffs.
 */
export function renderFilePatch(patch, { file = "", status = "modified", emptyLabel = "No textual changes." } = {}) {
  const lang = inferLang(file);
  const hunks = parseFilePatch(patch);
  const body = hunks.map((h) => renderHunk(rebuildHunkText(h), { lang, file })).join("");
  const stats = diffStats(patch);
  return (
    `<section class="diff-file" data-file="${escapeHtml(file)}">` +
    `<header class="diff-file-head">` +
    `<span class="diff-status s-${escapeHtml(status)}">${escapeHtml(status)}</span>` +
    `<code class="diff-path">${escapeHtml(file)}</code>` +
    `<span class="diff-stats"><span class="plus">+${stats.added}</span> <span class="minus">-${stats.removed}</span></span>` +
    `</header>${body || `<p class="empty">${escapeHtml(emptyLabel)}</p>`}</section>`
  );
}

function rebuildHunkText(hunk) {
  const head = hunk.header ?? "@@ -0,0 +0,0 @@";
  const body = hunk.rows
    .map((r) => (r.type === "add" ? "+" : r.type === "del" ? "-" : " ") + r.text)
    .join("\n");
  return `${head}\n${body}`;
}

/** Added/removed line counts for a patch. */
export function diffStats(patch) {
  let added = 0;
  let removed = 0;
  for (const line of String(patch ?? "").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

/**
 * Split a full multi-file `git diff` into per-file patches. Used by the
 * uncommitted-changes view, which gets one blob of diff for the whole tree.
 */
export function splitByFile(diffText) {
  const text = String(diffText ?? "");
  if (!text.trim()) return [];
  return text
    .split(/^diff --git /m)
    .filter((c) => c.trim())
    .map((chunk) => {
      const plus = /^\+\+\+ b\/(.+)$/m.exec(chunk);
      const minus = /^--- a\/(.+)$/m.exec(chunk);
      const file = (plus?.[1] ?? minus?.[1] ?? "unknown").trim();
      let status = "modified";
      if (/^new file mode/m.test(chunk)) status = "added";
      else if (/^deleted file mode/m.test(chunk)) status = "deleted";
      else if (/^rename from/m.test(chunk)) status = "renamed";
      const at = chunk.search(/^@@ /m);
      return { file, status, patch: at === -1 ? "" : chunk.slice(at) };
    });
}
