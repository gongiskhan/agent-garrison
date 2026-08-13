// URL → route file, resolved deterministically.
//
// This is the module that makes the runtime spine cheap. Next's app router is a
// pure function of the filesystem: a URL does not need coverage instrumentation to
// tell you which file served it, it needs the routing rules applied honestly. So
// there is no guessing here and no model involvement — given the URL a test
// visited and a listing of the app directory, the answer is derived.
//
// Pure: the caller supplies the file listing. That keeps it testable without a
// repo and makes it obvious that nothing here touches disk.
//
// Scope, stated plainly: this implements the routing features Garrison actually
// uses — static segments, dynamic `[param]`, catch-all `[...param]`, optional
// catch-all `[[...param]]`, and route groups `(group)`. It does NOT model
// middleware rewrites, `basePath`, or parallel/intercepted routes. When it cannot
// resolve a path it returns null, and the caller records an unmapped request
// rather than inventing a file.

const PAGE_FILES = ["page.tsx", "page.ts", "page.jsx", "page.js"];
const ROUTE_FILES = ["route.ts", "route.tsx", "route.js"];

/** Split a URL path into segments, dropping query, hash and empty parts. */
export function pathSegments(urlPath) {
  const clean = String(urlPath ?? "")
    .split("#")[0]
    .split("?")[0];
  return clean.split("/").filter(Boolean);
}

/**
 * Turn a repo-relative app-router file into its route pattern.
 * `src/app/api/quarters/[type]/route.ts` → { segments: ["api","quarters","[type]"], kind: "route" }
 * Route groups — `(dashboard)` — carry no URL segment and are dropped.
 */
export function patternFor(file, appDir = "src/app") {
  const rel = String(file ?? "");
  if (!rel.startsWith(`${appDir}/`)) return null;
  const parts = rel.slice(appDir.length + 1).split("/");
  const leaf = parts.pop();
  const kind = PAGE_FILES.includes(leaf) ? "page" : ROUTE_FILES.includes(leaf) ? "route" : null;
  if (!kind) return null;
  const segments = parts.filter((p) => !(p.startsWith("(") && p.endsWith(")")));
  return { file: rel, kind, segments };
}

function segmentScore(segment) {
  // Static beats dynamic beats catch-all, which is Next's own precedence.
  if (segment.startsWith("[[...")) return 0;
  if (segment.startsWith("[...")) return 1;
  if (segment.startsWith("[")) return 2;
  return 3;
}

/** Does a pattern match these URL segments? Returns extracted params or null. */
export function matchPattern(pattern, segments) {
  const params = {};
  const pat = pattern.segments;
  let i = 0;

  for (let p = 0; p < pat.length; p += 1) {
    const seg = pat[p];

    if (seg.startsWith("[[...") && seg.endsWith("]]")) {
      // Optional catch-all: matches zero or more remaining segments, and must be last.
      if (p !== pat.length - 1) return null;
      params[seg.slice(5, -2)] = segments.slice(i);
      return params;
    }
    if (seg.startsWith("[...") && seg.endsWith("]")) {
      if (p !== pat.length - 1) return null;
      if (i >= segments.length) return null; // catch-all needs at least one
      params[seg.slice(4, -1)] = segments.slice(i);
      return params;
    }
    if (seg.startsWith("[") && seg.endsWith("]")) {
      if (i >= segments.length) return null;
      params[seg.slice(1, -1)] = segments[i];
      i += 1;
      continue;
    }
    if (segments[i] !== seg) return null;
    i += 1;
  }

  return i === segments.length ? params : null;
}

/**
 * Resolve a URL path to the file that served it.
 *
 * `appFiles` is a list of repo-relative paths. Returns
 * `{ file, kind, params, layouts }` or null. `layouts` is the chain of layout
 * files that wrap a page, because a reader following a UI flow usually needs the
 * layout that rendered the chrome as much as the page itself.
 */
