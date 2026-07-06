import { describe, it, expect } from "vitest";
import { isStopPhrase, classifyStandbyUtterance } from "../fittings/seed/jarvis-os/ui/voice-phrases";

describe("isStopPhrase", () => {
  it("matches stop utterances (PT + EN)", () => {
    for (const s of ["desliga", "desliga-te", "jarvis, para de ouvir", "vai dormir", "adeus", "até logo", "stop listening", "go to sleep", "standby"]) {
      expect(isStopPhrase(s)).toBe(true);
    }
  });
  it("does not match ordinary speech (incl. 'para' mid-sentence)", () => {
    for (const s of ["que horas são", "cria um card para arranjar o login", "liga as luzes da sala", ""]) {
      expect(isStopPhrase(s)).toBe(false);
    }
  });
});

describe("classifyStandbyUtterance", () => {
  it("ignores an utterance not addressed to Jarvis", () => {
    expect(classifyStandbyUtterance("que horas são")).toEqual({ kind: "ignore" });
    expect(classifyStandbyUtterance("liga as luzes")).toEqual({ kind: "ignore" });
  });

  it("wakes with no query on a bare wake phrase (incl. mis-hearings)", () => {
    expect(classifyStandbyUtterance("hey jarvis")).toEqual({ kind: "wake", query: "" });
    expect(classifyStandbyUtterance("jarvis")).toEqual({ kind: "wake", query: "" });
    expect(classifyStandbyUtterance("jervis")).toEqual({ kind: "wake", query: "" });
  });

  it("wakes and carries the trailing query", () => {
    expect(classifyStandbyUtterance("hey jarvis, que horas são?")).toEqual({ kind: "wake", query: "que horas são?" });
    expect(classifyStandbyUtterance("olá jarvis liga as luzes")).toEqual({ kind: "wake", query: "liga as luzes" });
  });

  it("stays dormant when the wake is followed by a stop phrase", () => {
    expect(classifyStandbyUtterance("jarvis desliga")).toEqual({ kind: "stay-dormant" });
    expect(classifyStandbyUtterance("jarvis para de ouvir")).toEqual({ kind: "stay-dormant" });
  });
});
