// tours-registry.ts — server-side discovery of in-app tours (WS6). Tours come
// from three sources, in precedence order:
//   1. inline metadata:   a fitting's x-garrison.ui.tours[]
//   2. beside the fitting: <fitting.localPath>/tours/*.json
//   3. repo-root tours:    <repo>/tours/*.json  (shell / cross-surface tours not
//                          owned by any single fitting — e.g. the Compose demo)
// For every library fitting that HAS a UI surface (ui.views) but ships no
// explicit tour, a minimal "what is this" tour is synthesized from its views so
// the "every seed Fitting ships >=1 tour" invariant holds without hand-authoring
// one per fitting.
//
// Node-only (reads the filesystem). The client never imports this — the UI
// fetches descriptors through /api/tours.
import fs from "node:fs/promises";
import path from "node:path";
import { ROOT_DIR, SEED_FITTINGS_DIR } from "./paths";
import { readLibrary } from "./library";
import { readYamlFile } from "./yaml";
import { parseGarrisonMetadata, tourDescriptorSchema, type TourDescriptor } from "./metadata";
import type { GarrisonMetadata, LibraryEntry } from "./types";

export interface TourSummary {
  name: string;
  title: string;
  route: string;
  fitting?: string;
  mode?: "demo" | "guided";
  steps: number;
  synthesized?: boolean;
}

// A fitting we can discover tours for — unified across the curated library and
// the raw seed directory (so a seed fitting not listed in library.json is still
// covered by the "every UI fitting ships a tour" invariant).
interface FittingSource {
  id: string;
  name: string;
  summary: string;
  localPath?: string;
  ui?: GarrisonMetadata["ui"];
}

// Union of library entries + seed dirs, de-duplicated by id (the library's
// resolved metadata wins when a fitting appears in both).
async function readFittingSources(): Promise<FittingSource[]> {
  const byId = new Map<string, FittingSource>();

  const library = await readLibrary().catch(() => [] as LibraryEntry[]);
  for (const entry of library) {
    byId.set(entry.id, {
      id: entry.id,
      name: entry.name,
      summary: entry.summary,
      localPath: entry.localPath,
      ui: entry.metadata.ui
    });
  }

  let seedDirs: string[] = [];
  try {
    seedDirs = await fs.readdir(SEED_FITTINGS_DIR);
  } catch {
    seedDirs = [];
  }
  for (const id of seedDirs) {
    if (byId.has(id)) continue;
    const manifestPath = path.join(SEED_FITTINGS_DIR, id, "apm.yml");
    try {
      const manifest = await readYamlFile<{ name?: string; description?: string; "x-garrison"?: unknown }>(
        manifestPath
      );
      if (!manifest) continue;
      const metadata = parseGarrisonMetadata(manifest["x-garrison"]);
      byId.set(id, {
        id,
        name: manifest.name ?? id,
        summary: manifest.description ?? "",
        localPath: path.relative(ROOT_DIR, path.join(SEED_FITTINGS_DIR, id)),
        ui: metadata.ui
      });
    } catch {
      // A seed that doesn't parse (parked/legacy id) simply isn't a tour source.
    }
  }

  return Array.from(byId.values());
}

async function readJsonDir(dir: string): Promise<unknown[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(await fs.readFile(path.join(dir, name), "utf8")));
    } catch {
      // Skip malformed files rather than failing the whole registry — a bad
      // tour on disk must not blank out every other tour.
    }
  }
  return out;
}

// Validate a raw descriptor, stamping the owning fitting id when the author
// omitted it. Returns null (and warns) on an invalid descriptor.
function coerceTour(raw: unknown, fitting?: string): TourDescriptor | null {
  const withFitting =
    raw && typeof raw === "object" && fitting && !(raw as Record<string, unknown>).fitting
      ? { ...(raw as Record<string, unknown>), fitting }
      : raw;
  const parsed = tourDescriptorSchema.safeParse(withFitting);
  if (!parsed.success) {
    console.warn(
      `[garrison] skipping invalid tour${fitting ? ` for ${fitting}` : ""}: ${parsed.error.message}`
    );
    return null;
  }
  return parsed.data;
}

// The auto-generated "what is this" tour: one spotlight step on the fitting's
// per-fitting overview page. Deliberately minimal — it exists so every UI
// fitting is at least discoverable by tour, not to teach a flow.
function synthesizeDefaultTour(entry: FittingSource): TourDescriptor {
  const view = entry.ui?.views?.[0];
  const label = entry.name || entry.id;
  return {
    name: `${entry.id}-overview`,
    title: `What is ${label}?`,
    route: `/fitting/${entry.id}`,
    fitting: entry.id,
    mode: "guided",
    steps: [
      {
        id: "overview",
        caption: `${label}${entry.summary ? ` — ${entry.summary}` : ""}. ${
          view ? `Its view lives at ${view.route}.` : "This is its place in Garrison."
        }`,
        selector: "raw-css:h1, main, .app-shell",
        spotlight: true
      }
    ]
  };
}

// Load every discoverable tour, de-duplicated by name (explicit tours from any
// source win over a synthesized default of the same name).
export async function loadTours(): Promise<TourDescriptor[]> {
  const byName = new Map<string, TourDescriptor>();

  const add = (tour: TourDescriptor | null) => {
    if (tour && !byName.has(tour.name)) byName.set(tour.name, tour);
  };

  // 3. Repo-root tours (shell / cross-surface). Loaded first so a shell tour can
  //    claim a name a synthesized default would otherwise take.
  for (const raw of await readJsonDir(path.join(ROOT_DIR, "tours"))) {
    add(coerceTour(raw));
  }

  const sources = await readFittingSources();
  for (const source of sources) {
    // 1. Inline metadata tours.
    for (const raw of source.ui?.tours ?? []) {
      add(coerceTour(raw, source.id));
    }
    // 2. tours/*.json beside the fitting.
    if (source.localPath) {
      for (const raw of await readJsonDir(path.join(ROOT_DIR, source.localPath, "tours"))) {
        add(coerceTour(raw, source.id));
      }
    }
  }

  // Synthesize a default for every UI fitting that still has no tour.
  for (const source of sources) {
    if (!source.ui?.views?.length) continue;
    const hasExplicit = Array.from(byName.values()).some((tour) => tour.fitting === source.id);
    if (!hasExplicit) add(synthesizeDefaultTour(source));
  }

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export async function listTours(): Promise<TourSummary[]> {
  const tours = await loadTours();
  return tours.map((tour) => ({
    name: tour.name,
    title: tour.title,
    route: tour.route,
    fitting: tour.fitting,
    mode: tour.mode,
    steps: tour.steps.length,
    synthesized: tour.name.endsWith("-overview")
  }));
}

export async function getTour(name: string): Promise<TourDescriptor | undefined> {
  const tours = await loadTours();
  return tours.find((tour) => tour.name === name);
}
