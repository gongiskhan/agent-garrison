import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "js-yaml";

// Vocabulary guard for the 2026-08-24 mesh rename.
//
// "Operative" named a single composed agent on a single box. On a mesh of peer
// nodes it names nothing: what a user watches is a SESSION, what they configure
// is a COMPOSITION, and what runs it is a NODE. A one-time sweep drifts back
// within a month, so the rename is enforced here instead.
//
// SCOPE IS DELIBERATE, and narrower than "every file":
//
//   • src/**/*.tsx + their CSS modules — the words a user actually reads.
//   • fittings/**/apm.yml `summary` and `for_consumers` — these are INJECTED
//     INTO THE RUNNING PROMPT by the runner (see CLAUDE.md, "for_consumers over
//     Orchestrator hardcoding"), so they are how the model learns the
//     vocabulary. Stale prose here teaches the wrong word every turn.
//
// Explicitly NOT swept: internal identifiers in gateway-pty.mjs /
// gateway-routing.mjs / runner.ts (`standingOperative` and `directOperative`
// are wire fields on the gateway's hints object, consumed across several
// fittings — renaming them is a coordinated multi-fitting change with a
// compatibility window, for zero user-visible gain), test names, and
// docs/decisions/**, which are historical records that a rename would falsify.

const ROOT = path.resolve(__dirname, "..");

// `\b` on both sides so "cooperatively" and similar substrings are not hits;
// the plural is caught because the test is about the word, not one spelling.
const BANNED = /\boperatives?\b/i;

// Empty on purpose. An entry here is a debt, not a decision — it must name the
// file and say why the word cannot leave yet.
const ALLOWLIST: ReadonlyArray<{ file: string; why: string }> = [];

const allowed = new Set(ALLOWLIST.map((entry) => entry.file));

function walk(dir: string, match: (file: string) => boolean, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === "apm_modules" || entry === ".git") continue;
    const full = path.join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(full, match, out);
    else if (match(entry)) out.push(full);
  }
  return out;
}

function offendingLines(file: string, text: string): string[] {
  return text
    .split("\n")
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => BANNED.test(line))
    .map(({ line, index }) => `${path.relative(ROOT, file)}:${index + 1}  ${line.trim()}`);
}

describe("vocabulary — 'Operative' left the user-facing surface", () => {
  it("no user-visible string in src/**/*.tsx says it", () => {
    const files = walk(path.join(ROOT, "src"), (name) => name.endsWith(".tsx") || name.endsWith(".css"));
    expect(files.length).toBeGreaterThan(50);
    const hits: string[] = [];
    for (const file of files) {
      if (allowed.has(path.relative(ROOT, file))) continue;
      hits.push(...offendingLines(file, readFileSync(file, "utf8")));
    }
    expect(
      hits,
      `"Operative" is retired vocabulary — a session runs on a node, configured by a composition.\n${hits.join("\n")}`
    ).toEqual([]);
  });

  it("no fitting manifest teaches it to the model", () => {
    const manifests = walk(path.join(ROOT, "fittings"), (name) => name === "apm.yml");
    expect(manifests.length).toBeGreaterThan(20);
    const hits: string[] = [];
    for (const file of manifests) {
      if (allowed.has(path.relative(ROOT, file))) continue;
      const doc = yaml.load(readFileSync(file, "utf8")) as Record<string, unknown> | undefined;
      const block = doc?.["x-garrison"] as Record<string, unknown> | undefined;
      if (!block) continue;
      // Only the two prose fields the runner injects. `config_schema`
      // descriptions and comments are swept by hand, not policed here.
      for (const key of ["summary", "for_consumers"] as const) {
        const value = block[key];
        if (typeof value !== "string" || !BANNED.test(value)) continue;
        hits.push(`${path.relative(ROOT, file)} (${key})`);
      }
    }
    expect(
      hits,
      `x-garrison.summary / for_consumers are injected into the running prompt — they must not teach the retired word.\n${hits.join("\n")}`
    ).toEqual([]);
  });

  it("the allowlist stays empty, or every entry explains itself", () => {
    for (const entry of ALLOWLIST) {
      expect(entry.why.trim().length, `${entry.file} needs a reason`).toBeGreaterThan(20);
    }
  });
});
