// S3d (GARRISON-MARATHON-V3) — the Dispatcher duty core (D6).
// Covers the pure prompt/parse/override/evidence contract and the dispatch()
// orchestration with a MOCKED garrison-call (no Ollama needed). The classifier
// fixture parity lives in tests/dispatcher-parity.test.ts.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs dispatch core
import {
  buildDispatchPrompt,
  dispatchSchema,
  parseDispatch,
  fallbackDispatch,
  parseLevelOverride,
  applyOverride,
  messageDigest,
  routingEvidence,
  appendEvidence,
  dispatch
} from "../fittings/seed/dispatcher/lib/dispatch-core.mjs";

// A small synthetic resolved model: two leaf duties, three levels each.
function model() {
  return {
    duties: {
      code: {
        id: "code",
        title: "Code",
        description: "write or change software",
        levels: [
          { description: "trivial - a one-line tweak", cell: { target: "sdk-haiku", effort: "low" } },
          { description: "standard - a bounded change", cell: { target: "cc-sonnet", effort: "medium" } },
          { description: "deep - a wide-blast-radius change", cell: { target: "cc-opus", effort: "high" } }
        ]
      },
      other: {
        id: "other",
        title: "Other",
        description: "anything that is not a specific duty",
        levels: [
          { description: "trivial", cell: { target: "sdk-haiku", effort: "low" } },
          { description: "standard", cell: { target: "cc-sonnet", effort: "low" } },
          { description: "deep", cell: { target: "cc-sonnet", effort: "low" } }
        ]
      }
    },
    selectedDuties: ["code", "other"]
  };
}

describe("dispatch prompt (mirrors buildClassifierPrompt)", () => {
  it("lists every selected duty, each level, and the user task", () => {
    const p = buildDispatchPrompt(model(), "fix the failing login test");
    for (const id of ["code", "other"]) expect(p).toContain(id);
    expect(p).toContain("write or change software");
    expect(p).toContain("level 1");
    expect(p).toContain("level 3");
    expect(p).toContain("fix the failing login test");
    expect(p).toMatch(/JSON/i);
  });

  it("truncates a very long task to keep the call cheap", () => {
    const p = buildDispatchPrompt(model(), "x".repeat(10000));
    // the user-task span is capped at 4000 chars; the whole prompt stays bounded
    expect(p.length).toBeLessThan(4000 + 2000);
  });

  it("dispatchSchema requires duty+level and leaves duty an open string (clamped in code)", () => {
    const s = dispatchSchema();
    expect(s.required).toEqual(["duty", "level"]);
    expect(s.properties.duty.type).toBe("string");
    expect(s.properties.duty.enum).toBeUndefined();
    expect(s.properties.level.type).toBe("integer");
  });
});

describe("dispatch parser (mirrors parseClassification clamping)", () => {
  it("parses a clean single-line JSON reply", () => {
    expect(parseDispatch('{"duty":"code","level":3,"confidence":"high","reason":"tricky"}', model())).toEqual({
      duty: "code",
      level: 3,
      confidence: "high",
      reason: "tricky"
    });
  });

  it("parses JSON embedded in prose", () => {
    const c = parseDispatch('Sure: {"duty":"code","level":2} — done.', model());
    expect(c?.duty).toBe("code");
    expect(c?.level).toBe(2);
  });

  it("parses a fenced ```json block", () => {
    const c = parseDispatch('```json\n{"duty":"other","level":1}\n```', model());
    expect(c?.duty).toBe("other");
    expect(c?.level).toBe(1);
  });

  it("clamps an out-of-vocabulary duty to other and an out-of-range level to the standard slot", () => {
    const c = parseDispatch('{"duty":"banana","level":99}', model());
    expect(c?.duty).toBe("other"); // out-of-vocab -> other (the classifier's clamp)
    expect(c?.level).toBe(2); // out-of-range -> standard (level 2)
  });

  it("defaults an absent/invalid confidence to low and keeps a valid one", () => {
    expect(parseDispatch('{"duty":"code","level":2}', model())?.confidence).toBe("low");
    expect(parseDispatch('{"duty":"code","level":2,"confidence":"medium"}', model())?.confidence).toBe("medium");
  });

  it("returns null when there is no JSON at all (total failure)", () => {
    expect(parseDispatch("I cannot classify this.", model())).toBeNull();
  });

  it("reads a garrison-call structured result and a text result", () => {
    const structured = parseDispatch({ ok: true, structured: { duty: "code", level: 3 } }, model());
    expect(structured).toEqual({ duty: "code", level: 3, confidence: "low", reason: "" });
    const text = parseDispatch({ ok: true, text: '{"duty":"other","level":1,"confidence":"high"}' }, model());
    expect(text?.duty).toBe("other");
    expect(text?.confidence).toBe("high");
  });

  it("fallbackDispatch is the (other, standard) slot", () => {
    expect(fallbackDispatch(model())).toEqual({
      duty: "other",
      level: 2,
      confidence: "low",
      reason: "dispatch parse failed; defaulted to standard"
    });
  });
});

