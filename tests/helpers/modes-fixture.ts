// Synthetic modes-shaped fixture (S3f2b).
//
// The multi-face `modes` seed fitting (Gary/Joe/James) was retired, but the souls
// assembly (src/lib/souls.ts) and orchestrator placement (src/lib/orchestrator-
// placement.ts) machinery it fed is still-live code that must keep working when a
// fitting providing capability kind `modes` IS installed. These tests therefore
// exercise that machinery against a fixture written to a tmpdir, instead of reading
// a seed fitting that no longer ships.
//
// The routing-bias values mirror the retired seed's modes.json exactly, so the
// derived per-mode tiers stay meaningful: gary → fast, joe → expert, james →
// standard (see biasRole in fittings/seed/orchestrator/lib/routing-core.mjs).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MODES_FIXTURE = {
  version: 1,
  defaultMode: "gary",
  sharedVoiceRef: "voice/shared-voice.md",
  modes: {
    gary: {
      soulRef: "souls/gary.md",
      label: "Gary — personal assistant",
      faculties: ["memory", "channels"],
      routingBias: "standard-toward-fast"
    },
    joe: {
      soulRef: "souls/joe.md",
      label: "Joe — dev",
      faculties: ["runtimes", "memory"],
      routingBias: "expert"
    },
    james: {
      soulRef: "souls/james.md",
      label: "James — product / architect",
      faculties: ["memory"],
      routingBias: "expert-then-standard"
    }
  },
  channelDefaults: { "dev-env": "joe", slack: "gary", web: "gary", default: "gary" },
  switching: { switchLog: ".garrison/switch-log.jsonl" },
  routingBias: {
    "standard-toward-fast": { floor: "fast", prefer: "fast" },
    expert: { floor: "expert", prefer: "expert" },
    "expert-then-standard": { floor: "standard", prefer: "expert" }
  }
} as const;

// Anchors the fixture files carry, matching the strings the machinery tests assert.
export const VOICE_ANCHOR = "thoughtful person speaks";
export const STANCE_ANCHOR: Record<string, string> = {
  gary: "Gary, the operative at rest",
  joe: "Joe, how the operative writes",
  james: "James, the face that feels most"
};

// Write a synthetic modes fitting (modes.json + voice + souls) into `dir` and
// return it. `dir` must already exist (a tmpdir from mkdtempSync).
export function writeModesFixture(dir: string): string {
  mkdirSync(join(dir, "voice"), { recursive: true });
  mkdirSync(join(dir, "souls"), { recursive: true });
  writeFileSync(join(dir, "modes.json"), JSON.stringify(MODES_FIXTURE, null, 2), "utf8");
  writeFileSync(
    join(dir, "voice", "shared-voice.md"),
    `# Shared voice\n\nThis is how a ${VOICE_ANCHOR}: plainly, and with care for the person on the other side.\n`,
    "utf8"
  );
  for (const [mode, anchor] of Object.entries(STANCE_ANCHOR)) {
    writeFileSync(join(dir, "souls", `${mode}.md`), `# Soul\n\n${anchor}.\n`, "utf8");
  }
  return dir;
}
