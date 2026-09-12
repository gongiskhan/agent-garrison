import { expect, it } from "vitest";
// @ts-ignore — source-only repository gate
import { inspectHomeSource, checkTwoHomes } from "../scripts/check-two-homes.mjs";
it("rejects retired runtime overrides and bare user-home writes", () => {
  expect(inspectHomeSource("src/lib/escape.ts", "env.GARRISON_STRETCH_CLAUDE_HOME = dir;")).toHaveLength(1);
  expect(inspectHomeSource("fittings/demo/scripts/setup.sh", 'SETTINGS="$HOME/.claude/settings.json"')).toHaveLength(1);
  expect(inspectHomeSource("fittings/demo/scripts/setup.mjs", 'const dir = path.join(os.homedir(), ".claude");')).toHaveLength(1);
  expect(inspectHomeSource("fittings/demo/scripts/setup.sh", 'SETTINGS="${GARRISON_CLAUDE_HOME:-$HOME/.claude}/settings.json"')).toEqual([]);
});
it("keeps the active tree free of retired runtime paths", () => { expect(checkTwoHomes()).toEqual([]); });
