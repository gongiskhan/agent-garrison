// The drillbook as a spine source.
//
// WHY THE DRILLBOOK COMES FIRST. A drillbook is hand-authored: someone sat down and
// wrote what matters about each page. That makes its `description` fields better
// narration guidance than anything this tool can derive — a ranked import list says
// which files are nearby, a drillbook step says what the page is FOR. Where a
// drillbook and a test describe the same flow, the drillbook wins.
//
// WHAT IT DOES NOT GIVE YOU. A drillbook step is a vision judgement about a page, not
// an ordered sequence of clicks. So the spine it yields is one navigation per page
// state — honest, and thinner than an e2e capture. It is not padded out with invented
// interactions to look richer.
//
// THE YAML DEPENDENCY, and why it is optional. `js-yaml` is what this repo already
// uses for exactly these files, and hand-rolling a parser was rejected: a folded
// block (`>-`) misread would silently produce a wrong page path, and wrong data
// presented confidently is the one failure this whole fitting exists to prevent. So
// the import is lazy and the absence is loud — every other mode keeps working without
// it, and drillbook mode says plainly what is missing.
//
// The parse functions below are pure and take already-decoded objects, so the shape
// logic is testable without YAML in the picture at all.

import path from "node:path";

export const BOOK_PATH = "drills/drillbook.yml";
export const PAGES_DIR = "drills/pages";

let yamlModule = null;

/** The one door to YAML in this fitting. */
export async function loadYaml(text) {
  if (!yamlModule) {
    try {
      yamlModule = await import("js-yaml");
    } catch (err) {
      throw new Error(
        "drillbook support needs the `js-yaml` package, which is not resolvable from here. " +
          "Every other mode works without it. Install it in the target repo, or capture the " +
          `flow from an e2e spec instead. (${err.code ?? err.message})`
      );
    }
  }
  const load = yamlModule.load ?? yamlModule.default?.load;
  if (typeof load !== "function") throw new Error("js-yaml resolved but exposes no load()");
  return load(text);
}

/** Normalise the book. Pure: hands it an already-decoded object. */
export function parseBook(obj) {
  if (!obj || typeof obj !== "object") throw new Error("the drillbook did not decode to an object");
  const pages = Array.isArray(obj.pages) ? obj.pages : [];
  return {
    app: { name: obj.app?.name ?? null, url: obj.app?.url ?? null },
    // Kept because it is the author's standing statement about the whole app, and it
    // belongs in front of a narrator's eyes before they write about any page.
    globalRules: typeof obj.globalRules === "string" ? obj.globalRules.trim() : null,
    viewports: Array.isArray(obj.viewports) ? obj.viewports : [],
    pages: pages
      .filter((p) => p && typeof p.id === "string" && typeof p.path === "string")
      .map((p) => ({
        id: p.id,
        title: p.title ?? p.id,
        path: p.path,
        mode: p.mode ?? "steps",
        // `selected` absent means selected: an unmarked page in a hand-written book
        // is part of the book. Only an explicit false opts out.
        selected: p.selected !== false,
      })),
  };
}

/** Normalise one page file. Pure. */
export function parsePage(obj, { id = null } = {}) {
  if (!obj || typeof obj !== "object") throw new Error("a drillbook page did not decode to an object");
  const steps = Array.isArray(obj.steps) ? obj.steps : [];
  const states = Array.isArray(obj.states) ? obj.states : [];
  return {
    id: obj.id ?? id,
    title: obj.title ?? obj.id ?? id,
    path: obj.path ?? null,
    steps: steps
      // Numbered from the position in the FILE, before disabled steps are dropped.
      // Numbering the survivors instead meant that enabling one step silently
      // renumbered another — and these ids travel into a manifest's provenance, where
      // an identifier that moves when something unrelated is toggled is worthless.
      .map((s, i) => ({ raw: s, position: i + 1 }))
      .filter(({ raw }) => raw && raw.enabled !== false)
      .map(({ raw: s, position }) => ({
        id: typeof s.id === "string" ? s.id : `step-${position}`,
        area: s.area ?? null,
        mode: s.mode ?? "vision",
        state: s.state ?? "default",
        description: typeof s.description === "string" ? s.description.trim() : "",
        viewports: Array.isArray(s.viewports) ? s.viewports : [],
        tags: Array.isArray(s.tags) ? s.tags : [],
      })),
    // A declared state is a distinct thing to look at on the same path, so each one
    // earns its own step in the spine rather than being folded into the default.
    states: states
      .filter((s) => s && typeof s.id === "string")
      .map((s) => ({
        id: s.id,
        label: s.label ?? s.id,
        // How to reach the state, in the author's words. Never executed by this tool.
        setup: typeof s.setup === "string" ? s.setup.trim() : null,
      })),
  };
}

/**
 * Read the book and every selected page it names.
 *
 * `readFile` is injected so the whole thing can be exercised against a map of
 * strings, and returns null for a missing file rather than throwing — a book naming
 * a page that no longer exists is a finding, not a crash.
 */
export async function readDrillbook(repo, { readFile }) {
  const bookText = await readFile(path.join(repo, BOOK_PATH));
  if (bookText === null) return null;

  const book = parseBook(await loadYaml(bookText));
  const pages = [];
  const missing = [];
  for (const entry of book.pages) {
    if (!entry.selected) continue;
    const file = path.join(repo, PAGES_DIR, `${entry.id}.yml`);
    const text = await readFile(file);
    if (text === null) {
      missing.push(`${PAGES_DIR}/${entry.id}.yml`);
      continue;
    }
    const page = parsePage(await loadYaml(text), { id: entry.id });
    // The book's path wins: it is the index the team maintains, and a page file that
    // disagrees with it is a discrepancy worth surfacing rather than silently
    // resolving one way.
    const disagrees = page.path && entry.path && page.path !== entry.path;
    pages.push({
      ...page,
      path: entry.path,
      ...(disagrees ? { pathDisagreement: page.path } : {}),
      sourceFile: `${PAGES_DIR}/${entry.id}.yml`,
    });
  }
  return { ...book, pages, missingPages: missing };
}

/**
 * The navigations one page contributes: the default view, plus one per declared state.
 * Each carries the author's own words about what matters, which is the whole reason
 * this source exists.
 */
export function navigationsFor(page) {
  const intentFor = (stateId) => {
    const matching = page.steps.filter((s) => (s.state ?? "default") === stateId);
    const pool = matching.length ? matching : page.steps.filter((s) => (s.state ?? "default") === "default");
    return pool
      .map((s) => s.description)
      .filter(Boolean)
      .join(" ");
  };

  const out = [{ stateId: "default", label: page.title, url: page.path, intent: intentFor("default") }];
  for (const state of page.states) {
    out.push({
      stateId: state.id,
      label: `${page.title} — ${state.label}`,
      url: page.path,
      intent: [intentFor(state.id), state.setup ? `Reached by: ${state.setup}` : ""].filter(Boolean).join(" "),
    });
  }
  return out;
}
