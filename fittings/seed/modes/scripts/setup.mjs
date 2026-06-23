// modes setup: ensure the briefs directory exists (James writes briefs there).
// Idempotent. The runner runs this from the fitting's installed dir
// (<composition>/apm_modules/_local/modes/scripts) and projects the `briefs_path`
// config as MODES_BRIEFS_PATH (setupConfigEnv convention: <FITTING_ID>_<KEY>).
//
// James (the operative) writes briefs relative to the COMPOSITION ROOT — that is
// the authoritative write target, NOT this fitting's install dir. So a RELATIVE
// briefs_path (the `./briefs/` default) must be resolved against the composition
// root, computed here from this script's known install location
// (<comp>/apm_modules/_local/modes/scripts -> up 4 = <comp>); an ABSOLUTE
// MODES_BRIEFS_PATH is honored as-is. (souls.ts does NOT create this dir.)
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const compositionRoot = resolve(here, "../../../..");
const configured = process.env.MODES_BRIEFS_PATH || "./briefs";
const briefsPath = isAbsolute(configured) ? configured : resolve(compositionRoot, configured);
mkdirSync(briefsPath, { recursive: true });
console.log("modes setup: briefs dir ready ->", briefsPath);
