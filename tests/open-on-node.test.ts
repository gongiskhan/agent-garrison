import { afterEach, describe, expect, it, vi } from "vitest";
import { openOnNode } from "../src/components/talk/open-on-node";

// A conversation another node owns opens IN THIS WINDOW. The browser navigates;
// the Garrison app switches its node and carries the path, because its webview
// is bound to one origin and a cross-origin navigation would land in Safari.

type Win = { location: { href: string; origin: string; assign: (url: string) => void }; Capacitor?: unknown };

function installWindow(origin: string, capacitor?: unknown) {
  const assign = vi.fn();
  const win: Win = { location: { href: `${origin}/talk`, origin, assign } };
  if (capacitor) win.Capacitor = capacitor;
  (globalThis as unknown as { window: Win }).window = win;
  return assign;
}

afterEach(() => {
  delete (globalThis as unknown as { window?: Win }).window;
});

describe("openOnNode", () => {
  it("navigates this window in a browser, never a new tab", async () => {
    const assign = installWindow("https://mac.tail31efa.ts.net");
    await openOnNode("https://dev-madrid.tail31efa.ts.net/talk/abc");
    expect(assign).toHaveBeenCalledWith("https://dev-madrid.tail31efa.ts.net/talk/abc");
  });

  it("in the app, switches to the node that owns the page and carries the path", async () => {
    const select = vi.fn(async () => ({ name: "madrid" }));
    const assign = installWindow("https://mac.tail31efa.ts.net", {
      isNativePlatform: () => true,
      Plugins: {
        GarrisonNode: {
          list: async () => ({ nodes: [{ name: "mac", shellOrigin: "https://mac.tail31efa.ts.net" }, { name: "madrid", shellOrigin: "https://DEV-MADRID.tail31efa.ts.net/" }] }),
          select
        }
      }
    });
    await openOnNode("https://dev-madrid.tail31efa.ts.net/talk/abc?x=1");
    expect(select).toHaveBeenCalledWith({ name: "madrid", path: "/talk/abc?x=1" });
    expect(assign).not.toHaveBeenCalled();
  });

  it("in the app, a same-origin page and a node the app does not know both navigate", async () => {
    const select = vi.fn();
    const assign = installWindow("https://mac.tail31efa.ts.net", {
      isNativePlatform: () => true,
      Plugins: { GarrisonNode: { list: async () => ({ nodes: [{ name: "mac", shellOrigin: "https://mac.tail31efa.ts.net" }] }), select } }
    });
    await openOnNode("https://mac.tail31efa.ts.net/talk/here");
    await openOnNode("https://mini.tail31efa.ts.net/?new=1");
    expect(select).not.toHaveBeenCalled();
    expect(assign).toHaveBeenNthCalledWith(1, "https://mac.tail31efa.ts.net/talk/here");
    expect(assign).toHaveBeenNthCalledWith(2, "https://mini.tail31efa.ts.net/?new=1");
  });
});
