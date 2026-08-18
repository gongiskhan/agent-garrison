// A card deep link must open the card. Every producer in the fleet (the
// gateway's "Card: ..." reply, Slack, Omi, APNs, drill, the MCP board tools)
// emits `<base>/#/cards/<id>`, while the board only ever read `?card=<id>` —
// so every one of those links opened the board and nothing else. Pure module.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { cardIdFromLocation } from "../fittings/seed/kanban-loop/ui/card-location";

const ID = "01M08G42K2V4RBD4J8VQSMG0SR";

describe("kanban card deep links", () => {
  it("reads the hash shape every producer actually emits", () => {
    expect(cardIdFromLocation({ hash: `#/cards/${ID}` })).toBe(ID);
    // Punctuation differences between producers must not decide whether a link works.
    expect(cardIdFromLocation({ hash: `#cards/${ID}` })).toBe(ID);
    expect(cardIdFromLocation({ hash: `#/cards/${ID}/` })).toBe(ID);
    expect(cardIdFromLocation({ hash: `#/cards/${ID}?from=slack` })).toBe(ID);
  });

  it("still reads the query shape the board writes itself", () => {
    expect(cardIdFromLocation({ search: `?card=${ID}` })).toBe(ID);
    // An explicit pin wins over a stale hash.
    expect(cardIdFromLocation({ search: `?card=${ID}`, hash: "#/cards/other" })).toBe(ID);
  });

  it("decodes an escaped id and survives a malformed escape", () => {
    expect(cardIdFromLocation({ hash: "#/cards/a%20b" })).toBe("a b");
    expect(cardIdFromLocation({ hash: "#/cards/a%zz" })).toBe("a%zz");
  });

  it("points at no card when the location does not name one", () => {
    expect(cardIdFromLocation({})).toBe("");
    expect(cardIdFromLocation({ hash: "#/board" })).toBe("");
    expect(cardIdFromLocation({ hash: "#/cards/" })).toBe("");
    expect(cardIdFromLocation({ search: "?new=1" })).toBe("");
  });

  it("is wired into the board: initial load, later hash navigations, and close", () => {
    const main = readFileSync("fittings/seed/kanban-loop/ui/main.tsx", "utf8");
    // Opening the board straight at a card link.
    expect(main).toContain("const cardId = cardIdFromLocation(window.location);");
    // A hash-only navigation does not reload the document, so the standing board
    // tab only learns about the second and later card links through hashchange.
    expect(main).toContain('window.addEventListener("hashchange", onHashCard);');
    // Closing must drop the card from the url, or re-clicking the SAME link
    // fires no hashchange and nothing opens.
    expect(main).toContain("closeCardOverlay");
  });
});
