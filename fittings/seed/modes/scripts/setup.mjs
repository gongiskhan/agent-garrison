// modes setup: ensure the briefs directory exists (James writes briefs there).
// Idempotent. Setup runs from the fitting's installed dir (apm_modules/_local/
// modes). The runner projects the `briefs_path` config as MODES_BRIEFS_PATH
// (setupConfigEnv convention: <FITTING_ID>_<KEY>). The authoritative runtime
// briefs_path (resolved against the composition dir) is set by the souls config
// (src/lib/souls.ts); this just pre-creates the directory.
import { mkdirSync } from "node:fs";

const briefsPath = process.env.MODES_BRIEFS_PATH || "./briefs";
mkdirSync(briefsPath, { recursive: true });
console.log("modes setup: briefs dir ready ->", briefsPath);
