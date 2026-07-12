// index-store.mjs — the Answer-mode grounding index. Builds a section-level
// keyword index over docs/*.md plus every installed Fitting's SKILL.md /
// instructions / apm.yml summary, and answers a question by retrieving the
// best-matching sections WITH their source paths. No embeddings, no network —
// deterministic keyword+section retrieval so Answer is cheap, offline, and
// re-indexable on composition change.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const STOP = new Set([
  "the","a","an","of","to","in","is","it","and","or","for","on","with","as",
  "how","do","i","what","does","can","are","that","this","by","from","at","be",
  "you","your","its","use","using","when","where","which","not","no","yes"
]);

export function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 2 && !STOP.has(w));
}

// Split a markdown doc into (heading, body) sections.
function sectionsOf(markdown) {
  const lines = String(markdown).split("\n");
  const sections = [];
  let heading = "(intro)";
  let buf = [];
  const flush = () => {
    const body = buf.join("\n").trim();
    if (body || heading !== "(intro)") sections.push({ heading, body });
    buf = [];
  };
  for (const line of lines) {
    const m = /^#{1,4}\s+(.*)$/.exec(line);
    if (m) {
      flush();
      heading = m[1].trim();
    } else {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

function walkMarkdown(dir, out, repoRoot) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "apm_modules") continue;
    const abs = path.join(dir, name);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) walkMarkdown(abs, out, repoRoot);
    else if (name.endsWith(".md")) out.push(path.relative(repoRoot, abs));
  }
}

// Build the index. `repoRoot` anchors source paths; `docsRoot` is the docs dir;
// `fittingsDir` is scanned for SKILL.md / instructions / apm.yml summaries.
export function buildIndex({ repoRoot, docsRoot = "docs", fittingsDir = "fittings/seed" } = {}) {
  const root = repoRoot || process.cwd();
  const records = []; // { source, heading, body, tokens: Set }
  const add = (source, heading, body) => {
    const toks = new Set(tokenize(`${heading} ${body}`));
    if (toks.size) records.push({ source, heading, body: body.slice(0, 1200), tokens: toks });
  };

  // 1. docs/*.md
  const docFiles = [];
  walkMarkdown(path.join(root, docsRoot), docFiles, root);
  for (const rel of docFiles) {
    const md = readFileSync(path.join(root, rel), "utf8");
    for (const s of sectionsOf(md)) add(rel, s.heading, s.body);
  }

  // 2. each installed Fitting's SKILL.md / instructions / apm.yml summary
  const fdir = path.join(root, fittingsDir);
  if (existsSync(fdir)) {
    for (const id of readdirSync(fdir)) {
      const fpath = path.join(fdir, id);
      let st; try { st = statSync(fpath); } catch { continue; }
      if (!st.isDirectory()) continue;
      // apm.yml summary
      const apm = path.join(fpath, "apm.yml");
      if (existsSync(apm)) {
        const y = readFileSync(apm, "utf8");
        const sm = /summary:\s*([\s\S]*?)(?:\n\s{2}\w|\n\w)/.exec(y);
        add(`${fittingsDir}/${id}/apm.yml`, `${id} (Fitting)`, sm ? sm[1] : y.slice(0, 600));
      }
      // any SKILL.md under the fitting
      const skills = [];
      walkMarkdown(fpath, skills, root);
      for (const rel of skills) {
        if (!/SKILL\.md$|instructions|README/i.test(rel)) continue;
        const md = readFileSync(path.join(root, rel), "utf8");
        for (const s of sectionsOf(md)) add(rel, `${id}: ${s.heading}`, s.body);
      }
    }
  }
  return { records, builtAt: null, size: records.length };
}

// Answer a question: score each section by token overlap, return the best
// sections + their sources. Deterministic; no network.
export function answer(index, question, { topK = 3 } = {}) {
  const qToks = tokenize(question);
  if (!qToks.length) return { answer: "Ask a question about Garrison.", sources: [], hits: [] };
  const scored = index.records
    .map((r) => {
      let score = 0;
      for (const t of qToks) if (r.tokens.has(t)) score += 1;
      // small boost when the heading itself matches
      const headToks = new Set(tokenize(r.heading));
      for (const t of qToks) if (headToks.has(t)) score += 1.5;
      return { r, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  if (!scored.length) {
    return { answer: `No indexed material matched "${question}".`, sources: [], hits: [] };
  }
  const sources = [...new Set(scored.map((x) => x.r.source))];
  const body = scored
    .map((x) => `## ${x.r.heading}\n${x.r.body.trim()}`)
    .join("\n\n");
  return {
    answer: `${body}\n\n— Grounded in: ${sources.join(", ")}`,
    sources,
    hits: scored.map((x) => ({ source: x.r.source, heading: x.r.heading, score: x.score }))
  };
}
