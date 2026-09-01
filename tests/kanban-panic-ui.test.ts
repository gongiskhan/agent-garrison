import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { api } from "../fittings/seed/kanban-loop/ui/api";

const REPO = path.resolve(__dirname, "..");

afterEach(() => vi.unstubAllGlobals());

describe("Kanban Watch Panic UI", () => {
  it("posts to the card-specific Panic route", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      stopped: true,
      lane: "agent-sdk",
      affectedCardIds: ["CARD-1"],
      sharedBatch: false,
      message: "Stop sent."
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await api.panic("CARD/1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("/cards/CARD%2F1/panic");
    expect(call[1]).toMatchObject({ method: "POST" });
  });

  it("surfaces the server's actionable Panic message on a refused stop", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "active-turn-belongs-to-another-card",
      message: "This card is queued behind another active turn. Nothing else was stopped."
    }), { status: 409, headers: { "content-type": "application/json" } })));

    await expect(api.panic("CARD-2")).rejects.toThrow(
      "This card is queued behind another active turn. Nothing else was stopped."
    );
  });

  it("keeps Panic on the raw log and leads a parked card to an editable routing retry", () => {
    const source = readFileSync(
      path.join(REPO, "fittings/seed/kanban-loop/ui/main.tsx"),
      "utf8"
    );
    const watch = source.slice(source.indexOf("function WatchSheet"), source.indexOf("// ── list-config sheet"));
    const detail = source.slice(source.indexOf("function DetailSheet"), source.indexOf("// ── terminal modal"));

    expect(watch).toContain("api.panic(card.id)");
    expect(watch).toContain("Partial output will be kept but ignored");
    expect(watch).toContain("Review routing &amp; retry");
    // The sheet is the RAW layer now: the rich account of a card's work is its
    // conversation, rendered in the opened card, so the tab strip and the
    // transcript picker under it are gone and the phase log is the whole body.
    expect(watch).toContain('<Sheet title={`Raw log: ${card.title}`}');
    expect(watch).toContain('className="wscr"');
    expect(watch).not.toContain("SessionViewer");
    expect(watch).not.toContain('setTab(');
    expect(source).not.toContain("function SessionViewer");
    expect(detail).toContain("Save & Retry");
    // 2026-08-31 card work: run configuration folded into a Section that a
    // parked card opens by default, wearing the attention tone.
    expect(detail).toContain("defaultOpen={parked}");
    expect(detail).toContain("patchCard({ routing:");
  });

  // The card modal's conversation surface: rendered for a conversation-linked
  // card, and ONLY for one - a legacy card frozen before the pivot has no ledger
  // to read, so its runDir evidence block is the only proof it has and stays.
  it("renders the conversation for a conversation-linked card and keeps legacy evidence for the rest", () => {
    const source = readFileSync(
      path.join(REPO, "fittings/seed/kanban-loop/ui/main.tsx"),
      "utf8"
    );
    const detail = source.slice(source.indexOf("function DetailSheet"), source.indexOf("// ── terminal modal"));

    expect(detail).toContain("const conversationId = card.conversationId ?? null;");
    expect(detail).toContain("{conversationId && (");
    expect(detail).toContain("<CardConversation");
    // The evidence block survives, gated on NOT having a conversation.
    expect(detail).toContain("const showEvidence = !conversationId &&");
    expect(detail).toContain('<div className="evidence">');
    // Every action the card offered still hangs off the same shared row, and the
    // danger zone with it.
    expect(detail).toContain("<CardActions card={card} list={cardList} busy={false} withId handlers={actions} />");
    expect(detail).toContain('<div className="danger-zone">');
  });
});
