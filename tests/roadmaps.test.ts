import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyOp,
  collectIds,
  emptyRoadmapDoc,
  findItemContext,
  markSentToKanban,
  mutateRoadmap,
  nextCategoryId,
  nextItemId,
  projectRoadmap,
  readRoadmapDoc,
  roadmapPathForProject,
  writeRoadmapDoc,
  RoadmapMalformedError,
  RoadmapNotFoundError,
  RoadmapRequestError
} from "@/lib/roadmaps";
import { buildCardDescription, readKanbanBaseUrl, sendItemToKanban } from "@/lib/roadmap-kanban";

const CLI = path.resolve(__dirname, "..", "fittings", "seed", "roadmaps", "scripts", "roadmap.mjs");

let root: string;
let devRoot: string;
let garrisonHome: string;
let previousGarrisonHome: string | undefined;

function makeRepo(name: string): string {
  const dir = path.join(devRoot, name);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  return dir;
}

function seedDoc(): Record<string, unknown> {
  return {
    title: "Roadmap",
    intro: null,
    updatedAt: null,
    categories: [
      {
        id: "f0",
        title: "Phase 0",
        noteRef: "n-f0",
        items: [
          { id: "f0.1", text: "one", done: false, sentToKanban: null, noteRef: null },
          { id: "f0.2", text: "two", done: false, sentToKanban: null, noteRef: null },
          { id: "f0.3", text: "three", done: false, sentToKanban: null, noteRef: null }
        ]
      }
    ],
    notes: [{ id: "n-f0", title: "Phase 0 decisions", body: "why" }]
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gar-roadmaps-"));
  devRoot = path.join(root, "dev");
  garrisonHome = path.join(root, "garrison");
  fs.mkdirSync(devRoot, { recursive: true });
  fs.mkdirSync(garrisonHome, { recursive: true });
  fs.writeFileSync(path.join(garrisonHome, "dev-root"), devRoot, "utf8");
  previousGarrisonHome = process.env.GARRISON_HOME;
  process.env.GARRISON_HOME = garrisonHome;
});

