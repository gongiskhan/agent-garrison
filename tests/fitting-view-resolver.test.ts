import { describe, expect, it } from "vitest";
import { matchView } from "@/lib/fitting-views";
import type { UiView } from "@/lib/types";

const views: UiView[] = [
  { id: "list", placement: "sidebar-surface", entry: "./ui/list.tsx", route: "/" },
  { id: "read", placement: "sidebar-surface", entry: "./ui/read.tsx", route: "/:id" },
  { id: "edit", placement: "sidebar-surface", entry: "./ui/edit.tsx", route: "/:id/edit" },
  { id: "main", placement: "faculty-tab", entry: "./ui/Main.tsx", route: "/" }
];

describe("matchView", () => {
  it("matches the root route exactly", () => {
    const result = matchView(views, "/", "sidebar-surface");
    expect(result?.view.id).toBe("list");
    expect(result?.params).toEqual({});
  });

  it("treats empty path the same as root", () => {
    const result = matchView(views, "", "sidebar-surface");
    expect(result?.view.id).toBe("list");
  });

  it("captures a single param", () => {
    const result = matchView(views, "/abc123", "sidebar-surface");
    expect(result?.view.id).toBe("read");
    expect(result?.params).toEqual({ id: "abc123" });
  });

  it("matches a multi-segment route with a literal tail", () => {
    const result = matchView(views, "/abc123/edit", "sidebar-surface");
    expect(result?.view.id).toBe("edit");
    expect(result?.params).toEqual({ id: "abc123" });
  });

  it("returns null when no route lines up", () => {
    const result = matchView(views, "/abc/extra/segment", "sidebar-surface");
    expect(result).toBeNull();
  });

  it("filters by placement so faculty-tab views do not steal sidebar matches", () => {
    const onlyFacultyViews: UiView[] = [
      { id: "main", placement: "faculty-tab", entry: "./ui/Main.tsx", route: "/" }
    ];
    expect(matchView(onlyFacultyViews, "/", "sidebar-surface")).toBeNull();
    expect(matchView(onlyFacultyViews, "/", "faculty-tab")?.view.id).toBe("main");
  });

  it("decodes URL-encoded params", () => {
    const result = matchView(views, "/with%20space", "sidebar-surface");
    expect(result?.params).toEqual({ id: "with space" });
  });

  it("returns the first matching view when multiple could match", () => {
    const ambiguous: UiView[] = [
      { id: "first", placement: "sidebar-surface", entry: "./a.tsx", route: "/:id" },
      { id: "second", placement: "sidebar-surface", entry: "./b.tsx", route: "/:slug" }
    ];
    const result = matchView(ambiguous, "/anything", "sidebar-surface");
    expect(result?.view.id).toBe("first");
  });
});
