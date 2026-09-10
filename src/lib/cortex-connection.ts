import { getActiveComposition } from "./active-composition";
import { readComposition, writeComposition } from "./compositions";

export function normalizeCortexBase(raw: string): string {
  const url = new URL(raw.trim());
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTP or HTTPS base URL without credentials, a query or a fragment");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

export async function saveCortexBase(raw: string): Promise<void> {
  const baseUrl = normalizeCortexBase(raw);
  const id = await getActiveComposition();
  const composition = await readComposition(id);
  let found = false;
  for (const items of Object.values(composition.selections)) {
    for (const item of items ?? []) {
      if (item.id !== "cortex-client" && item.id !== "cortex-automations") continue;
      item.config = { ...item.config, base_url: baseUrl };
      found = true;
    }
  }
  if (!found) throw new Error("Add Cortex to the composition before configuring its address");
  // Both consumers use the same origin. The composition writer preserves other
  // settings and uses the shared authority's compare-and-swap revision.
  await writeComposition(id, { selections: composition.selections });
}
