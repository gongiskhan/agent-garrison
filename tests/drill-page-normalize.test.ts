// A page file is hand-editable AND agent-authored, so it arrives with only the
// keys its writer thought were worth writing. A page with no named states has
// no `states:` key - which is exactly what the planner tells the agent to do.
//
// Every reader then has to cope, and the Book table did not: `p.states.length`
// on a freshly planned Book took the whole Drill Book page down to a blank
// screen with "Cannot read properties of undefined (reading 'length')". These
// pin the fix at the read boundary, so "absent means empty" is true for every
// consumer instead of a rule each one has to remember.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import yaml from "js-yaml";
import { listPages, getPage, savePage } from "../fittings/seed/drill/lib/store.mjs";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "drill-store-"));
  mkdirSync(path.join(root, "drills", "pages"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const write = (id: string, body: string) =>
  writeFileSync(path.join(root, "drills", "pages", `${id}.yml`), body);

describe("page reads normalise the optional collections", () => {
  // Exactly the shape the plan agent authors for a page with nothing stateful
  // about it: steps, and no areas/states keys at all.
  const minimal = `id: automations
title: Automatizações
path: /automations
mode: steps
steps:
  - id: heading-visible
    area: 0
    mode: e2e
    enabled: true
    description: The heading is shown.
`;

  it("getPage fills in the absent collections", async () => {
    write("automations", minimal);
    const page = await getPage("automations", root);
    expect(page.states).toEqual([]);
    expect(page.areas).toEqual([]);
    expect(page.steps).toHaveLength(1);
  });

  it("listPages fills them in too - the Book table reads through this one", async () => {
    write("automations", minimal);
    write("chat", `id: chat\ntitle: Chat\npath: /chat\nmode: steps\n`);
    const pages = await listPages(root);
    expect(pages).toHaveLength(2);
    for (const page of pages) {
      expect(Array.isArray(page.areas)).toBe(true);
      expect(Array.isArray(page.steps)).toBe(true);
      expect(Array.isArray(page.states)).toBe(true);
    }
  });

  it("coerces a non-array rather than trusting a hand-edit", async () => {
    write("broken", `id: broken\ntitle: B\npath: /b\nmode: steps\nstates: not-a-list\nsteps: 7\n`);
    const page = await getPage("broken", root);
    expect(page.states).toEqual([]);
    expect(page.steps).toEqual([]);
  });

  it("returns null for a page that does not exist", async () => {
    expect(await getPage("nope", root)).toBeNull();
  });

  it("saving does NOT write the filled-in keys back into the file", async () => {
    // Normalisation is for readers. Merging a save from it would add
    // `states: []` and `areas: []` to every page that deliberately omitted
    // them - churning the user's repo to say nothing.
    write("automations", minimal);
    await savePage("automations", { title: "Automatizações (list)" }, root);
    const raw: any = yaml.load(readFileSync(path.join(root, "drills", "pages", "automations.yml"), "utf8"));
    expect(raw.title).toBe("Automatizações (list)");
    expect("states" in raw).toBe(false);
    expect("areas" in raw).toBe(false);
    // ...and a reader still sees them.
    expect((await getPage("automations", root)).states).toEqual([]);
  });
});
