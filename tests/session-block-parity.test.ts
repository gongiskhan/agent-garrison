import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { SESSION_BLOCK_TYPES } from "../packages/claude-chat/src/journal";

// The block-type trap, mechanised.
//
// A canonical block type has to be taught to SIX places, and only one of them
// fails loudly. The dangerous one is the web channel's sanitizer whitelist: it
// refuses an unknown block, and `sanitizeSessionEvent` refuses the WHOLE event
// when any block is refused - so a renderer that speaks a type the channel has
// never heard of produces a transcript that silently loses entire turns on
// reload. This suite pins the two lists against each other in both directions,
// and round-trips each new type through the sanitizer it must survive.

const JOURNAL_PATH = path.resolve(__dirname, "../packages/claude-chat/src/journal.ts");
const THREADS_PATH = path.resolve(__dirname, "../fittings/seed/web-channel-default/scripts/threads.mjs");

type Loose = Record<string, any>;
let sanitizeSessionBlock: (raw: unknown) => Loose | null;
let sanitizeSessionEvent: (raw: unknown) => Loose | null;

beforeAll(async () => {
  const mod: Loose = await import(pathToFileURL(THREADS_PATH).href);
  sanitizeSessionBlock = mod.sanitizeSessionBlock;
  sanitizeSessionEvent = mod.sanitizeSessionEvent;
});

