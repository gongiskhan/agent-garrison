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
}

console.log("MODES-OK");
