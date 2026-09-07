// Survey the project's prose before proposing to consolidate any of it.
//
// Two files, two jobs, and confusing them would be bad:
//
//   viewer/docs-survey.json    what exists, mechanically measured. This module.
//   viewer/docs-manifest.json  the consolidated result, written by a narrator, and
//                              the only one the viewer renders.
//
// This module NEVER proposes a deletion. It measures, groups, and flags — including
// flagging which documents now overlap code the viewer explains, which is the signal
// consolidation actually needs. What happens next is asked, per the cleanup rules.
//
// THE TRAP THIS EXISTS TO AVOID. A repo like Garrison has 368 markdown files and 162
// of them are `SKILL.md` and `README.md` files INSIDE fittings — executable payload
// that an agent loads at runtime, not documentation about the project. A survey that
// globbed `**/*.md` would put a fitting's instructions on a consolidation list, and
// consolidating those would break the fittings. So payload is excluded structurally,
// by path, and the exclusion is tested.
//
// Pure: takes paths and text, returns data.

/** Paths whose markdown is executable payload or third-party, never project prose. */
const PAYLOAD_PATTERNS = [
  /(?:^|\/)\.apm\/skills\//,
  /(?:^|\/)\.claude\/skills\//,
  /(?:^|\/)\.codex\/skills\//,
  /(?:^|\/)fittings\//,
  /(?:^|\/)apm_modules\//,
  /(?:^|\/)node_modules\//,
  /(?:^|\/)site\//,
  /(?:^|\/)packages\/[^/]+\/(?:CHANGELOG|LICENSE)\.md$/i,
];

/**
 * Files that get SLIMMED, never removed and never folded into something else.
 * A repo's entry documents are load-bearing for humans and for agents that read
 * `CLAUDE.md` or `AGENTS.md` on startup; losing one to a consolidation would be a
 * self-inflicted wound.
 */
const PROTECTED = new Set(["README.md", "CLAUDE.md", "AGENTS.md", "CONTRIBUTING.md", "LICENSE.md"]);

export function isProjectDoc(file) {
  const p = String(file ?? "");
  if (!/\.mdx?$/i.test(p)) return false;
  return !PAYLOAD_PATTERNS.some((re) => re.test(`/${p}`));
}

export function isProtectedDoc(file) {
  return PROTECTED.has(String(file ?? "").split("/").pop() ?? "") && !String(file).includes("/");
}

