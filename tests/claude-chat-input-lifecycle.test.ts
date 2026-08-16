import { describe, expect, it } from "vitest";
import {
  applyGeneratedTurn,
  applyInputLifecycle,
  findGeneratedTurnIndex,
  inputLifecycleAnnouncement,
  isActiveInputState,
  isPendingInputState,
  type GeneratedTurnState,
} from "../packages/claude-chat/src/ClaudeChat";
import { isChatInputReceipt, type ChatInputReceipt } from "../packages/claude-chat/src/transport";

interface TestTurn extends GeneratedTurnState {
  user: string;
  assistant: string;
}

const optimistic = (clientRequestId: string, user: string, state: "starting" | "queued"): TestTurn => ({
  clientRequestId,
  user,
  assistant: "",
  streaming: state === "starting",
  inputState: state,
});

const lifecycle = (
  clientRequestId: string,
  inputId: string,
  state: ChatInputReceipt["state"],
  extra: Partial<ChatInputReceipt> = {}
): ChatInputReceipt => ({ clientRequestId, inputId, state, ...extra });

describe("generated input lifecycle reducer", () => {
  it("binds receipts and every later frame to the exact turn, never the trailing queue item", () => {
    let turns = [
      optimistic("client-1", "first", "starting"),
      { ...optimistic("client-2", "second", "queued"), inputPosition: 1 },
    ];

    turns = applyInputLifecycle(turns, lifecycle("client-1", "input-1", "running", {
      generationId: "generation-1",
    }));
    expect(turns[0]).toMatchObject({ inputId: "input-1", generationId: "generation-1", inputState: "running" });
    expect(turns[1]).toMatchObject({ clientRequestId: "client-2", inputState: "queued", assistant: "" });

    turns = applyGeneratedTurn(
      turns,
      { inputId: "input-1", generationId: "generation-1" },
      (turn) => ({ ...turn, assistant: "late frame for the first generation" })
    );
    expect(turns.map((turn) => turn.assistant)).toEqual(["late frame for the first generation", ""]);

    const untouched = applyGeneratedTurn(
      turns,
      { inputId: "missing", generationId: "missing" },
      (turn) => ({ ...turn, assistant: "wrong" })
    );
    expect(untouched).toBe(turns);

    const replayBound = applyGeneratedTurn(
      [{ ...optimistic("client-replay", "replayed", "queued"), inputId: "input-replay" }],
      { inputId: "input-replay", generationId: "generation-replay" },
      (turn) => ({ ...turn, assistant: "retained tail frame" })
    );
    expect(replayBound[0]).toMatchObject({
      inputId: "input-replay",
      generationId: "generation-replay",
      assistant: "retained tail frame",
    });
  });

  it("lets the first host receipt replace an optimistic state, then rejects stale regressions", () => {
    let turns = [optimistic("client-1", "first", "starting")];
    turns = applyInputLifecycle(turns, lifecycle("client-1", "input-1", "queued", { position: 3 }));
    expect(turns[0]).toMatchObject({ inputState: "queued", inputPosition: 3, streaming: false });

    turns = applyInputLifecycle(turns, lifecycle("client-1", "input-1", "running", {
      generationId: "generation-1",
    }));
    turns = applyInputLifecycle(turns, lifecycle("client-1", "input-1", "stopped", {
      generationId: "generation-1",
      reason: "user requested",
    }));
    const terminal = turns;

    turns = applyInputLifecycle(turns, lifecycle("client-1", "input-1", "starting", {
      generationId: "generation-1",
    }));
    expect(turns).toBe(terminal);
    expect(turns[0]).toMatchObject({ inputState: "stopped", inputReason: "user requested", streaming: false });
  });

  it("clears a stop failure for every terminal lifecycle state", () => {
    for (const state of ["settled", "stopped", "failed"] as const) {
      const turns = applyInputLifecycle(
        [{
          ...optimistic("client-1", "first", "starting"),
          inputId: "input-1",
          generationId: "generation-1",
          inputState: "running" as const,
          stopError: "interrupt unavailable",
        }],
        lifecycle("client-1", "input-1", state, { generationId: "generation-1" })
      );
      expect(turns[0]).toMatchObject({ inputState: state, streaming: false });
      expect(turns[0].stopError).toBeUndefined();
    }
  });

  it("drops conflicting or duplicated durable identities instead of guessing", () => {
    const turns = [
      { ...optimistic("client-1", "first", "starting"), inputState: "running" as const, inputId: "input-1", generationId: "generation-1" },
      { ...optimistic("client-2", "second", "queued"), inputId: "input-2" },
    ];
    expect(findGeneratedTurnIndex(turns, { clientRequestId: "client-1", inputId: "input-2" })).toBe(-1);
    expect(findGeneratedTurnIndex(turns, { inputId: "input-1", generationId: "generation-other" })).toBe(-1);
    expect(applyInputLifecycle(turns, lifecycle("client-1", "input-2", "running"))).toBe(turns);

    const duplicated = [...turns, { ...turns[1] }];
    expect(findGeneratedTurnIndex(duplicated, { inputId: "input-2" })).toBe(-1);
  });

  it("binds a newly stamped generation without allowing a conflicting rebind", () => {
    const turns = [{
      ...optimistic("client-1", "first", "starting"),
      inputId: "input-1",
    }];
    const bound = applyGeneratedTurn(
      turns,
      { inputId: "input-1", generationId: "generation-1" },
      (turn) => ({ ...turn, assistant: "first frame" })
    );
    expect(bound[0]).toMatchObject({ generationId: "generation-1", assistant: "first frame" });

    const conflict = applyGeneratedTurn(
      bound,
      { inputId: "input-1", generationId: "generation-other" },
      (turn) => ({ ...turn, assistant: "must not land" })
    );
    expect(conflict).toBe(bound);
    expect(conflict[0].assistant).toBe("first frame");
  });

  it("validates receipts and exposes compact, bounded lifecycle announcements", () => {
    expect(isChatInputReceipt({ clientRequestId: "c", inputId: "i", state: "queued" })).toBe(true);
    expect(isChatInputReceipt({ clientRequestId: "c", inputId: "i", state: "waiting" })).toBe(false);
    expect(isChatInputReceipt({ clientRequestId: "", inputId: "i", state: "queued" })).toBe(false);
    expect(isChatInputReceipt({ clientRequestId: "c", inputId: "i", state: "running", generationId: 42 })).toBe(false);
    expect(isChatInputReceipt({ clientRequestId: "c", inputId: "i", state: "queued", position: -1 })).toBe(false);

    expect(inputLifecycleAnnouncement({ state: "queued", position: 2 })).toBe("Message queued, position 2.");
    expect(inputLifecycleAnnouncement({ state: "running" })).toBe("Response started.");
    expect(inputLifecycleAnnouncement({ state: "stopped" })).toBe("Response stopped.");
    const failed = inputLifecycleAnnouncement({ state: "failed", reason: `  ${"x".repeat(200)}  ` });
    expect(failed).toMatch(/^Message failed: x+/);
    expect(failed.length).toBeLessThan(150);

    expect(isActiveInputState("running")).toBe(true);
    expect(isActiveInputState("queued")).toBe(false);
    expect(isPendingInputState("queued")).toBe(true);
    expect(isPendingInputState("settled")).toBe(false);
  });
});
