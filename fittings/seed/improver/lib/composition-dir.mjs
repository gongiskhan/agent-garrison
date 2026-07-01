// composition-dir.mjs - resolve the APM composition directory this Fitting is
// installed into. Prefers GARRISON_COMPOSITION_DIR when set; falls back to a
// fixed-depth walk up from this file's own location, valid for today's
// compositions/<id>/apm_modules/_local/<fitting>/ install layout. Callers that
// shell out based on this MUST guard on the resolved dir actually being an APM
// composition (e.g. apm.yml existing) - this function fails silently wrong,
// never throws, if that layout assumption ever breaks.

import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // .../<fitting>/lib

export function resolveCompositionDir() {
  const o = process.env.GARRISON_COMPOSITION_DIR?.trim();
  if (o && o.length) return o;
  // lib -> <fitting> -> apm_modules/_local -> apm_modules -> compositions/<id>
  return path.resolve(HERE, "..", "..", "..", "..");
}
