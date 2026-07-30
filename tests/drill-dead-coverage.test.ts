// Dead coverage: a page that reports checks but executes none.
//
// Found on the first real plan of a live app. The agent authored ten checks for
// the login page and scoped every one of them to `state: logged-out`, because a
// leftover session had redirected it on the way in and it concluded the form
// was a special condition rather than the page's normal appearance. A normal
// run executes ONLY default-state checks, so that page was worth exactly zero -
// and nothing said so anywhere: the Book listed ten checks, the Authoring list
// rendered empty (which reads as "not authored yet"), and a run would have
// reported the page as covered.
//
// The planner prompt now explains the rule. A rule a model can misapply in
// silence needs a gate as well as an explanation, and this is it.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import yaml from "js-yaml";
// @ts-expect-error - plain .mjs sibling package, no types
import { deadCoverageWarnings } from "../fittings/seed/drill/lib/planner.mjs";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "drill-deadcov-"));
  mkdirSync(path.join(root, "drills", "pages"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function page(id: string, steps: Array<Record<string, unknown>>) {
  writeFileSync(
    path.join(root, "drills", "pages", `${id}.yml`),
    yaml.dump({ id, title: id, path: `/${id}`, mode: "steps", areas: [], states: [], steps })
  );
}
const check = (id: string, over: Record<string, unknown> = {}) => ({
  id, area: 0, mode: "vision", enabled: true, viewports: ["desktop"],
  state: "default", description: `check ${id}`, tags: [], judgment: false, ...over
});

describe("deadCoverageWarnings", () => {
  it("flags a page whose every enabled check is scoped to a named state", async () => {
    page("login", [
      check("a", { state: "logged-out" }),
      check("b", { state: "logged-out" }),
      check("c", { state: "error" })
    ]);
    const [warning] = await deadCoverageWarnings(root);
    expect(warning).toMatch(/page "login" runs NOTHING/);
    // The message has to say what to do, not just that something is wrong -
    // "3 checks, none default" is a diagnosis nobody can act on cold.
    expect(warning).toMatch(/logged-out, error/);
    expect(warning).toMatch(/re-scope these to state: default/);
  });

  it("says nothing when at least one check runs by default", async () => {
    // A named state is legitimate for a MINORITY of checks - the page is still
    // covered, so there is nothing to warn about.
    page("chat", [check("a"), check("b", { state: "empty" }), check("c", { state: "populated" })]);
    expect(await deadCoverageWarnings(root)).toEqual([]);
  });

  it("ignores disabled checks when deciding, and flags a page left with none", async () => {
    // A default-state check that is switched off does not run either, so it
    // cannot be what rescues the page.
    page("orphan", [check("a", { enabled: false }), check("b", { state: "modal" })]);
    expect((await deadCoverageWarnings(root))[0]).toMatch(/page "orphan" runs NOTHING/);
    page("empty", [check("a", { enabled: false })]);
    expect((await deadCoverageWarnings(root)).some((w: string) => /page "empty" has no enabled checks/.test(w))).toBe(true);
  });

  it("treats an omitted state as default - page YAML is hand-editable", async () => {
    page("hand", [{ id: "x", area: 0, mode: "vision", enabled: true, description: "d" }]);
    expect(await deadCoverageWarnings(root)).toEqual([]);
  });

  it("returns nothing for a project with no Book at all", async () => {
    expect(await deadCoverageWarnings(path.join(root, "nope"))).toEqual([]);
  });
});
