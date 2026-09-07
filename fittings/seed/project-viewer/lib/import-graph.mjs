// A bounded import walk, to turn one entry file into the candidate set a step
// might be about.
//
// Why bounded and why candidates. The runtime capture tells you which route served
// an action; it does not tell you which of that route's dependencies did the
// interesting work. Walking imports two levels deep gives a short, ordered list of
// plausible files, and the model picks from it. That is a much smaller and much
// more honest job than asking a model to guess the call graph from scratch — and
// unlike coverage instrumentation, it cannot silently produce a wrong answer,
// because every candidate is a real import that really exists.
//
// Depth is a cost control, not a correctness claim. Two levels from a route file
// reaches the handler's own helpers without dragging in the whole of src/lib.
//
// Pure: the caller injects `read(file) => string | null`. No filesystem here.

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(?:[\s\S]*?)\s*from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;
const REQUIRE_RE = /require\(\s*["']([^"']+)["']\s*\)/g;
const DYNAMIC_RE = /import\(\s*["']([^"']+)["']\s*\)/g;

/** Every module specifier a file imports, in source order, deduplicated. */
export function importSpecifiers(text) {
  const src = String(text ?? "");
  const found = [];
  const push = (s) => {
    if (s && !found.includes(s)) found.push(s);
  };
  for (const re of [IMPORT_RE, REQUIRE_RE, DYNAMIC_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) push(m[1] ?? m[2]);
  }
  return found;
}

/** Is this a first-party specifier worth following? */
export function isLocal(spec, aliases) {
  const s = String(spec ?? "");
  if (s.startsWith(".") || s.startsWith("/")) return true;
  for (const prefix of Object.keys(aliases ?? {})) {
    if (s === prefix.replace(/\*$/, "") || s.startsWith(prefix.replace(/\*$/, ""))) return true;
  }
  return false;
}

const EXTENSIONS = ["", ".ts", ".tsx", ".mjs", ".js", ".jsx", ".mts", ".cts"];
const INDEXES = ["index.ts", "index.tsx", "index.mjs", "index.js"];

/**
 * Turn a specifier into a repo-relative path, trying the extensions and index
 * files a bundler would. Returns null when nothing resolves, which is the correct
 * answer for a third-party package or a path that does not exist.
 */
export function resolveSpecifier(spec, fromFile, { aliases = { "@/": "src/" }, exists } = {}) {
  const s = String(spec ?? "");
  let base;

  if (s.startsWith(".")) {
    const dir = String(fromFile).split("/").slice(0, -1).join("/");
    base = normalise(`${dir}/${s}`);
  } else {
    let mapped = null;
    for (const [prefix, target] of Object.entries(aliases)) {
      const p = prefix.replace(/\*$/, "");
      if (s.startsWith(p)) {
        mapped = target.replace(/\*$/, "") + s.slice(p.length);
        break;
      }
    }
    if (mapped === null) return null;
    base = normalise(mapped);
  }

  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    if (candidate && exists(candidate)) return candidate;
  }
  for (const index of INDEXES) {
    const candidate = `${base}/${index}`;
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** Collapse `.` and `..` without touching the filesystem. */
export function normalise(p) {
  const out = [];
  for (const part of String(p).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/**
 * Walk imports from `entry`, breadth-first, to `maxDepth`.
 *
 * Returns `[{ file, depth, via }]` ordered by depth then by the order the imports
 * appear in the source — which approximates "how central is this to the entry
 * file", and is the order a reader would meet them.
 */
export function importCandidates(entry, { read, maxDepth = 2, aliases = { "@/": "src/" }, limit = 60 } = {}) {
  if (typeof read !== "function") throw new TypeError("importCandidates needs a read(file) function");
  const exists = (file) => read(file) !== null && read(file) !== undefined;

  const seen = new Set([entry]);
  const out = [];
  let frontier = [{ file: entry, depth: 0 }];

  while (frontier.length && out.length < limit) {
    const next = [];
    for (const node of frontier) {
      if (node.depth >= maxDepth) continue;
      const text = read(node.file);
      if (text === null || text === undefined) continue;

      for (const spec of importSpecifiers(text)) {
        if (!isLocal(spec, aliases)) continue;
        const resolved = resolveSpecifier(spec, node.file, { aliases, exists });
        if (!resolved || seen.has(resolved)) continue;
        seen.add(resolved);
        const record = { file: resolved, depth: node.depth + 1, via: node.file };
        out.push(record);
        next.push(record);
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    }
    frontier = next;
  }

  return out;
}

/**
 * Rank candidates for the narrator. Shallower is more likely to be the interesting
 * file; a name that echoes the route is a strong hint; test and type-only files are
 * pushed down because they rarely explain a runtime step.
 */
export function rankCandidates(candidates, { hintPath = "" } = {}) {
  const hintWords = String(hintPath)
    .split(/[^a-z0-9]+/i)
    .filter((w) => w.length > 3)
    .map((w) => w.toLowerCase());

  return [...(candidates ?? [])]
    .map((c, i) => {
      let score = 100 - c.depth * 20 - i;
      const lower = c.file.toLowerCase();
      if (hintWords.some((w) => lower.includes(w))) score += 25;
      if (/\.test\.|\.spec\.|__tests__|\/types?\./.test(lower)) score -= 60;
      if (/\/lib\//.test(lower)) score += 8;
      return { ...c, score };
    })
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
}
