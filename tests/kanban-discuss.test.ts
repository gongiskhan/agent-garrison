// Unit tests for the kanban-loop Discuss (interactive) plumbing — discuss.mjs.
// Covers: buildDiscussUrl encodes mode=james + an OPAQUE context blob that
// round-trips back to { cardId, title, … } using the SAME decode logic the
// generic web channel uses (proving the channel needs no kanban knowledge);
// briefSlug kebabs a title; recordBrief CAS-links a brief PATH onto the card and
// REJECTS a `..`/absolute escape; and the manual-advance contract — a Discuss
// card run through the engine's processCard is SKIPPED (interactive), so Discuss
// never auto-advances. Hermetic: a per-test tmpdir, no live socket.

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs
import { buildDiscussUrl, briefSlug, briefRelPath, recordBrief, isSafeBriefPath } from "../fittings/seed/kanban-loop/scripts/discuss.mjs";
// @ts-ignore — pure .mjs
import { createCard, loadCard } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — pure .mjs
import { processCard, isInteractive, getList } from "../fittings/seed/kanban-loop/lib/engine.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "kanban-discuss-"));

// A FAITHFUL copy of the web-channel's decodeContext (web-channel-default/ui/
// main.tsx): un-wrap a base64 transport layer iff it round-trips, else forward
// the (already url-decoded) string verbatim. This is the channel's ONLY handling
// of context — it never JSON-parses or inspects it, proving the blob is opaque to
// the channel and only James (downstream) interprets it.
function channelDecodeContext(raw: string | null): unknown {
  if (!raw) return undefined;
  try {
    const decoded = atob(raw);
    if (btoa(decoded) === raw) return decoded; // genuine base64 wrapper → unwrap
  } catch {
    /* not base64 — forward verbatim */
  }
  return raw;
}

describe("kanban discuss — buildDiscussUrl (generic web-channel contract)", () => {
  it("encodes mode=james and an opaque context the channel can decode without kanban knowledge", () => {
    const card = { id: "01HZX5K3QABCDEFGHJKMNPQRS0", title: "Add a Discuss brief", project: "garrison" };
    const url = buildDiscussUrl(card);

    // The URL targets the web channel in James mode via Garrison's embed route.
    // The seed web-channel fitting id is `web-channel-default` (the /embed/<id>).
    expect(url.startsWith("/embed/web-channel-default?")).toBe(true);
    const q = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect(q.get("mode")).toBe("james");

    // The channel does exactly two things with `context`: URLSearchParams
    // url-decodes it, then decodeContext un-wraps the base64 transport layer.
    // What comes out is our JSON STRING — the channel never parses it.
    const rawContext = q.get("context");
    expect(rawContext).toBeTruthy();
    const forwarded = channelDecodeContext(rawContext);
    expect(typeof forwarded).toBe("string");

    // Only downstream (James) parses the blob — and it round-trips to the card.
    const ctx = JSON.parse(forwarded as string);
    expect(ctx).toMatchObject({
      source: "kanban",
      cardId: "01HZX5K3QABCDEFGHJKMNPQRS0",
      title: "Add a Discuss brief",
      project: "garrison"
    });
    expect(ctx.briefsPath).toBe("./briefs/");
    // CARD-UNIQUE stem: <cardId>-<slug> (so two same-titled cards never collide).
    expect(ctx.suggestedSlug).toBe("01HZX5K3QABCDEFGHJKMNPQRS0-add-a-discuss-brief");
  });

  it("honors a custom webChannelBase + briefsPath", () => {
    const card = { id: "01HZX5K3QABCDEFGHJKMNPQRS0", title: "X", project: null };
    const url = buildDiscussUrl(card, { webChannelBase: "/fitting/web-channel/", briefsPath: "docs/briefs/" });
    expect(url.startsWith("/fitting/web-channel?mode=james&context=")).toBe(true);
    const q = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    const ctx = JSON.parse(channelDecodeContext(q.get("context")) as string);
    expect(ctx.briefsPath).toBe("docs/briefs/");
    expect(ctx.project).toBe(null);
  });
});

