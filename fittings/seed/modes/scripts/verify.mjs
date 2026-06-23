// modes verify: the fitting ships the three souls, the shared voice, and a
// well-formed modes.json wiring them. Read-only. Prints MODES-OK on success.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const required = [
  "souls/gary.md",
  "souls/joe.md",
  "souls/james.md",
  "voice/shared-voice.md",
  "modes.json",
  "references/brief-template.md"
];

const missing = required.filter((rel) => !existsSync(join(root, rel)));
if (missing.length) {
  console.error("MODES-FAIL missing:", missing.join(", "));
  process.exit(1);
}

let config;
try {
  config = JSON.parse(readFileSync(join(root, "modes.json"), "utf8"));
} catch (err) {
  console.error("MODES-FAIL modes.json is not valid JSON:", err.message);
  process.exit(1);
}

// The 9 live Garrison roles (mirror of facultyIds in src/lib/types.ts). modes.json
// `faculties` are descriptive metadata, but they must still name REAL faculties so the
// map cannot drift into invented roles (e.g. a non-faculty "knowledge").
const FACULTY_IDS = new Set([
  "orchestrator", "channels", "gateway", "runtimes", "memory",
  "observability", "sessions", "surfaces", "modes"
]);

const modeNames = Object.keys(config.modes ?? {});
for (const name of ["gary", "joe", "james"]) {
  const mode = config.modes?.[name];
  if (!mode || typeof mode.soulRef !== "string" || typeof mode.routingBias !== "string") {
    console.error(`MODES-FAIL mode "${name}" is missing soulRef/routingBias`);
    process.exit(1);
  }
  if (!existsSync(join(root, mode.soulRef))) {
    console.error(`MODES-FAIL mode "${name}" soulRef not found: ${mode.soulRef}`);
    process.exit(1);
  }
  // every declared faculty must be a real Garrison role
  for (const fac of mode.faculties ?? []) {
    if (!FACULTY_IDS.has(fac)) {
      console.error(`MODES-FAIL mode "${name}" lists a non-faculty: "${fac}" (valid: ${[...FACULTY_IDS].join(", ")})`);
      process.exit(1);
    }
  }
  // routingBias must reference a defined bias profile
  if (!config.routingBias?.[mode.routingBias]) {
    console.error(`MODES-FAIL mode "${name}" routingBias "${mode.routingBias}" is not defined in routingBias`);
    process.exit(1);
  }
}

// every channel default must point at a defined mode
for (const [channel, target] of Object.entries(config.channelDefaults ?? {})) {
  if (!modeNames.includes(target)) {
    console.error(`MODES-FAIL channelDefault "${channel}" -> "${target}" is not a defined mode`);
    process.exit(1);
  }
}

console.log("MODES-OK");
