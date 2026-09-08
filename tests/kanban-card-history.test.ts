// The board keeps the session history in step with its card overlays, so the
// shell's Back control on the phone closes the card and lands on the board -
// not on whatever page the card was linked from. card-history.ts is the pure
// planner; these pin the plans for every way a card gets opened and closed.
import { describe, expect, it } from "vitest";
import {
  boardUrl,
  cardHistoryPlan,
  cardUrl,
  isCardHistoryState,
  overlayFromHistory,
} from "../fittings/seed/kanban-loop/ui/card-history";

const at = (search = "", hash = "") => ({ pathname: "/", search, hash });
const ours = (kind: "detail" | "conversation", cardId: string, depth: number) => ({ garrisonKanban: { kind, cardId, depth } });

describe("card overlays and the browser's Back", () => {
  it("opening a card from the board pushes one entry of ours", () => {
    expect(cardHistoryPlan({ overlay: { kind: "detail", cardId: "C1" }, state: null, location: at(), mountedWithCard: false }))
      .toEqual([{ op: "push", state: ours("detail", "C1", 1), url: "/?card=C1" }]);
  });

  it("a deep link puts a board entry UNDER the card, so Back is the board", () => {
    expect(cardHistoryPlan({ overlay: { kind: "detail", cardId: "C1" }, state: null, location: at("?card=C1"), mountedWithCard: true }))
      .toEqual([
        { op: "replace", state: null, url: "/" },
        { op: "push", state: ours("detail", "C1", 1), url: "/?card=C1" },
      ]);
    // The hash shape every producer of a card link uses is normalised too.
    expect(cardHistoryPlan({ overlay: { kind: "detail", cardId: "C1" }, state: null, location: at("?x=1", "#/cards/C1"), mountedWithCard: true }))
      .toEqual([
        { op: "replace", state: null, url: "/?x=1" },
        { op: "push", state: ours("detail", "C1", 1), url: "/?x=1&card=C1" },
      ]);
  });

  it("a hash link opened while the board is up claims the entry the browser already pushed", () => {
    expect(cardHistoryPlan({ overlay: { kind: "detail", cardId: "C1" }, state: null, location: at("", "#/cards/C1"), mountedWithCard: false }))
      .toEqual([{ op: "replace", state: ours("detail", "C1", 1), url: "/?card=C1" }]);
  });

  it("the entry we are standing on needs nothing", () => {
    expect(cardHistoryPlan({ overlay: { kind: "detail", cardId: "C1" }, state: ours("detail", "C1", 1), location: at("?card=C1"), mountedWithCard: false }))
      .toEqual([]);
  });

  it("a card leading to another sheet stacks an entry, and closing pops them all", () => {
    expect(cardHistoryPlan({ overlay: { kind: "detail", cardId: "C1" }, state: ours("conversation", "C1", 1), location: at("?card=C1"), mountedWithCard: false }))
      .toEqual([{ op: "push", state: ours("detail", "C1", 2), url: "/?card=C1" }]);
    expect(cardHistoryPlan({ overlay: { kind: "detail", cardId: "C2" }, state: ours("detail", "C1", 2), location: at("?card=C1"), mountedWithCard: false }))
      .toEqual([{ op: "push", state: ours("detail", "C2", 3), url: "/?card=C2" }]);
    expect(cardHistoryPlan({ overlay: null, state: ours("detail", "C2", 3), location: at("?card=C2"), mountedWithCard: false }))
      .toEqual([{ op: "back", depth: 3 }]);
  });

  it("closing a card that nothing of ours put in the URL just strips it", () => {
    expect(cardHistoryPlan({ overlay: null, state: null, location: at("?card=C1&x=1"), mountedWithCard: false }))
      .toEqual([{ op: "replace", state: null, url: "/?x=1" }]);
    expect(cardHistoryPlan({ overlay: null, state: null, location: at(), mountedWithCard: false })).toEqual([]);
  });

  it("popstate turns an entry back into the overlay it stands for", () => {
    expect(overlayFromHistory(at("?card=C1"), ours("conversation", "C1", 1))).toEqual({ kind: "conversation", cardId: "C1" });
    expect(overlayFromHistory(at("", "#/cards/C9"), null)).toEqual({ kind: "detail", cardId: "C9" });
    expect(overlayFromHistory(at(), null)).toBeNull();
    expect(overlayFromHistory(at(), { somebodyElse: true })).toBeNull();
  });

  it("recognises only a well-formed state of ours", () => {
    expect(isCardHistoryState(ours("detail", "C1", 1))).toBe(true);
    expect(isCardHistoryState({ garrisonKanban: { kind: "watch", cardId: "C1", depth: 1 } })).toBe(false);
    expect(isCardHistoryState({ garrisonKanban: { kind: "detail", cardId: "", depth: 1 } })).toBe(false);
    expect(isCardHistoryState({ garrisonKanban: { kind: "detail", cardId: "C1", depth: 0 } })).toBe(false);
    expect(isCardHistoryState(null)).toBe(false);
  });

  it("builds the board's own URL shapes", () => {
    expect(boardUrl(at("?card=C1"))).toBe("/");
    expect(boardUrl(at("?a=1&card=C1&b=2", "#/cards/C1"))).toBe("/?a=1&b=2");
    expect(cardUrl(at("?card=OLD"), "NEW")).toBe("/?card=NEW");
  });
});