/** Headings with their line numbers — the skeleton a consolidator works from. */
export function headingsOf(text) {
  const out = [];
  let inFence = false;
  String(text ?? "")
    .split(/\r\n|\r|\n/)
    .forEach((line, i) => {
      // A `#` inside a fenced block is a shell comment, not a heading. Getting this
      // wrong makes every script-heavy document look like it has forty sections.
      if (/^\s*(?:```|~~~)/.test(line)) {
        inFence = !inFence;
        return;
      }
      if (inFence) return;
      const m = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
      if (m) out.push({ level: m[1].length, text: m[2], line: i + 1 });
    });
  return out;
}

/** The first real sentence, for a survey line a human can skim. */
export function docSummary(text, max = 200) {
  let inFence = false;
  for (const line of String(text ?? "").split(/\r\n|\r|\n/)) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^[#>|:\-*+]/.test(trimmed)) continue;
    if (/^\[.*\]:/.test(trimmed)) continue;
    return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
  }
  return "";
}

/**
 * Self-declared staleness. A document that says it is historical is the cheapest
 * consolidation candidate there is, and it said so itself rather than being judged.
 */
export function selfDeclaredMarkers(text) {
  const t = String(text ?? "");
  const found = [];
  const check = (re, label) => {
    if (re.test(t)) found.push(label);
  };
  check(/\b(?:historical|superseded|obsolete|no longer (?:used|accurate)|non-load-bearing)\b/i, "says it is historical");
  check(/\bdeprecated\b/i, "mentions deprecation");
  check(/\bTODO\b|\bTBD\b|\bWIP\b/, "carries TODO/TBD/WIP");
  check(/\b(?:draft|proposal)\b/i, "reads as a draft or proposal");
  return found;
}

/**
 * Markdown documents a document links to, repo-relative where derivable.
 *
 * This is how the load-bearing set is found without a hardcoded list. `CLAUDE.md` says
 * "Adding or auditing a Fitting → docs/METADATA.md"; that link IS the statement that
 * METADATA.md is part of the documented reading path. Without this signal the survey
 * ranked exactly those documents first, because a file that describes deprecations
 * matches every "mentions deprecation" test while being the opposite of disposable.
 */
export function linkedDocsOf(text, fromFile = "") {
  const out = new Set();
  const dir = String(fromFile).includes("/") ? String(fromFile).replace(/\/[^/]*$/, "") : "";
  // The whole link is captured and normalised below. An earlier version stripped a
  // leading `./` in the pattern with `\.?\/?`, which ate the first dot of `../` and
  // turned a link UP the tree into a link down it.
  const re = /\]\(\s*([^)\s#]+\.mdx?)(?:#[^)]*)?\s*\)/g;
  let m;
  while ((m = re.exec(String(text ?? ""))) !== null) {
    const raw = m[1];
    if (/^(?:https?:)?\/\//.test(raw)) continue;
    // An absolute link is already repo-relative; anything else resolves against the
    // linking document's own directory, with `.` and `..` handled in the loop.
    const joined = raw.startsWith("/") ? raw.slice(1) : dir ? `${dir}/${raw}` : raw;
    const parts = [];
    for (const seg of joined.split("/")) {
      if (seg === "." || seg === "") continue;
      if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    out.add(parts.join("/"));
  }
  return [...out];
}

/** Repo-relative paths a document mentions, so overlap with the viewer is checkable. */
export function mentionedPaths(text) {
  const out = new Set();
  // Backticked or bare paths with a source extension. Deliberately narrow: a loose
  // pattern would match prose and inflate every overlap count.
  // Longest extension first, and a trailing guard. `ts|tsx` matched `page.tsx` as
  // `page.ts`, so every React file mentioned in a document was recorded under a path
  // that exists nowhere — silently zeroing the overlap signal this whole survey turns on.
  const re =
    /(?:^|[\s(`'"[])((?:src|packages|scripts|tests|lib|app)\/[\w./[\]@-]+\.(?:tsx|ts|jsx|js|mjs|cjs))(?![\w])/g;
  let m;
  while ((m = re.exec(String(text ?? ""))) !== null) out.add(m[1]);
  return [...out];
}

/**
 * Measure one document. `narratedFiles` is the set of files the viewer already shows
 * code from — the overlap is the actual argument for consolidating a document, so it
 * is computed rather than guessed at.
 */
export function surveyDoc({ file, text, narratedFiles = new Set(), entryLinks = new Set() }) {
  const lines = String(text ?? "").split(/\r\n|\r|\n/);
  const headings = headingsOf(text);
  const mentioned = mentionedPaths(text);
  const overlapping = mentioned.filter((p) => narratedFiles.has(p));

  return {
    file,
    title: headings.find((h) => h.level === 1)?.text ?? file.split("/").pop(),
    bytes: Buffer.byteLength(String(text ?? ""), "utf8"),
    lines: lines.length,
    headings: headings.slice(0, 40),
    headingCount: headings.length,
    summary: docSummary(text),
    protected: isProtectedDoc(file),
    // Linked from an entry document, so it is part of the reading path a human or an
    // agent is told to follow. Not untouchable, but not a candidate to lead a list.
    onReadingPath: entryLinks.has(file),
    markers: selfDeclaredMarkers(text),
    mentionsFiles: mentioned.length,
    // Named, not just counted: a reader deciding about this document wants to see
    // which flows would replace it.
    overlapsViewer: overlapping.slice(0, 12),
    overlapCount: overlapping.length,
  };
}

/** Group by directory, since that is how a repo's prose is actually organised. */
export function groupDocs(docs) {
  const byArea = new Map();
  for (const doc of docs) {
    const parts = doc.file.split("/");
    const area = parts.length === 1 ? "(repo root)" : parts.slice(0, 2).join("/");
    if (!byArea.has(area)) byArea.set(area, []);
    byArea.get(area).push(doc);
  }
  return [...byArea.entries()]
    .map(([area, list]) => ({
      area,
      count: list.length,
      bytes: list.reduce((n, d) => n + d.bytes, 0),
      protectedCount: list.filter((d) => d.protected).length,
      withMarkers: list.filter((d) => d.markers.length).length,
      overlapping: list.filter((d) => d.overlapCount > 0).length,
    }))
    .sort((a, b) => b.count - a.count || a.area.localeCompare(b.area));
}

/**
 * Assemble the survey. `candidates` ranks by how much a document argues for its own
 * consolidation — self-declared staleness first, then overlap with the viewer — and
 * `protected` files are listed separately as slim-only so nobody has to remember.
 */
export function buildSurvey({ docs, sha = null, generatedAt = null, flowCount = null }) {
  const ranked = docs
    .filter((d) => !d.protected)
    .map((d) => ({
      file: d.file,
      title: d.title,
      bytes: d.bytes,
      onReadingPath: d.onReadingPath === true,
      reasons: [
        ...d.markers,
        ...(d.overlapCount ? [`mentions ${d.overlapCount} file(s) the viewer already explains`] : []),
        ...(d.onReadingPath
          ? ["LINKED FROM AN ENTRY DOCUMENT — it is part of the reading path, so slim it rather than fold it away"]
          : []),
      ],
    }))
    .filter((d) => d.reasons.length)
    // Reading-path documents sort LAST regardless of how many markers they carry.
    // Ranking by marker count alone put `docs/METADATA.md` and `docs/CAPABILITIES.md`
    // at the top — the two documents CLAUDE.md tells you to read before touching a
    // fitting — because a document that describes deprecations matches every
    // deprecation test. A list that leads with what you must not touch is worse than
    // no list.
    .sort(
      (a, b) =>
        Number(a.onReadingPath) - Number(b.onReadingPath) ||
        b.reasons.length - a.reasons.length ||
        b.bytes - a.bytes
    );

  return {
    schemaVersion: 1,
    sha,
    generatedAt,
    stats: {
      docs: docs.length,
      bytes: docs.reduce((n, d) => n + d.bytes, 0),
      protected: docs.filter((d) => d.protected).length,
      onReadingPath: docs.filter((d) => d.onReadingPath).length,
      withOverlap: docs.filter((d) => d.overlapCount > 0).length,
    },
    // The overlap signal is the strongest argument for consolidating anything, and it
    // is dark until the viewer has flows. Said here so a zero is not read as "no
    // document duplicates the viewer" when the truth is "there is no viewer yet".
    blindSpots: [
      ...(flowCount === 0
        ? ["no flow manifests exist yet, so no document can be shown to overlap the viewer — that zero is not evidence"]
        : []),
    ],
    areas: groupDocs(docs),
    // Slim only. Never folded away, never deleted — an agent reads some of these on
    // startup, and a human reads the rest first.
    slimOnly: docs.filter((d) => d.protected).map((d) => ({ file: d.file, bytes: d.bytes, title: d.title })),
    candidates: ranked,
    docs,
    // Said in the artefact itself, so it survives being read out of context.
    note:
      "A survey, not a plan. Nothing here is a proposal to delete anything: consolidation " +
      "is narrated and asked for, and deletions only ever come from an approved allowlist. " +
      "Executable markdown inside fittings and skills directories is excluded by path.",
  };
}
