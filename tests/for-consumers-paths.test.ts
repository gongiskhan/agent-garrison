import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

// `for_consumers` is injected VERBATIM into the assembled system prompt
// (src/lib/metadata.ts -> orchestrator-projection.ts), so anything written there
// is an instruction the operative will actually run. The operative does not run
// in the composition dir — probed live on this node:
//
//   CWD=/Users/varela/.garrison/personal
//   COMPDIR=/Users/varela/dev/agent-garrison/compositions/default-2
//
// so a bare "apm_modules/_local/..." resolves to nothing and the call dies with
// MODULE_NOT_FOUND. The session then explains the gap in prose rather than
// failing, the job exits 0, and the whole path looks healthy while delivering
// nothing — which is exactly how the morning briefing stayed dead for weeks.
//
// Nine fittings carried it. This gate is what stops the tenth.
//
// verify: and setup: commands are deliberately NOT covered here. Their cwd is
// fixed by the hook-cwd contract (verify -> composition dir, setup -> fitting
// dir), so relative paths there are correct and tests/hook-cwd-contract.test.ts
// owns them.

const SEED = path.resolve(__dirname, "..", "fittings", "seed");
const BARE = /(?<![\w/$])apm_modules\/_local\//;

function seedIds(): string[] {
  return fs
    .readdirSync(SEED)
    .filter((id) => fs.existsSync(path.join(SEED, id, "apm.yml")));
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
  it("no seed manifest tells the session to run a bare apm_modules path", () => {
    const offenders: string[] = [];
    for (const id of seedIds()) {
      const doc = yaml.load(
        fs.readFileSync(path.join(SEED, id, "apm.yml"), "utf8")
      );
      for (const text of forConsumersText(doc)) {
        for (const line of text.split("\n")) {
          if (BARE.test(line)) offenders.push(`${id}: ${line.trim()}`);
        }
      }
    }
    expect(
      offenders,
      "for_consumers is injected into the operative's prompt, and the operative " +
        "runs in its session dir — prefix these with $GARRISON_COMPOSITION_DIR/ " +
        "so they resolve:\n" +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("the qualified form is what the fixed fittings actually use", () => {
    // Guards against a well-meaning revert to a `cd` preamble: a prompt's
    // commands may each run in their own Bash call, so a cd would not carry.
    const wa = fs.readFileSync(path.join(SEED, "whatsapp-web", "apm.yml"), "utf8");
    expect(wa).toContain("$GARRISON_COMPOSITION_DIR/apm_modules/_local/whatsapp-web");
  });
});