/** Drop `//` line comments so prose inside a list never reads as a member. */
function stripLineComments(source: string): string {
  return source.replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Every double-quoted literal in a fragment, in source order. */
function literals(fragment: string): string[] {
  return [...stripLineComments(fragment).matchAll(/"([^"\\]+)"/g)].map((match) => match[1]);
}

/** A `const NAME = new Set([...])` / `= [...]` member list, formatting-agnostic. */
function listMembers(source: string, name: string): string[] {
  const match = source.match(
    new RegExp(`const\\s+${name}\\s*=\\s*(?:new\\s+Set\\s*\\(\\s*)?\\[([\\s\\S]*?)\\]`)
  );
  expect(match, `${name} not found`).toBeTruthy();
  return literals(match![1]);
}

const journalSource = readFileSync(JOURNAL_PATH, "utf8");
const threadsSource = readFileSync(THREADS_PATH, "utf8");

describe("session block type parity", () => {
  it("declares the same block vocabulary in the journal and the channel sanitizer", () => {
    const channel = listMembers(threadsSource, "SESSION_BLOCK_TYPES");
    const journal = [...SESSION_BLOCK_TYPES];

    // Both directions on purpose. A type only the journal knows is dropped on
    // write; a type only the channel knows is dead whitelist entry that hides
    // the fact that no renderer speaks it.
    expect([...journal].sort()).toEqual([...channel].sort());
    expect(journal).toContain("stretch");
    expect(journal).toContain("ledger");
    // No duplicates in either list - a set hides a typo, an array does not.
    expect(new Set(journal).size).toBe(journal.length);
    expect(new Set(channel).size).toBe(channel.length);
  });

  it("keeps the exported vocabulary in step with the journal's own source", () => {
    // Parsed from source rather than imported: this is the half that catches a
    // NEW block interface whose type never reached the exported list.
    const parsed = listMembers(journalSource, "SESSION_BLOCK_TYPES");
    expect(parsed).toEqual([...SESSION_BLOCK_TYPES]);

    const declared = [...journalSource.matchAll(/export interface \w+ extends SessionBlock \{([\s\S]*?)\n\}/g)]
      .map((match) => match[1].match(/^\s*type:\s*"([^"]+)"/m)?.[1])
      .filter((type): type is string => Boolean(type));
    expect(declared.length).toBeGreaterThanOrEqual(8);
    for (const type of declared) expect(SESSION_BLOCK_TYPES).toContain(type);
  });

  it("keeps the ledger kind union in step with the sanitizer's closed set", () => {
    const union = journalSource.match(/export type SessionLedgerKind =([\s\S]*?);/);
    expect(union, "SessionLedgerKind union not found").toBeTruthy();
    const journalKinds = literals(union![1]);
    const channelKinds = listMembers(threadsSource, "SESSION_LEDGER_KINDS");

    expect([...journalKinds].sort()).toEqual([...channelKinds].sort());
    expect(journalKinds).toContain("handoff");
    expect(journalKinds).toContain("card-state-changed");
  });
});

const envelope = (block: unknown) => ({
  id: "e1",
  role: "assistant",
  ts: 1_786_880_000_000,
  order: 0,
  revision: 0,
  blocks: [block],
});

describe("stretch blocks round-trip through the channel sanitizer", () => {
  const valid = {
    type: "stretch",
    phase: "ended",
    stretchId: "01STRETCHID",
    attribution: { route: "cc-sonnet", runtime: "agent-sdk", model: "sonnet", duty: "implement", level: 2 },
    duty: "implement",
    chosenBy: "duty-default",
    outcome: "complete",
    usedTokens: 12_345,
    durationMs: 42_000,
  };

  it("keeps every declared field", () => {
    expect(sanitizeSessionBlock(valid)).toEqual({
      type: "stretch",
      phase: "ended",
      stretchId: "01STRETCHID",
      attribution: { route: "cc-sonnet", runtime: "agent-sdk", model: "sonnet", duty: "implement", level: 2 },
      duty: "implement",
      chosenBy: "duty-default",
      outcome: "complete",
      usedTokens: 12_345,
      durationMs: 42_000,
    });
    expect(sanitizeSessionEvent(envelope(valid))?.blocks).toHaveLength(1);
  });

  it("keeps a boundary whose lane reported no attribution at all", () => {
    // The rail's honesty rule: an unreported dimension gets no badge. An empty
    // bag is still a real boundary, so refusing it would delete the event.
    const bare = { type: "stretch", phase: "started", stretchId: "01BARE", attribution: {} };
    expect(sanitizeSessionBlock(bare)).toEqual(bare);
  });

  it("nulls the whole event on a malformed field", () => {
    for (const bad of [
      { ...valid, phase: "halfway" },
      { ...valid, stretchId: 42 },
      { ...valid, attribution: "cc-sonnet" },
      { ...valid, usedTokens: "lots" },
      { ...valid, durationMs: -1 },
      { ...valid, duty: 7 },
    ]) {
      expect(sanitizeSessionBlock(bad), JSON.stringify(bad)).toBeNull();
      expect(sanitizeSessionEvent(envelope(bad)), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("ledger blocks round-trip through the channel sanitizer", () => {
  const valid = {
    type: "ledger",
    kind: "delegation-returned",
    title: "review returned: 2 findings",
    detail: "findings:\n- unguarded write\n- missing verify",
    next: "review",
    payloadRef: "delegation-01ABC",
    seq: 42,
  };

  it("keeps every declared field", () => {
    expect(sanitizeSessionBlock(valid)).toEqual(valid);
    expect(sanitizeSessionEvent(envelope(valid))?.blocks).toHaveLength(1);
  });

  it("keeps a bare row with no detail, payload or sequence", () => {
    const bare = { type: "ledger", kind: "escalation", title: "raised to top" };
    expect(sanitizeSessionBlock(bare)).toEqual(bare);
  });

  it("nulls the whole event on a malformed field", () => {
    for (const bad of [
      { ...valid, title: 42 },
      { ...valid, title: "   " },
      { ...valid, kind: "not-a-ledger-kind" },
      { ...valid, detail: 42 },
      { ...valid, next: 42 },
      { ...valid, payloadRef: 42 },
      { ...valid, seq: 1.5 },
    ]) {
      expect(sanitizeSessionBlock(bad), JSON.stringify(bad)).toBeNull();
      expect(sanitizeSessionEvent(envelope(bad)), JSON.stringify(bad)).toBeNull();
    }
  });
});
