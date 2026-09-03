import { afterEach, describe, expect, it, vi } from "vitest";
import { openOnNode, openViaParent, parentRouteFor, OPEN_CONVERSATION_MESSAGE } from "../src/components/talk/open-on-node";

// A conversation another node owns opens IN THIS WINDOW, on this origin: the
// rail points at /mesh/talk/<node>/<id>, which frames the peer's chromeless
// page. Inside that frame a row asks the parent to open it instead.

type Win = {
  location: { href: string; origin: string; assign: (url: string) => void };
  parent: { postMessage: (message: unknown, origin: string) => void };
};

function installWindow(origin: string) {
  const assign = vi.fn();
  const postMessage = vi.fn();
  const win: Win = { location: { href: `${origin}/talk`, origin, assign }, parent: { postMessage } };
  (globalThis as unknown as { window: Win }).window = win;
  return { assign, postMessage };
}

afterEach(() => {
  delete (globalThis as unknown as { window?: Win }).window;
});

describe("openOnNode", () => {
  it("navigates this window to the local mesh page, never a new tab or another origin", () => {
    const { assign } = installWindow("https://mac.tail31efa.ts.net");
    openOnNode("/mesh/talk/dev-madrid/abc");
    expect(assign).toHaveBeenCalledWith("https://mac.tail31efa.ts.net/mesh/talk/dev-madrid/abc");
  });
});

describe("openViaParent", () => {
  it("posts the absolute conversation url to the framing window", () => {
    const { assign, postMessage } = installWindow("https://dev-madrid.tail31efa.ts.net");
    openViaParent("/mesh/talk/mini/xyz?new=1");
    expect(postMessage).toHaveBeenCalledWith(
      { type: OPEN_CONVERSATION_MESSAGE, url: "https://dev-madrid.tail31efa.ts.net/mesh/talk/mini/xyz?new=1" },
      "*"
    );
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("parentRouteFor", () => {
  it("maps a peer's mesh route onto the parent's own routes", () => {
    expect(parentRouteFor("https://dev-madrid.tail31efa.ts.net/mesh/talk/mini/xyz", "mac")).toBe("/mesh/talk/mini/xyz");
    expect(parentRouteFor("https://dev-madrid.tail31efa.ts.net/mesh/talk/mini/?new=1", "mac")).toBe("/mesh/talk/mini?new=1");
  });
  it("opens the parent's own node locally", () => {
    expect(parentRouteFor("https://dev-madrid.tail31efa.ts.net/mesh/talk/mac/abc", "mac")).toBe("/talk/abc");
    expect(parentRouteFor("https://dev-madrid.tail31efa.ts.net/mesh/talk/mac?new=1", "mac")).toBe("/talk?new=1");
  });
  it("ignores anything that is not a conversation route", () => {
    expect(parentRouteFor("https://dev-madrid.tail31efa.ts.net/settings", "mac")).toBeNull();
    expect(parentRouteFor("not a url", "mac")).toBeNull();
    expect(parentRouteFor("https://x/mesh/talk/a/b/c", "mac")).toBeNull();
  });
});
