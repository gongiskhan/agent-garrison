// The Loadout authoring surface. Until these routes existed, `writeLoadout` had
// no caller outside its own unit test and ~/.garrison/loadouts/ was never
// created — so the dispatch claim route always resolved a null loadout and NO
// dispatched card ever received a materialized checkout. The library was
// complete; nothing could reach it.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "loadout-api-"));
  prevHome = process.env.GARRISON_HOME;
  process.env.GARRISON_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

const VALID = {
  id: "demo-project",
  repo_remote: "https://github.com/gongiskhan/demo.git",
  default_branch: "main",
  setup_commands: ["npm ci"],
  env_vars: ["DEMO_API_KEY", "SHARED_TOKEN"],
  verify_command: "npm test"
};

async function routes() {
  return {
    index: await import("../src/app/api/loadouts/route"),
    byId: await import("../src/app/api/loadouts/[id]/route")
  };
}

function req(body: unknown): Request {
  return new Request("http://localhost/api/loadouts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("loadout authoring API", () => {
  it("round-trips a loadout through POST then GET", async () => {
    const { index } = await routes();
    const created = await (await index.POST(req(VALID) as never)).json();
    expect(created.loadout.id).toBe("demo-project");
    expect(created.loadout.env_vars).toEqual(["DEMO_API_KEY", "SHARED_TOKEN"]);

    const listed = await (await index.GET()).json();
    expect(listed.loadouts.map((l: { id: string }) => l.id)).toEqual(["demo-project"]);
    // Coverage is reported per declared name, presence only.
    expect(listed.coverage["demo-project"].map((c: { name: string }) => c.name))
      .toEqual(["DEMO_API_KEY", "SHARED_TOKEN"]);
  });

  it("rejects an invalid descriptor with field-level errors and writes nothing", async () => {
    const { index } = await routes();
    const res = await index.POST(req({ ...VALID, id: "", env_vars: ["not a valid name"] }) as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors.length).toBeGreaterThan(0);
    const listed = await (await index.GET()).json();
    expect(listed.loadouts).toEqual([]);
  });

  it("authoring works with the vault LOCKED — coverage is unknown, not false", async () => {
    // readVaultSecrets throws on a sealed vault. Letting that escape meant you
    // could not author a Loadout without unlocking, which is backwards: the
    // normal order is declare the names, THEN fill the vault. And reporting
    // `false` would read as "you are missing this value" rather than "unknown".
    const { index } = await routes();
    const res = await index.POST(req(VALID) as never);
    expect(res.status).toBe(200);
    const listed = await (await index.GET()).json();
    expect(listed.coverage["demo-project"].every((c: { present: boolean | null }) => c.present === null)).toBe(true);
  });

  it("dry run reports a locked vault as 409, not a 500", async () => {
    const { index, byId } = await routes();
    await index.POST(req(VALID) as never);
    const res = await byId.GET(
      new Request("http://localhost/api/loadouts/demo-project?dryRun=1"),
      { params: { id: "demo-project" } }
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/locked/i);
    // Even the error path must not leak a rendered .env body.
    expect(JSON.stringify(body)).not.toContain("\"content\"");
  });

  it("404s an unknown id rather than inventing one", async () => {
    const { byId } = await routes();
    const res = await byId.GET(
      new Request("http://localhost/api/loadouts/nope"),
      { params: { id: "nope" } }
    );
    expect(res.status).toBe(404);
  });

  it("deletes only through a resolved descriptor (no raw id reaches the fs)", async () => {
    const { index, byId } = await routes();
    await index.POST(req(VALID) as never);
    const del = await byId.DELETE(
      new Request("http://localhost/api/loadouts/demo-project", { method: "DELETE" }),
      { params: { id: "demo-project" } }
    );
    expect(del.status).toBe(200);
    const listed = await (await index.GET()).json();
    expect(listed.loadouts).toEqual([]);

    // A traversal-shaped id resolves to nothing, so DELETE 404s instead of
    // unlinking something outside the loadouts dir.
    const bad = await byId.DELETE(
      new Request("http://localhost/api/loadouts/x", { method: "DELETE" }),
      { params: { id: "../../../etc/passwd" } }
    );
    expect(bad.status).toBe(404);
  });
});