describe("kanban discuss — briefSlug", () => {
  it("kebabs a title into a clean filename stem", () => {
    expect(briefSlug({ title: "Wire the Discuss list to James" })).toBe("wire-the-discuss-list-to-james");
    expect(briefSlug({ title: "  Spaces & Symbols!! @#$  " })).toBe("spaces-symbols");
    expect(briefSlug({ title: "" })).toBe("brief");
    expect(briefSlug({})).toBe("brief");
  });
});

describe("kanban discuss — isSafeBriefPath", () => {
  it("accepts a relative path and rejects `..` / absolute escapes", () => {
    expect(isSafeBriefPath("briefs/add-a-thing.md")).toBe(true);
    expect(isSafeBriefPath("./briefs/add-a-thing.md")).toBe(true);
    expect(isSafeBriefPath("../secret.md")).toBe(false);
    expect(isSafeBriefPath("briefs/../../etc/passwd")).toBe(false);
    expect(isSafeBriefPath("/etc/passwd")).toBe(false);
    expect(isSafeBriefPath("C:\\Windows\\System32")).toBe(false);
    expect(isSafeBriefPath("")).toBe(false);
    expect(isSafeBriefPath(null as unknown as string)).toBe(false);
  });

  it("CONTAINS the brief under briefsPath — a relative path elsewhere in the project is rejected", () => {
    // These are relative + have no `..`, but are NOT under ./briefs/ → rejected,
    // so the brief link can never point at an arbitrary project file.
    expect(isSafeBriefPath("package.json")).toBe(false);
    expect(isSafeBriefPath("docs/architecture.md")).toBe(false);
    expect(isSafeBriefPath("other-dir/file.md")).toBe(false);
    expect(isSafeBriefPath("briefs")).toBe(false); // the dir itself, not a file under it
    // A custom briefsPath confines accordingly.
    expect(isSafeBriefPath("docs/briefs/x.md", "docs/briefs/")).toBe(true);
    expect(isSafeBriefPath("briefs/x.md", "docs/briefs/")).toBe(false);
  });
});

describe("kanban discuss — recordBrief (link, never duplicate)", () => {
  it("CAS-sets card.briefPath to the relative pointer (never inlines the brief)", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "Discuss me", list: "discuss" });
    const briefPath = `briefs/${briefSlug(card)}.md`;

    const updated = await recordBrief(root, card.id, briefPath);
    expect(updated.briefPath).toBe(briefPath);
    expect(updated.rev).toBe((card.rev ?? 0) + 1);

    // Persisted: a fresh read sees the linked pointer.
    const disk = await loadCard(root, card.id);
    expect(disk.briefPath).toBe(briefPath);
    // It is a POINTER — no brief BODY is stored on the card.
    expect(disk).not.toHaveProperty("brief");
  });

  it("rejects a `..` escape and an absolute path", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "Discuss me", list: "discuss" });
    await expect(recordBrief(root, card.id, "../../escape.md")).rejects.toThrow(/unsafe brief path/);
    await expect(recordBrief(root, card.id, "/etc/passwd")).rejects.toThrow(/unsafe brief path/);
    // The card stays clean — no briefPath was recorded.
    const disk = await loadCard(root, card.id);
    expect(disk.briefPath).toBe(null);
  });

  it("rejects a non-ULID card id before touching the filesystem", async () => {
    const root = tmp();
    await expect(recordBrief(root, "../evil", "briefs/x.md")).rejects.toThrow(/invalid card id/);
  });
});