afterEach(() => {
  if (previousGarrisonHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = previousGarrisonHome;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("roadmap location", () => {
  it("resolves a project to roadmap.json at the repo root", () => {
    const repo = makeRepo("ekoa-code");
    expect(roadmapPathForProject("ekoa-code")).toBe(
      path.join(fs.realpathSync(repo), "roadmap.json")
    );
  });

  it("refuses anything that is not a git repo under the dev root", () => {
    makeRepo("ekoa-code");
    fs.writeFileSync(path.join(root, "secret.json"), "{}", "utf8");
    for (const hostile of ["../secret", "/etc/passwd", "..", "nope", ".git"]) {
      expect(() => roadmapPathForProject(hostile), hostile).toThrow(RoadmapNotFoundError);
    }
  });
});

describe("reading", () => {
  it("returns null when there is no roadmap yet", async () => {
    const repo = makeRepo("proj");
    expect(await readRoadmapDoc(path.join(repo, "roadmap.json"))).toBeNull();
  });

  it("refuses to read a broken file rather than treating it as empty", async () => {
    const repo = makeRepo("proj");
    const file = path.join(repo, "roadmap.json");
    fs.writeFileSync(file, "{ not json", "utf8");
    await expect(readRoadmapDoc(file)).rejects.toBeInstanceOf(RoadmapMalformedError);
    fs.writeFileSync(file, "[]", "utf8");
    await expect(readRoadmapDoc(file)).rejects.toBeInstanceOf(RoadmapMalformedError);
    // and the file is untouched
    expect(fs.readFileSync(file, "utf8")).toBe("[]");
  });

  it("projects a document into the typed shape and drops unaddressable entries", () => {
    const doc = seedDoc();
    (doc.categories as unknown[]).push({ title: "no id", items: [] });
    const roadmap = projectRoadmap(doc);
    expect(roadmap.categories).toHaveLength(1);
    expect(roadmap.categories[0].items.map((item) => item.id)).toEqual(["f0.1", "f0.2", "f0.3"]);
    expect(roadmap.notes[0].id).toBe("n-f0");
  });
});

describe("id stability", () => {
  it("continues past the highest id in a category instead of filling a gap", () => {
    const doc = seedDoc();
    applyOp(doc, { op: "delete-item", itemId: "f0.2" });
    expect(nextItemId(doc, "f0")).toBe("f0.4");
    applyOp(doc, { op: "add-item", categoryId: "f0", text: "four" });
    const ids = projectRoadmap(doc).categories[0].items.map((item) => item.id);
    expect(ids).toEqual(["f0.1", "f0.3", "f0.4"]);
  });

  it("never renumbers the survivors of a delete", () => {
    const doc = seedDoc();
    applyOp(doc, { op: "delete-item", itemId: "f0.1" });
    expect(projectRoadmap(doc).categories[0].items.map((item) => item.id)).toEqual([
      "f0.2",
      "f0.3"
    ]);
  });

  it("mints category ids that collide with nothing in the document", () => {
    const doc = seedDoc();
    (doc.categories as unknown[]).push({ id: "c1", title: "taken", items: [] });
    expect(nextCategoryId(doc)).toBe("c2");
    applyOp(doc, { op: "add-category", title: "New" });
    const ids = [...collectIds(doc)];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("operations", () => {
  it("marks done without removing anything", () => {
    const doc = seedDoc();
    applyOp(doc, { op: "set-done", itemId: "f0.2", done: true });
    const items = projectRoadmap(doc).categories[0].items;
    expect(items).toHaveLength(3);
    expect(items[1].done).toBe(true);
    applyOp(doc, { op: "set-done", itemId: "f0.2", done: false });
    expect(projectRoadmap(doc).categories[0].items[1].done).toBe(false);
  });

  it("reports a missing target rather than succeeding silently", () => {
    const doc = seedDoc();
    expect(() => applyOp(doc, { op: "set-done", itemId: "nope", done: true })).toThrow(
      RoadmapNotFoundError
    );
    expect(() => applyOp(doc, { op: "add-item", categoryId: "zz", text: "x" })).toThrow(
      RoadmapNotFoundError
    );
  });

  it("rejects blank text and an unknown operation", () => {
    const doc = seedDoc();
    expect(() => applyOp(doc, { op: "add-item", categoryId: "f0", text: "   " })).toThrow(
      RoadmapRequestError
    );
    expect(() =>
      applyOp(doc, { op: "explode" } as unknown as Parameters<typeof applyOp>[1])
    ).toThrow(RoadmapRequestError);
  });

  it("clears dangling references when a note is deleted", () => {
    const doc = seedDoc();
    applyOp(doc, { op: "delete-note", noteId: "n-f0" });
    expect(projectRoadmap(doc).categories[0].noteRef).toBeNull();
    expect(projectRoadmap(doc).notes).toHaveLength(0);
  });

  it("upserts a note onto an item and links it", () => {
    const doc = seedDoc();
    applyOp(doc, { op: "upsert-note", ownerId: "f0.1", title: "Why", body: "because" });
    const roadmap = projectRoadmap(doc);
    const noteId = roadmap.categories[0].items[0].noteRef;
    expect(noteId).toBe("n-f0.1");
    expect(roadmap.notes.find((note) => note.id === noteId)?.body).toBe("because");
    // A second upsert edits the same note rather than minting a second one.
    applyOp(doc, { op: "upsert-note", ownerId: "f0.1", title: "Why", body: "revised" });
    expect(projectRoadmap(doc).notes).toHaveLength(2);
  });
});

describe("writing", () => {
  it("preserves keys it does not know about", async () => {
    const repo = makeRepo("proj");
    const file = path.join(repo, "roadmap.json");
    const doc = seedDoc();
    doc.owner = "gonçalo";
    (doc.categories as Record<string, unknown>[])[0].colour = "brass";
    await writeRoadmapDoc(file, doc);

    const { doc: after } = await mutateRoadmap(file, (current) =>
      applyOp(current, { op: "set-done", itemId: "f0.1", done: true })
    );
    expect(after.owner).toBe("gonçalo");
    expect((after.categories as Record<string, unknown>[])[0].colour).toBe("brass");
    expect(typeof after.updatedAt).toBe("string");
  });

  it("serializes concurrent mutations instead of losing one", async () => {
    const repo = makeRepo("proj");
    const file = path.join(repo, "roadmap.json");
    await writeRoadmapDoc(file, emptyRoadmapDoc("Roadmap"));
    await mutateRoadmap(file, (doc) => applyOp(doc, { op: "add-category", title: "C" }));
    const categoryId = projectRoadmap((await readRoadmapDoc(file))!).categories[0].id;

    await Promise.all(
      ["a", "b", "c", "d"].map((text) =>
        mutateRoadmap(file, (doc) => applyOp(doc, { op: "add-item", categoryId, text }))
      )
    );

    const roadmap = projectRoadmap((await readRoadmapDoc(file))!);
    const items = roadmap.categories[0].items;
    expect(items.map((item) => item.text).sort()).toEqual(["a", "b", "c", "d"]);
    expect(new Set(items.map((item) => item.id)).size).toBe(4);
  });

  it("refuses to mutate a roadmap that does not exist", async () => {
    const repo = makeRepo("proj");
    await expect(
      mutateRoadmap(path.join(repo, "roadmap.json"), (doc) =>
        applyOp(doc, { op: "set-title", title: "x" })
      )
    ).rejects.toBeInstanceOf(RoadmapNotFoundError);
  });
});

// The CLI (agents' half) and src/lib/roadmaps.ts (the view's half) write the
// same file. Anything they disagree about shows up here, not in a user's repo.
describe("CLI / library agreement", () => {
  function cli(args: string[]): string {
    return execFileSync("node", [CLI, ...args], { encoding: "utf8" }).trim();
  }

  it("probes clean", () => {
    expect(cli(["--probe"])).toBe("ROADMAPS-OK");
  });

  it("mints the same next id as the library after the same edits", async () => {
    const repo = makeRepo("proj");
    const file = path.join(repo, "roadmap.json");
    await writeRoadmapDoc(file, seedDoc());

    // Library deletes from the middle; the CLI must not reuse the freed id.
    await mutateRoadmap(file, (doc) => applyOp(doc, { op: "delete-item", itemId: "f0.2" }));
    expect(cli(["add-item", file, "f0", "from the cli"])).toBe("f0.4");

    // ...and the reverse direction: CLI writes, library continues.
    expect(cli(["add-item", file, "f0", "another"])).toBe("f0.5");
    const { doc } = await mutateRoadmap(file, (current) =>
      applyOp(current, { op: "add-item", categoryId: "f0", text: "from the library" })
    );
    expect(projectRoadmap(doc).categories[0].items.map((item) => item.id)).toEqual([
      "f0.1",
      "f0.3",
      "f0.4",
      "f0.5",
      "f0.6"
    ]);
  });

  it("checks an item the library then reads as done, and validates a library-written file", async () => {
    const repo = makeRepo("proj");
    const file = path.join(repo, "roadmap.json");
    await writeRoadmapDoc(file, seedDoc());

    cli(["check", file, "f0.1"]);
    expect(projectRoadmap((await readRoadmapDoc(file))!).categories[0].items[0].done).toBe(true);
    cli(["uncheck", file, "f0.1"]);
    expect(projectRoadmap((await readRoadmapDoc(file))!).categories[0].items[0].done).toBe(false);

    await mutateRoadmap(file, (doc) => applyOp(doc, { op: "add-category", title: "Later" }));
    expect(cli(["validate", file])).toBe("ok");
  });

  it("validate flags a duplicate id and a dangling note reference", () => {
    const repo = makeRepo("proj");
    const file = path.join(repo, "roadmap.json");
    const doc = seedDoc();
    (doc.categories as Record<string, unknown>[])[0].noteRef = "n-gone";
    ((doc.categories as Record<string, unknown>[])[0].items as unknown[]).push({
      id: "f0.1",
      text: "duplicate",
      done: false
    });
    fs.writeFileSync(file, JSON.stringify(doc, null, 2), "utf8");

    let output = "";
    expect(() => {
      try {
        execFileSync("node", [CLI, "validate", file], { encoding: "utf8", stdio: "pipe" });
      } catch (error) {
        output = String((error as { stderr?: string }).stderr ?? "");
        throw error;
      }
    }).toThrow();
    expect(output).toContain('duplicate id "f0.1"');
    expect(output).toContain("n-gone");
  });
});

describe("kanban bridge", () => {
  it("carries the roadmap reference and the item's note into the card body", () => {
    const doc = seedDoc();
    const context = findItemContext(doc, "f0.1")!;
    const description = buildCardDescription({
      project: "ekoa-code",
      roadmapTitle: "Roadmap",
      categoryTitle: context.categoryTitle,
      item: context.item,
      note: context.note
    });
    expect(description).toContain("roadmap:ekoa-code#f0.1");
    expect(description).toContain("Phase 0");
    // The category's note is inherited by an item that has none of its own.
    expect(description).toContain("why");
  });

  it("reports the board being down instead of failing obscurely", async () => {
    await expect(readKanbanBaseUrl()).rejects.toThrow(/not running/);
  });

  it("creates the card, moves it to To Do, and stamps the item", async () => {
    const requests: { method: string; url: string; body: unknown }[] = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : null;
        requests.push({ method: req.method ?? "", url: req.url ?? "", body });
        res.setHeader("content-type", "application/json");
        if (req.url === "/lists") {
          res.end(JSON.stringify({ lists: [{ id: "backlog" }, { id: "todo" }] }));
          return;
        }
        if (req.url === "/cards" && req.method === "POST") {
          res.statusCode = 201;
          res.end(JSON.stringify({ card: { id: "01ROADMAPCARD00000000000000" } }));
          return;
        }
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    fs.mkdirSync(path.join(garrisonHome, "ui-fittings"), { recursive: true });
    fs.writeFileSync(
      path.join(garrisonHome, "ui-fittings", "kanban-loop.json"),
      JSON.stringify({ fittingId: "kanban-loop", port, url: `http://127.0.0.1:${port}` }),
      "utf8"
    );

    try {
      const doc = seedDoc();
      const context = findItemContext(doc, "f0.1")!;
      const result = await sendItemToKanban({
        project: "proj",
        roadmapTitle: "Roadmap",
        categoryTitle: context.categoryTitle,
        item: context.item,
        note: context.note,
        list: "todo"
      });
      expect(result.cardId).toBe("01ROADMAPCARD00000000000000");

      const create = requests.find((entry) => entry.url === "/cards");
      expect((create?.body as { project?: string })?.project).toBe("proj");
      expect((create?.body as { origin?: string })?.origin).toBe("roadmap");
      const move = requests.find((entry) => entry.method === "PATCH");
      expect(move?.url).toBe("/cards/01ROADMAPCARD00000000000000");
      expect((move?.body as { list?: string })?.list).toBe("todo");

      markSentToKanban(doc, "f0.1", "todo", result.cardId);
      const item = projectRoadmap(doc).categories[0].items[0];
      expect(item.sentToKanban).toBe("todo");
      expect(item.kanbanCardId).toBe(result.cardId);
      expect(item.sentToKanbanAt).toBeTruthy();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("refuses a target list the board does not have, before creating anything", async () => {
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ lists: [{ id: "backlog" }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    fs.mkdirSync(path.join(garrisonHome, "ui-fittings"), { recursive: true });
    fs.writeFileSync(
      path.join(garrisonHome, "ui-fittings", "kanban-loop.json"),
      JSON.stringify({ url: `http://127.0.0.1:${port}` }),
      "utf8"
    );

    try {
      const doc = seedDoc();
      const context = findItemContext(doc, "f0.1")!;
      await expect(
        sendItemToKanban({
          project: "proj",
          roadmapTitle: "Roadmap",
          categoryTitle: context.categoryTitle,
          item: context.item,
          note: context.note,
          list: "todo"
        })
      ).rejects.toThrow(/has no "todo" list/);
      expect(requests.some((entry) => entry.startsWith("POST /cards"))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
