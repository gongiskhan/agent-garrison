// What the code says exists, and who says they use it.
//
// This is the static half of `compare` mode. It answers two questions per exported
// symbol: does anything reference it, and is that anything a test?
//
// HOW CRUDE THIS IS, stated up front. References are counted by matching the
// identifier as a whole word in other files' text. That counts hits inside comments
// and strings, and it cannot tell two same-named symbols apart. Both errors push in
// the SAME direction — they INFLATE the reference count — so the mistake this scan
// makes is calling live code live. It will miss some dead code. It will not
// confidently declare live code dead, which is the error that gets something
// deleted.
//
// Even so, the output is called a CANDIDATE everywhere, and the brief's rule stands:
// do not delete on its word alone.
//
// Pure: every read goes through an injected `read`, so the whole module is testable
// against a map of fake files.

/** Directories whose contents are never anybody's source code. */
const SKIP_DIRS = [
  "node_modules/",
  "/dist/",
  "/build/",
  ".next/",
  ".next-e2e/",
  ".next-prod/",
  "coverage/",
  "apm_modules/",
  "/.git/",
];

const SOURCE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

export function isSourceFile(file) {
  const p = `/${String(file ?? "").replace(/^\/+/, "")}`;
  if (!SOURCE_EXT.test(p)) return false;
  if (p.endsWith(".d.ts")) return false;
  return !SKIP_DIRS.some((d) => p.includes(d));
}

/**
 * A test file, by the conventions this repo and every repo like it uses. Kept as a
 * separate question from "is it source" because a symbol used ONLY by tests is a
 * distinct and interesting state, not the same as unused.
 */
export function isTestFile(file) {
  const p = String(file ?? "");
  return (
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(p) ||
    /(?:^|\/)(?:tests?|__tests__|e2e)\//.test(p) ||
    /(?:^|\/)playwright\.config\.[cm]?[jt]s$/.test(p)
  );
}

/**
 * Files the framework calls, not the codebase. A Next route file's default export
 * has no importer anywhere and is still the most-used code in the project; listing
 * those as dead would make the whole report untrustworthy at a glance.
 */
export function isFrameworkEntry(file) {
  const p = String(file ?? "");
  return (
    /(?:^|\/)(?:page|layout|route|template|loading|error|not-found|global-error|default)\.[cm]?[jt]sx?$/.test(p) ||
    /(?:^|\/)middleware\.[cm]?[jt]s$/.test(p) ||
    /(?:^|\/)instrumentation\.[cm]?[jt]s$/.test(p) ||
    /\.config\.[cm]?[jt]s$/.test(p) ||
    /(?:^|\/)scripts\//.test(p)
  );
}

const DECL = new RegExp(
  String.raw`^\s*export\s+` +
    String.raw`(?:(?<mods>(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?))` +
    String.raw`(?<kind>function\s*\*?|class|const|let|var|interface|type|enum)\s+` +
    String.raw`(?<name>[A-Za-z_$][\w$]*)`
);

/** `export { a, b as c }` — the names that leave are the aliases, when aliased. */
const NAMED_LIST = /^\s*export\s*\{([^}]*)\}/;

/**
 * Exported symbols of one file, with the line each is declared on.
 *
 * `export * from` is deliberately not followed: it exports an unknown set, and
 * guessing at it would put invented names in a report people act on. A file
 * containing one is flagged instead, so the gap is visible.
 */
export function exportsOf(text, file = null) {
  const lines = String(text ?? "").split(/\r\n|\r|\n/);
  const out = [];
  let opaque = false;

  lines.forEach((line, i) => {
    if (/^\s*export\s+\*/.test(line)) {
      opaque = true;
      return;
    }

    const decl = DECL.exec(line);
    if (decl) {
      const kindWord = decl.groups.kind.trim().replace(/\*$/, "").trim();
      out.push({
        name: decl.groups.name,
        kind: kindWord === "function" ? "function" : kindWord,
        line: i + 1,
        ...(/\bdefault\b/.test(decl.groups.mods ?? "") ? { isDefault: true } : {}),
        ...(file ? { file } : {}),
      });
      return;
    }

    const named = NAMED_LIST.exec(line);
    if (named && !/\bfrom\b/.test(line)) {
      for (const raw of named[1].split(",")) {
        const part = raw.trim();
        if (!part) continue;
        const alias = /^(?<local>[A-Za-z_$][\w$]*)\s+as\s+(?<exported>[A-Za-z_$][\w$]*)$/.exec(part);
        const name = alias ? alias.groups.exported : part;
        if (!/^[A-Za-z_$][\w$]*$/.test(name) || name === "default") continue;
        out.push({ name, kind: "reexport", line: i + 1, ...(file ? { file } : {}) });
      }
    }
  });

  // Same name declared and then re-exported is one symbol, not two.
  const seen = new Set();
  const unique = out.filter((e) => {
    if (seen.has(e.name)) return false;
    seen.add(e.name);
    return true;
  });
  return { exports: unique, opaqueReexport: opaque };
}

/** Whole-word occurrences of an identifier. `$` and `_` count as word characters. */
export function countReferences(text, name) {
  if (!text || !name) return 0;
  const re = new RegExp(String.raw`(?<![\w$])${escapeIdent(name)}(?![\w$])`, "g");
  let n = 0;
  // Iterating rather than using match().length: this runs over every file for every
  // symbol, and building throwaway arrays for a few thousand pairs is waste.
  while (re.exec(text) !== null) n += 1;
  return n;
}

