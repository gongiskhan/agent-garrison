import { describe, it, expect } from "vitest";
import { joinDictation, stripDictation } from "../packages/talk/ui/voice-conversation";

// D49 - the composer mic dictates into the message box. The two pure helpers
// decide how an utterance lands in the draft and how Discard takes it back out.

describe("joinDictation", () => {
  it("starts an empty draft with the utterance, trimmed", () => {
    expect(joinDictation("", "  hello there ")).toBe("hello there");
  });
  it("puts one space between the draft and the utterance", () => {
    expect(joinDictation("fix the login", "on iOS")).toBe("fix the login on iOS");
  });
  it("adds no space when the draft already ends in whitespace", () => {
    expect(joinDictation("fix the login ", "on iOS")).toBe("fix the login on iOS");
    expect(joinDictation("first line\n", "second")).toBe("first line\nsecond");
  });
  it("ignores empty utterances", () => {
    expect(joinDictation("keep", "   ")).toBe("keep");
  });
});

describe("stripDictation", () => {
  it("restores the base when nothing else was typed", () => {
    const base = "typed before";
    const segs = ["spoken one", "spoken two"];
    const current = segs.reduce((acc, s) => joinDictation(acc, s), base);
    expect(current).toBe("typed before spoken one spoken two");
    expect(stripDictation(current, base, segs)).toBe(base);
  });
  it("restores an empty base to empty", () => {
    expect(stripDictation("spoken", "", ["spoken"])).toBe("");
  });
  it("removes each segment still present when the user edited around them", () => {
    const out = stripDictation("typed spoken one and more spoken two!", "typed", ["spoken one", "spoken two"]);
    expect(out).toBe("typed and more !");
  });
  it("leaves the draft alone when nothing was dictated", () => {
    expect(stripDictation("whatever", "base", [])).toBe("whatever");
  });
});
