import type { UiPlacement, UiView } from "./types";

export interface ViewMatch {
  view: UiView;
  params: Record<string, string>;
}

// Match a sub-path against an ordered list of UI views and return the first
// view whose route template aligns with the path. Routes use a tiny
// react-router-style param syntax: a segment beginning with `:` captures one
// non-empty path segment into `params[name]`. No regex, no wildcards, no
// catch-alls — the v1 sidebar surfaces don't need them and adding them now
// would invite ambiguity in the route ordering.
export function matchView(
  views: UiView[],
  subPath: string,
  placement?: UiPlacement
): ViewMatch | null {
  const candidates = placement
    ? views.filter((view) => view.placement === placement)
    : views;
  const pathSegments = splitPath(subPath);
  for (const view of candidates) {
    const routeSegments = splitPath(view.route);
    if (routeSegments.length !== pathSegments.length) {
      continue;
    }
    const params: Record<string, string> = {};
    let matched = true;
    for (let index = 0; index < routeSegments.length; index += 1) {
      const routeSegment = routeSegments[index];
      const pathSegment = pathSegments[index];
      if (routeSegment.startsWith(":")) {
        if (pathSegment.length === 0) {
          matched = false;
          break;
        }
        params[routeSegment.slice(1)] = decodeURIComponent(pathSegment);
      } else if (routeSegment !== pathSegment) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return { view, params };
    }
  }
  return null;
}

function splitPath(path: string): string[] {
  // Treat "/", "" and "/foo/" the same. The catch-all page hands us subpaths
  // straight from Next.js's [[...rest]] which can be undefined or an array;
  // callers should join with "/" before passing in.
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  if (trimmed.length === 0) {
    return [];
  }
  return trimmed.split("/");
}
