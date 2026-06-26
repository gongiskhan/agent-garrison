// V1d: deleting a card removes the card's own storage (cards/<id>/ — card.json + logs).
// The server's DELETE handler additionally removes the card's run dir + brief (confined)
// and never touches shared transcripts; that confinement is covered by the live check.
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs
import { createCard, loadCard, appendCardLog, deleteCard } from "../fittings/seed/kanban-loop/lib/board.mjs";

describe("v1d deleteCard — removes the card's own directory + logs", () => {
  it("deletes cards/<id>/ (card.json + log files) and makes the card unloadable", async () => {
    const root = mkdtempSync(join(tmpdir(), "kanban-del-"));
    const a = await createCard(root, { title: "delete me", list: "plan" });
    const b = await createCard(root, { title: "keep me", list: "todo" });
    await appendCardLog(root, a.id, 1, "# iteration 1\nsome output\n");
    expect(existsSync(join(root, "cards", a.id, "card.json"))).toBe(true);
    expect(existsSync(join(root, "cards", a.id, "log-1.md"))).toBe(true);

    const ok = await deleteCard(root, a.id);
    expect(ok).toBe(true);
    expect(existsSync(join(root, "cards", a.id))).toBe(false);          // dir gone
    await expect(loadCard(root, a.id)).rejects.toThrow();               // unloadable
    // a sibling card is untouched
    expect((await loadCard(root, b.id)).title).toBe("keep me");
  });

  it("is idempotent — deleting a missing card is a no-op", async () => {
    const root = mkdtempSync(join(tmpdir(), "kanban-del2-"));
    await deleteCard(root, "01HZX5K3QABCDEFGHJKMNPQRS0"); // never created — must not throw
    expect(true).toBe(true);
  });
});
