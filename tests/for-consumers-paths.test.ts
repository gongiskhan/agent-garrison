import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

// `for_consumers` is guidance the operative reads and then runs: it is folded
// into the assembled prompt (orchestrator-sections.ts) and served verbatim by
// the `garrison_capability_doc` MCP tool (capability-docs.json).
//
// The operative does NOT run in the composition dir. The gateway spawns every
// lane with `cwd: pre.projectPath ?? workspaceCwdFallback()`, which is a project
// checkout or the personal workspace ($GARRISON_HOME/personal, created by the
// kanban-loop setup hook). A bare `apm_modules/_local/...` therefore resolves
// against the wrong directory and dies with MODULE_NOT_FOUND.
//
// The gateway's own env carries GARRISON_COMPOSITION_DIR (projected by the
// runner) and every lane inherits it, so that is the prefix that resolves.
// It is inlined on each command rather than set by a `cd` preamble, because the
// operative may run each command in its own Bash call and a cd would not carry.
//
// verify: and setup: commands are deliberately NOT covered here. Their cwd is
// fixed by the hook-cwd contract, so relative paths there are correct and
// tests/hook-cwd-contract.test.ts owns them.

const SEED = path.resolve(__dirname, "..", "fittings", "seed");
const BARE = /(?<![\w/$])apm_modules\/_local\//;

function seedIds(): string[] {
  return fs.readdirSync(SEED).filter((id) => fs.existsSync(path.join(SEED, id, "apm.yml")));
}

/** Every `for_consumers` string in a manifest, wherever it is nested. */
function forConsumersText(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) forConsumersText(item, out);
    return out;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "for_consumers") {
        const flatten = (v: unknown): void => {
          if (typeof v === "string") out.push(v);
          else if (Array.isArray(v)) v.forEach(flatten);
          else if (v && typeof v === "object") Object.values(v).forEach(flatten);
        };
        flatten(value);
      } else {
        forConsumersText(value, out);
      }
    }
  }
  return out;
}

describe("for_consumers carries no path the operative cannot resolve", () => {
  it("no seed manifest tells the operative to run a bare apm_modules path", () => {
    const offenders: string[] = [];
    for (const id of seedIds()) {
      const doc = yaml.load(fs.readFileSync(path.join(SEED, id, "apm.yml"), "utf8"));
      for (const text of forConsumersText(doc)) {
        for (const line of text.split("\n")) {
          if (BARE.test(line)) offenders.push(`${id}: ${line.trim()}`);
        }
      }
    }
    expect(
      offenders,
      "for_consumers is run by the operative, which does not run in the composition dir. " +
        "Prefix these with $GARRISON_COMPOSITION_DIR/ so they resolve:\n" +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("uses the inline $GARRISON_COMPOSITION_DIR form, not a cd preamble", () => {
    const wa = fs.readFileSync(path.join(SEED, "whatsapp-web", "apm.yml"), "utf8");
    expect(wa).toContain('"$GARRISON_COMPOSITION_DIR/apm_modules/_local/whatsapp-web/scripts/connector.mjs"');
  });
});
