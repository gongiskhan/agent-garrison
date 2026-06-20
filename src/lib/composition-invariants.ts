import { userMcpServers } from "./claude-json";
import { readParkedMcp, readParkedHooks } from "./parked-config";
import { readSettingsRaw, type HookGroup } from "./claude-settings-file";

// HV9 — composition invariants. The load-bearing one is the presence XOR: a
// config-entry primitive (mcp / hook) must be in EXACTLY ONE of the active config
// and the parked store, never both. Both = drift (a disable that half-applied, or
// a hand-edit). Surfaced so the holistic view can flag it rather than silently
// double-list. The other invariants (bootstrap parks nothing; empty contracts
// accepted; writes confined to managed dirs) are properties the test suite
// asserts directly.

export interface InvariantViolation {
  invariant: "mcp-xor" | "hook-xor";
  detail: string;
}

export async function checkCompositionInvariants(): Promise<InvariantViolation[]> {
  const violations: InvariantViolation[] = [];

  // mcp: no server name in both ~/.claude.json and the parked store.
  const active = await userMcpServers();
  const parkedMcp = await readParkedMcp();
  for (const name of Object.keys(parkedMcp)) {
    if (Object.prototype.hasOwnProperty.call(active, name)) {
      violations.push({ invariant: "mcp-xor", detail: `MCP server "${name}" is both active and parked` });
    }
  }

  // hooks: no parked group identical to an active group on the same event.
  const { json } = await readSettingsRaw();
  const activeHooks = (json.hooks ?? {}) as Record<string, HookGroup[]>;
  for (const ph of await readParkedHooks()) {
    const list = activeHooks[ph.event];
    if (Array.isArray(list) && list.some((g) => JSON.stringify(g) === JSON.stringify(ph.group))) {
      violations.push({ invariant: "hook-xor", detail: `a "${ph.event}" hook group is both active and parked` });
    }
  }

  return violations;
}