describe("kanban discuss — manual-advance contract (never auto-dispatched)", () => {
  // The discuss list mirrors seedBoard()'s shape: kind agent-interactive, manual
  // trigger, interactive true. The engine must SKIP it.
  const board = {
    version: 2,
    lists: [
      {
        id: "discuss", title: "Discuss", kind: "agent-interactive", trigger: "manual",
        interactive: true, mode: "james", surface: "web-channel", validNext: ["plan"]
      },
      { id: "plan", title: "Plan", kind: "agent", trigger: "immediate", validNext: ["implement"] }
    ]
  };

  it("isInteractive is true for the discuss list", () => {
    expect(isInteractive(getList(board, "discuss"))).toBe(true);
  });

  it("processCard skips a discuss card with status=skipped reason=interactive (no advance)", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "Talk it through", list: "discuss" });
    let dispatched = false;
    const runFn = async () => { dispatched = true; return { reply: "plan" }; };

    const { card: after, outcome } = await processCard({ root, board, card, runFn, cap: 10 });

    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toBe("interactive");
    expect(dispatched).toBe(false);     // the engine never dispatched it
    expect(after.list).toBe("discuss"); // it did NOT advance — manual Move only
    // Untouched on disk: no iteration consumed, no runId minted.
    const disk = await loadCard(root, card.id);
    expect(disk.list).toBe("discuss");
    expect(disk.iterations).toBe(0);
    expect(disk.runId).toBe(null);
  });
});

describe("kanban discuss — briefRelPath (the CARD-UNIQUE auto-link convention)", () => {
  // The board auto-links a Discuss brief on Move-out-of-Discuss by looking for the
  // file at this exact path — the SAME (briefsPath, suggestedSlug=briefStem) that
  // buildDiscussUrl hands the channel. The two must agree or the auto-link misses,
  // and the stem must be card-unique or one card can grab another's brief.
  it("is <briefsDir>/<cardId>-<slug>.md and matches the suggestedSlug buildDiscussUrl sends", () => {
    const card = { id: "01HZX5K3QABCDEFGHJKMNPQRS0", title: "Add SSO" };
    expect(briefRelPath(card)).toBe("briefs/01HZX5K3QABCDEFGHJKMNPQRS0-add-sso.md");
    // The path stem equals what buildDiscussUrl advertised as suggestedSlug.
    const ctxSlug = JSON.parse(channelDecodeContext(
      new URLSearchParams(buildDiscussUrl(card).split("?")[1]).get("context")
    ) as string).suggestedSlug;
    expect(briefRelPath(card)).toBe(`briefs/${ctxSlug}.md`);
  });

  it("two cards with the SAME title but different ids get DIFFERENT brief paths (no cross-link)", () => {
    const a = { id: "01HZX5K3QABCDEFGHJKMNPQRS0", title: "Fix login" };
    const b = { id: "01HZX5K3QZZZZZZZZZZZZZZZZ9", title: "Fix login" };
    expect(briefSlug(a)).toBe(briefSlug(b));                 // same title → same slug
    expect(briefRelPath(a)).not.toBe(briefRelPath(b));       // but DIFFERENT brief paths
    expect(briefRelPath(a)).toContain(a.id);
    expect(briefRelPath(b)).toContain(b.id);
  });

  it("normalises the briefsPath (leading ./, trailing /) to a clean relative path", () => {
    const card = { id: "01HZX5K3QABCDEFGHJKMNPQRS0", title: "My Feature" };
    expect(briefRelPath(card, { briefsPath: "./briefs/" })).toBe("briefs/01HZX5K3QABCDEFGHJKMNPQRS0-my-feature.md");
    expect(briefRelPath(card, { briefsPath: "briefs" })).toBe("briefs/01HZX5K3QABCDEFGHJKMNPQRS0-my-feature.md");
  });

  it("is traversal-free by construction (cardId is a ULID, briefSlug kebabs the title)", () => {
    const card = { id: "01HZX5K3QABCDEFGHJKMNPQRS0", title: "../../etc/passwd injection" };
    const rel = briefRelPath(card);
    expect(rel.includes("..")).toBe(false);
    expect(rel.startsWith("briefs/")).toBe(true);
  });
});