function escapeIdent(name) {
  return String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Scan a file list. Returns one entry per exported symbol with its reference counts
 * split by whether the referencing file is a test.
 *
 * `read` is injected and may return null for a file that vanished mid-scan; that
 * file is skipped rather than aborting a scan of a thousand others.
 */
/**
 * `referenceFiles` is separate from `files` on purpose, and getting this wrong is how
 * a tool like this gets live code deleted.
 *
 * `files` is what to REPORT on. `referenceFiles` is where a use may be found, and it
 * must stay the whole repository even when the report is narrowed. Scoping the report
 * to `src` while also scoping the search would drop `tests/` from the search and turn
 * every test-covered helper into "referenced by nothing" — a confident lie produced
 * by narrowing the wrong list.
 */
export function scanExports(files, { read, referenceFiles = null }) {
  if (typeof read !== "function") throw new Error("scanExports needs a read(file) function");

  const sources = files.filter(isSourceFile);
  const searched = (referenceFiles ?? files).filter(isSourceFile);

  const texts = new Map();
  for (const file of new Set([...sources, ...searched])) {
    const text = read(file);
    if (typeof text === "string") texts.set(file, text);
  }

  const symbols = [];
  const opaque = [];
  for (const file of sources) {
    const text = texts.get(file);
    if (typeof text !== "string") continue;
    const { exports: found, opaqueReexport } = exportsOf(text, file);
    if (opaqueReexport) opaque.push(file);
    for (const e of found) {
      // `self` is what separates "this export is unnecessary" from "this code is
      // unused". A function called by its own module is alive; only the `export`
      // keyword in front of it is dead, and those are different repairs.
      const own = texts.get(file) ?? "";
      symbols.push({
        ...e,
        refs: { code: 0, test: 0, self: Math.max(0, countReferences(own, e.name) - 1) },
        referencedBy: [],
      });
    }
  }

  // One pass per searched file over every symbol name. Quadratic in the worst case,
  // but the constant is a regex over text already in memory, and the alternative — a
  // real parser — is a dependency this fitting refuses to take on.
  for (const file of searched) {
    const text = texts.get(file);
    if (typeof text !== "string") continue;
    const test = isTestFile(file);
    for (const sym of symbols) {
      if (sym.file === file) continue;
      const n = countReferences(text, sym.name);
      if (!n) continue;
      sym.refs[test ? "test" : "code"] += n;
      if (sym.referencedBy.length < 5) sym.referencedBy.push(file);
    }
  }

  return {
    files: sources.length,
    scanned: sources.filter((f) => texts.has(f)).length,
    searched: searched.filter((f) => texts.has(f)).length,
    symbols,
    // Files whose exports could not be enumerated. Named, so the report can admit
    // where it is blind instead of implying it saw everything.
    opaqueReexports: opaque,
  };
}

/**
 * Exports nothing references from non-test code — the dead-code CANDIDATES.
 *
 * Framework entries are excluded, not because they are never dead but because
 * nothing in a static scan can tell: the framework's call is the reference, and it
 * lives in a router, not in the source. A candidate list nobody trusts is worse
 * than a shorter one that holds up.
 */
export function deadCandidates(scan) {
  return scan.symbols
    .filter((s) => s.refs.code === 0)
    .filter((s) => !isFrameworkEntry(s.file))
    .filter((s) => !isTestFile(s.file))
    .map((s) => ({
      file: s.file,
      line: s.line,
      symbol: s.name,
      kind: s.kind,
      testOnly: s.refs.test > 0,
      typeOnly: isTypeExport(s.kind),
      usedInternally: s.refs.self > 0,
    }))
    // Ordered by how actionable each one is, NOT by path — because the list gets
    // capped, and a path sort meant the whole of `src/lib` fell off the end of an
    // alphabetical cliff while a vendored directory filled the list. Value exports
    // come first, type exports last.
    .sort(
      (a, b) =>
        rankOf(a) - rankOf(b) || a.file.localeCompare(b.file) || a.line - b.line
    );
}

/**
 * A type-only export is a different question from dead code.
 *
 * An exported `interface` or `type` with no importer leaves no runtime trace at all,
 * so deleting it changes nothing that ships — it is a question about a module's
 * public API surface, not about dead weight. Mixing the two made the report 60%
 * TypeScript declarations, which buried every unreferenced function.
 */
export function isTypeExport(kind) {
  return kind === "interface" || kind === "type";
}

/**
 * Most actionable first. Nothing-references-it-anywhere is the deletable case and
 * leads; a type declaration changes nothing that ships and comes last.
 */
function rankOf(candidate) {
  if (candidate.typeOnly) return 3;
  if (candidate.usedInternally) return 2;
  if (candidate.testOnly) return 1;
  return 0;
}

/**
 * The same name exported from more than one file.
 *
 * Sometimes that is fine — two modules may both legitimately export `create`. But it
 * is also the commonest shape of the brief's third bucket, the same job solved
 * differently in two places, and it is the only version of that question a scan can
 * ask without understanding the code.
 */
export function duplicateNames(scan, { ignore = ["default", "GET", "POST", "PATCH", "PUT", "DELETE"] } = {}) {
  const byName = new Map();
  for (const s of scan.symbols) {
    if (ignore.includes(s.name)) continue;
    // Framework entries all export the same handful of names by contract, so they
    // would dominate the list while telling nobody anything.
    if (isFrameworkEntry(s.file)) continue;
    if (!byName.has(s.name)) byName.set(s.name, []);
    byName.get(s.name).push(s);
  }
  return [...byName.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([name, list]) => ({
      symbol: name,
      places: list.map((s) => ({ file: s.file, line: s.line })).sort((a, b) => a.file.localeCompare(b.file)),
    }))
    .sort((a, b) => b.places.length - a.places.length || a.symbol.localeCompare(b.symbol));
}
