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

  it("keeps Panic in Watch and leads a parked card to an editable routing retry", () => {
    const source = readFileSync(
      path.join(REPO, "fittings/seed/kanban-loop/ui/main.tsx"),
      "utf8"
    );
    const watch = source.slice(source.indexOf("function WatchSheet"), source.indexOf("// ── list-config sheet"));
    const detail = source.slice(source.indexOf("function DetailSheet"), source.indexOf("// ── session transcript view"));

    expect(watch).toContain("api.panic(card.id)");
    expect(watch).toContain("Partial output will be kept but ignored");
    expect(watch).toContain("Review routing &amp; retry");
    // Earlier remote phases stay replayable, so a finished dispatch still opens
    // on the rich Log rather than falling back to Raw.
    expect(watch).toContain('const hasRemoteReplay = Boolean(card.dispatch?.runId || card.dispatchRuns?.length);');
    expect(watch).toContain('const hasSession = card.status === "running" || hasRemoteReplay || (card.sessionIds?.length ?? 0) > 0;');
    expect(watch).toContain('useState<"session" | "raw">(hasSession ? "session" : "raw")');
    expect(watch).toContain('live={card.status === "running" && live !== false && !done}');
    expect(watch).toContain('dispatch={card.dispatch}');
    expect(watch).toContain('dispatchRuns={card.dispatchRuns ?? []}');
    expect(detail).toContain("Save & Retry");
    expect(detail).toContain("initialOpen={parked}");
    expect(detail).toContain("patchCard({ routing:");
  });
});
