// modes verify: the fitting ships the three souls, the shared voice, and a
// well-formed modes.json wiring them. Read-only. Prints MODES-OK on success.
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// a ref must resolve to a readable FILE — existsSync alone passes a directory,
// which then throws when runtime code (souls.ts) readFile()s it.
const isFile = (rel) => {
  try { return statSync(join(root, rel)).isFile(); } catch { return false; }
};

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

// the CONFIGURED shared-voice + brief-template refs (modes.json) must point at real
// files — checking only the hardcoded required[] paths above lets a mutated ref pass
// verify while the runtime wiring (souls.ts reads sharedVoiceRef) silently breaks.
for (const field of ["sharedVoiceRef", "briefTemplateRef"]) {
  const rel = config[field];
  if (typeof rel !== "string" || !isFile(rel)) {
    console.error(`MODES-FAIL config.${field} is missing or does not point at a readable file: ${rel}`);
    process.exit(1);
  }
}

const modeNames = Object.keys(config.modes ?? {});
for (const name of ["gary", "joe", "james"]) {
  const mode = config.modes?.[name];
  if (!mode || typeof mode.soulRef !== "string" || typeof mode.routingBias !== "string") {
    console.error(`MODES-FAIL mode "${name}" is missing soulRef/routingBias`);
    process.exit(1);
  }
  if (!isFile(mode.soulRef)) {
    console.error(`MODES-FAIL mode "${name}" soulRef does not point at a readable file: ${mode.soulRef}`);
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

// routing-bias floor/prefer must be COMPUTE roles only — biasRole ranks via the
// compute ladder (fast<standard<expert) and silently ignores the task-specific roles
// (image/video/review), so a non-compute bias would pass loosely and then no-op.
const COMPUTE_ROLES = new Set(["fast", "standard", "expert"]);
for (const [biasName, bias] of Object.entries(config.routingBias ?? {})) {
  for (const field of ["floor", "prefer"]) {
    const v = bias?.[field];
    if (v !== undefined && !COMPUTE_ROLES.has(v)) {
      console.error(`MODES-FAIL routingBias "${biasName}".${field} = "${v}" is not a compute role (fast|standard|expert)`);
      process.exit(1);
    }
  }
}

console.log("MODES-OK");