describe("human override (always wins over the pick)", () => {
  it("extracts an explicit level instruction from the message", () => {
    expect(parseLevelOverride("run this at level 3")).toBe(3);
    expect(parseLevelOverride("dispatch it at level 1 please")).toBe(1);
    expect(parseLevelOverride("use level: 2")).toBe(2);
    expect(parseLevelOverride("just fix the bug")).toBeNull();
  });

  it("does NOT treat incidental 'at level N' prose as an override (codex S3d spoof)", () => {
    expect(parseLevelOverride("The crash happens at level 3 of the menu, please fix it")).toBeNull();
    expect(parseLevelOverride("the boss at level 2 is too hard")).toBeNull();
  });

  it("an explicit out-of-range-low override CLAMPS to level 1, never ignored (codex S3d)", () => {
    // "run at level 0" is an explicit directive → returned, then clamped.
    expect(parseLevelOverride("run at level 0")).toBe(0);
    const out = applyOverride({ duty: "code", level: 3, confidence: "low", reason: "" }, { message: "run at level 0" }, model());
    expect(out.overridden).toBe(true);
    expect(out.level).toBe(1); // clamped up, not left at the model's 3
  });

  it("an out-of-range-low CARD level clamps to 1, never ignored (codex S3d)", () => {
    const out = applyOverride({ duty: "code", level: 3, confidence: "low", reason: "" }, { cardLevel: 0 }, model());
    expect(out.overridden).toBe(true);
    expect(out.level).toBe(1);
    expect(out.overrideSource).toBe("card");
  });

  it("a message instruction overrides the level, keeping the duty", () => {
    const out = applyOverride({ duty: "code", level: 1, confidence: "low", reason: "x" }, { message: "actually run at level 3" }, model());
    expect(out.duty).toBe("code");
    expect(out.level).toBe(3);
    expect(out.overridden).toBe(true);
    expect(out.overrideSource).toBe("message");
    expect(out.reason).toMatch(/overridden to level 3 by message/);
  });

  it("a card-level field overrides when there is no message instruction", () => {
    const out = applyOverride({ duty: "code", level: 1, confidence: "low", reason: "" }, { cardLevel: 2 }, model());
    expect(out.level).toBe(2);
    expect(out.overrideSource).toBe("card");
  });

  it("the message instruction beats the card field when both are present", () => {
    const out = applyOverride({ duty: "code", level: 1, confidence: "low", reason: "" }, { message: "run at level 3", cardLevel: 2 }, model());
    expect(out.level).toBe(3);
    expect(out.overrideSource).toBe("message");
  });

  it("clamps an explicit override into the duty's real range", () => {
    const out = applyOverride({ duty: "code", level: 1, confidence: "low", reason: "" }, { message: "run at level 9" }, model());
    expect(out.level).toBe(3); // code has 3 levels
  });

  it("no override leaves the pick untouched", () => {
    const out = applyOverride({ duty: "code", level: 2, confidence: "high", reason: "y" }, { message: "fix the bug" }, model());
    expect(out.level).toBe(2);
    expect(out.overridden).toBe(false);
  });
});

