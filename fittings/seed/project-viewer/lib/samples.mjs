// Sample materialisation: turns the coordinates a model proposed into a sample
// object with real extracted bytes and a hash over them.
//
// This is the only sanctioned way a sample enters a manifest. The analysis skill
// hands over {file, startLine, endLine, highlights} and prose; it never hands
// over code. If it tries to, there is nowhere for that text to go.

import {
  hashText,
  inferLang,
  normaliseHighlights,
  sliceSpan,
  splitLines,
  verifyDiffSample,
  verifySpanSample,
} from "./extract.mjs";
import { commitPatch, diffWorkingTree, gitShow, headSha, readWorkingTree, toRepoPath } from "./git.mjs";

/**
 * Build a span sample by reading the blob at `sha` and slicing it.
 * Throws when the file or the range is not there — a sample that cannot be
 * extracted must never be written to a manifest.
 */
export async function spanSample(root, { sha, file, startLine, endLine, highlights, lang }) {
  const repoPath = toRepoPath(file);
  const text = await gitShow(root, sha, repoPath);
  if (text === null) {
    throw new Error(`spanSample: ${repoPath} does not exist at ${short(sha)}`);
  }
  const sliced = sliceSpan(text, startLine, endLine);
  return {
    file: repoPath,
    startLine,
    endLine,
    lang: lang ?? inferLang(repoPath),
    highlights: normaliseHighlights(highlights, startLine, endLine),
    extractedSha256: hashText(sliced),
    sha,
  };
}

/**
 * A dirty-preview sample, extracted from the working tree instead of a commit.
 * Only the uncommitted-changes view may use this. It hashes the same read path
 * it rendered from, so render-time verification still works; the flow carrying
 * it is marked `anchoredAt.dirty` and excluded from refresh.
 */
export async function workingTreeSample(root, { file, startLine, endLine, highlights, lang }) {
  const repoPath = toRepoPath(file);
  const text = await readWorkingTree(root, repoPath);
  if (text === null) throw new Error(`workingTreeSample: ${repoPath} not readable`);
  const lines = splitLines(text);
  const end = Math.min(endLine ?? lines.length, lines.length);
  const start = Math.max(1, startLine ?? 1);
  const sliced = sliceSpan(text, start, end);
  return {
    file: repoPath,
    startLine: start,
    endLine: end,
    lang: lang ?? inferLang(repoPath),
    highlights: normaliseHighlights(highlights, start, end),
    extractedSha256: hashText(sliced),
  };
}

/**
 * Split a unified patch into per-file, per-hunk pieces. A commit walkthrough's
 * spine is exactly this list: one step per hunk, in the order git emits them.
 */
export function splitHunks(patchText) {
  const out = [];
  const text = String(patchText ?? "");
  if (!text.trim()) return out;

  const fileChunks = text.split(/^diff --git /m).filter((c) => c.trim());
  for (const chunk of fileChunks) {
    const body = chunk.startsWith("a/") || chunk.startsWith('"a/') ? chunk : chunk;
    const header = body.slice(0, body.search(/^@@/m) === -1 ? body.length : body.search(/^@@/m));
    const file = fileFromHeader(header);
    const status = statusFromHeader(header);
    const hunkText = body.slice(header.length);
    if (!hunkText.trim()) {
      // A pure rename or mode change has no hunks; keep it as a zero-hunk entry
      // so the walkthrough can still mention the file rather than dropping it.
      out.push({ file, status, hunkHeader: null, patch: header.trimEnd(), hunkIndex: 0 });
      continue;
    }
    const pieces = hunkText.split(/^(?=@@ )/m).filter((p) => p.trim());
    pieces.forEach((piece, i) => {
      const firstLine = piece.split("\n", 1)[0];
      out.push({
        file,
        status,
        hunkHeader: firstLine.trim(),
        patch: piece.replace(/\s+$/, ""),
        hunkIndex: i,
      });
    });
  }
  return out;
}

function fileFromHeader(header) {
  const plus = /^\+\+\+ b\/(.+)$/m.exec(header);
  if (plus) return toRepoPath(plus[1].trim());
  const minus = /^--- a\/(.+)$/m.exec(header);
  if (minus) return toRepoPath(minus[1].trim());
  const git = /^"?a\/(.+?)"? "?b\/(.+?)"?$/m.exec(header.split("\n", 1)[0] ?? "");
  if (git) return toRepoPath(git[2].trim());
  return "unknown";
}

function statusFromHeader(header) {
  if (/^new file mode/m.test(header)) return "added";
  if (/^deleted file mode/m.test(header)) return "deleted";
  if (/^rename from/m.test(header)) return "renamed";
  return "modified";
}

/**
 * Materialise every hunk of a commit as a diff sample. Mechanical end to end:
 * the model only picks which hunks matter and writes the narration.
 */
export async function commitDiffSamples(root, sha, relPath) {
  const patch = await commitPatch(root, sha, relPath);
  return splitHunks(patch).map((h) => ({
    file: h.file,
    sha,
    hunkHeader: h.hunkHeader,
    patch: h.patch,
    lang: inferLang(h.file),
    status: h.status,
    extractedSha256: hashText(h.patch),
  }));
}

/**
 * Materialise every uncommitted hunk as a diff sample — the working-tree twin of
 * commitDiffSamples, for narrating changes BEFORE they become a commit.
 *
 * `sha` on each sample is the BASE the diff was taken against (HEAD), because that
 * is the only commit in the story; the other side is the working tree, which has
 * no name. The flow carrying these must be anchored `dirty` — it describes a
 * moment, goes stale the instant the tree moves, and is excluded from refresh
 * rather than re-narrated.
 */
export async function workingTreeDiffSamples(root) {
  const [patch, baseSha] = await Promise.all([diffWorkingTree(root), headSha(root)]);
  return splitHunks(patch).map((h) => ({
    file: h.file,
    sha: baseSha,
    hunkHeader: h.hunkHeader,
    patch: h.patch,
    lang: inferLang(h.file),
    status: h.status,
    extractedSha256: hashText(h.patch),
  }));
}

/**
 * Verify a step's sample against the repo as it is now. Returns a render
 * decision: `ok` renders code, anything else renders an integrity error block.
 * The renderer must never fall back to showing unverified text.
 */
export async function verifyStepSample(root, step, { sha } = {}) {
  if (step.diffSample) {
    const res = verifyDiffSample(step.diffSample);
    return { kind: "diff", ...res, text: step.diffSample.patch };
  }
  if (!step.sample) return { kind: "none", ok: true, text: null };
  const at = step.sample.sha ?? sha;
  if (!at) {
    return { kind: "span", ok: false, error: "no anchor sha", expected: null, actual: null, text: null };
  }
  const fileText = await gitShow(root, at, step.sample.file);
  return { kind: "span", ...verifySpanSample(fileText, step.sample) };
}

function short(sha) {
  return String(sha ?? "").slice(0, 8);
}
