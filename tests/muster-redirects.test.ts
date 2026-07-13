import { describe, expect, it } from "vitest";

import ComposePage from "@/app/compose/page";
import FacultyPage from "@/app/compose/[faculty]/page";

// S5c — the old Compose surface folds into Muster (D12). The grid page and the
// Orchestrator/Runtimes faculty stations redirect to /muster; every other faculty
// station keeps its own drilldown. Next's redirect() throws a NEXT_REDIRECT error
// whose `digest` encodes the destination, so we assert on that.

function redirectDigest(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    const digest = (err as { digest?: unknown }).digest;
    if (typeof digest === "string") return digest;
    throw err;
  }
  throw new Error("expected the page to redirect, but it returned normally");
}

describe("compose → muster redirects", () => {
  it("/compose (the grid) redirects to /muster", () => {
    const digest = redirectDigest(() => ComposePage());
    expect(digest).toMatch(/^NEXT_REDIRECT/);
    expect(digest).toContain("/muster");
  });

  it("/compose/orchestrator redirects to /muster", () => {
    const digest = redirectDigest(() => FacultyPage({ params: { faculty: "orchestrator" } }));
    expect(digest).toContain("/muster");
  });

  it("/compose/runtimes redirects to /muster", () => {
    const digest = redirectDigest(() => FacultyPage({ params: { faculty: "runtimes" } }));
    expect(digest).toContain("/muster");
  });

  it("another faculty station (channels) is NOT redirected to /muster", () => {
    // channels keeps its own /compose/<faculty> station: calling the page must
    // never raise a NEXT_REDIRECT. (Rendering the JSX result needs the React
    // runtime, which this node test env doesn't wire up, so we assert only that
    // no redirect fired — whether it returns an element or throws for another
    // reason, it is not folded into Muster.)
    let redirectedTo: string | null = null;
    try {
      FacultyPage({ params: { faculty: "channels" } });
    } catch (err) {
      const digest = (err as { digest?: unknown }).digest;
      if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) redirectedTo = digest;
    }
    expect(redirectedTo).toBeNull();
  });
});