export function resolveAppRoute(urlPath, appFiles, { appDir = "src/app", kind = null } = {}) {
  const segments = pathSegments(urlPath);
  const patterns = [];
  for (const file of appFiles ?? []) {
    const pattern = patternFor(file, appDir);
    if (!pattern) continue;
    if (kind && pattern.kind !== kind) continue;
    patterns.push(pattern);
  }

  const candidates = [];
  for (const pattern of patterns) {
    const params = matchPattern(pattern, segments);
    if (params) candidates.push({ pattern, params });
  }
  if (!candidates.length) return null;

  // Most specific wins: longest pattern first, then the least dynamic segments.
  candidates.sort((a, b) => {
    const lenDiff = b.pattern.segments.length - a.pattern.segments.length;
    if (lenDiff !== 0) return lenDiff;
    for (let i = 0; i < a.pattern.segments.length; i += 1) {
      const diff = segmentScore(b.pattern.segments[i]) - segmentScore(a.pattern.segments[i]);
      if (diff !== 0) return diff;
    }
    // A route handler is a better answer than a page for the same path when both
    // exist, since a request that reached both was almost certainly the API call.
    if (a.pattern.kind !== b.pattern.kind) return a.pattern.kind === "route" ? -1 : 1;
    return a.pattern.file.localeCompare(b.pattern.file);
  });

  const winner = candidates[0];
  return {
    file: winner.pattern.file,
    kind: winner.pattern.kind,
    params: winner.params,
    layouts: winner.pattern.kind === "page" ? layoutChain(winner.pattern.file, appFiles, appDir) : [],
  };
}

/**
 * Every `layout.*` from the app root down to the page's own directory, outermost
 * first — which is the order they actually wrap the page in.
 */
export function layoutChain(pageFile, appFiles, appDir = "src/app") {
  const dirs = [];
  const parts = String(pageFile).split("/");
  parts.pop();
  for (let i = parts.length; i >= 0; i -= 1) {
    const dir = parts.slice(0, i).join("/");
    if (dir.startsWith(appDir) || dir === appDir) dirs.unshift(dir);
  }
  const set = new Set(appFiles ?? []);
  const layouts = [];
  for (const dir of dirs) {
    for (const name of ["layout.tsx", "layout.ts", "layout.jsx", "layout.js"]) {
      const candidate = `${dir}/${name}`;
      if (set.has(candidate)) {
        layouts.push(candidate);
        break;
      }
    }
  }
  return layouts;
}

/** Convenience: only the API handlers, for correlating network requests. */
export function resolveApiRoute(urlPath, appFiles, opts = {}) {
  return resolveAppRoute(urlPath, appFiles, { ...opts, kind: "route" });
}

/**
 * A page whose entire job is to redirect somewhere else, and where to.
 *
 * This exists because of a real wrong answer it prevents. A test that does
 * `goto("/memory")` lands on a three-line stub calling
 * `permanentRedirect("/quarters/context")`, and every action after it happens on
 * the target page. The reporter never sees a second navigation — the redirect is
 * server-side — so without this the capture attributes the whole interaction to the
 * stub, and a flow narrated from it would point at a redirect and claim that is
 * where the editing happens. Confidently wrong, which is the one outcome this tool
 * cannot afford.
 *
 * Only a STRING LITERAL target is followed. A computed redirect is reported as
 * `dynamic`, so the caller can say "this redirects, target unknown" rather than
 * guess. That is the difference between derivation and invention.
 */
export function redirectTargetOf(text) {
  const src = String(text ?? "");
  const call = /\b(?:permanentRedirect|redirect)\s*\(\s*(["'`])([^"'`]*)\1/.exec(src);
  if (call) return { target: call[2], kind: "literal" };
  if (/\b(?:permanentRedirect|redirect)\s*\(/.test(src)) return { target: null, kind: "dynamic" };
  return null;
}

/**
 * Resolve a URL, then follow literal redirects to the page a reader actually
 * interacted with. Returns `{ ...route, via: [hops] }` where `via` records the
 * stubs passed through, so nothing is hidden.
 *
 * `read(file)` is injected; this module still touches no disk.
 */
export function resolveThroughRedirects(urlPath, appFiles, { read, appDir = "src/app", maxHops = 3 } = {}) {
  let route = resolveAppRoute(urlPath, appFiles, { appDir });
  if (!route || typeof read !== "function") return route;

  const via = [];
  let hops = 0;
  let seen = new Set([route.file]);

  while (hops < maxHops) {
    const text = read(route.file);
    if (text === null || text === undefined) break;
    const redirect = redirectTargetOf(text);
    if (!redirect) break;

    if (redirect.kind === "dynamic") {
      // Say so instead of pretending the stub is the destination.
      return { ...route, via, redirects: "dynamic" };
    }
    const next = resolveAppRoute(redirect.target, appFiles, { appDir });
    if (!next || seen.has(next.file)) break;

    via.push({ file: route.file, to: redirect.target });
    seen.add(next.file);
    route = next;
    hops += 1;
  }

  return via.length ? { ...route, via } : route;
}