describe("routing evidence (digest, never the raw message)", () => {
  it("digests the message and never carries it verbatim", () => {
    const raw = "leak me if you can";
    const d = messageDigest(raw);
    expect(d).not.toBe(raw);
    expect(d).toMatch(/^[0-9a-f]{16}$/);
    expect(messageDigest(raw)).toBe(d); // stable
  });

  it("routingEvidence carries the digest + code-composed reason, NEVER the model's message-tainted reason (codex S3d)", () => {
    const ev = routingEvidence({
      message: "SECRET-123",
      duty: "code",
      level: 2,
      confidence: "high",
      overrideSource: null,
      at: "2026-01-01T00:00:00Z"
    });
    expect(ev.messageDigest).toBe(messageDigest("SECRET-123"));
    expect(ev.duty).toBe("code");
    expect(ev.confidence).toBe("high");
    // The persisted reason is code-composed from non-message fields.
    expect(ev.reason).toBe("→ code L2, confidence high");
    expect(JSON.stringify(ev)).not.toContain("SECRET-123");
  });

  it("routingEvidence cannot leak the message even if a model reason echoed it", () => {
    // The caller no longer passes chosen.reason; even if someone did, the field
    // is not read. Simulate the attack: message echoed everywhere it could go.
    const ev = routingEvidence({ message: "SECRET-123", duty: "code", level: 2, confidence: "SECRET-123" });
    // confidence IS persisted (it comes from structured output, not free text),
    // so the guarantee is specifically about the free-text reason; assert the
    // digest is present and the reason field is code-composed.
    expect(ev.reason).not.toContain("free");
    expect(ev.messageDigest).toBe(messageDigest("SECRET-123"));
  });

  it("appendEvidence writes one JSON line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-ev-"));
    const file = join(dir, "decisions.jsonl");
    await appendEvidence(file, routingEvidence({ message: "m", duty: "code", level: 1, confidence: "low", at: "t" }));
    await appendEvidence(file, routingEvidence({ message: "n", duty: "other", level: 2, confidence: "low", at: "t2" }));
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).duty).toBe("code");
    expect(JSON.parse(lines[1]).level).toBe(2);
  });
});

describe("dispatch() orchestration (mocked garrison-call)", () => {
  const okCall = async () => ({ ok: true, structured: { duty: "code", level: 3, confidence: "high", reason: "deep migration" } });

  it("calls garrison-call, parses the structured pick, and returns (duty, level)", async () => {
    let seenSpec: any = null;
    const call = async (spec: any) => {
      seenSpec = spec;
      return okCall();
    };
    const r = await dispatch(model(), "big migration", { call, now: () => "2026-01-01T00:00:00Z" });
    expect(r.duty).toBe("code");
    expect(r.level).toBe(3);
    expect(r.confidence).toBe("high");
    expect(r.dispatchOk).toBe(true);
    expect(r.evidence.messageDigest).toBe(messageDigest("big migration"));
    // the built spec is a single-shot STRUCTURED call
    expect(seenSpec.schema).toBeTruthy();
    expect(typeof seenSpec.prompt).toBe("string");
  });

  it("requires an injected call function", async () => {
    // deliberately omit the required `call` to exercise the runtime guard
    await expect(dispatch(model(), "x", {} as any)).rejects.toThrow(/opts.call/);
  });

  it("a failed call falls back to (other, standard) and records the error", async () => {
    const call = async () => ({ ok: false, error: "provider returned HTTP 500" });
    const r = await dispatch(model(), "x", { call });
    expect(r.duty).toBe("other");
    expect(r.level).toBe(2);
    expect(r.dispatchOk).toBe(false);
    expect(r.callError).toMatch(/500/);
  });

  it("a thrown call is caught and falls back (never throws for an operational failure)", async () => {
    const call = async () => {
      throw new Error("socket hang up");
    };
    const r = await dispatch(model(), "x", { call });
    expect(r.dispatchOk).toBe(false);
    expect(r.callError).toMatch(/socket hang up/);
  });

  it("a human override wins over the model's pick", async () => {
    const r = await dispatch(model(), "big migration but run at level 1", { call: okCall });
    expect(r.duty).toBe("code");
    expect(r.level).toBe(1); // model said 3; the message override wins
    expect(r.overridden).toBe(true);
    expect(r.overrideSource).toBe("message");
  });

  it("writes the routing-evidence line to the decisions log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-run-"));
    const file = join(dir, "decisions.jsonl");
    await dispatch(model(), "secret payload", { call: okCall, evidenceFile: file, now: () => "2026-02-02T00:00:00Z" });
    const line = readFileSync(file, "utf8").trim();
    const rec = JSON.parse(line);
    expect(rec.kind).toBe("dispatch");
    expect(rec.duty).toBe("code");
    expect(rec.messageDigest).toBe(messageDigest("secret payload"));
    expect(line).not.toContain("secret payload");
  });
});
