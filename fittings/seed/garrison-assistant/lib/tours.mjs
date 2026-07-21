// tours.mjs — the tour registry the Assistant's Guide mode launches BY NAME.
// The in-app tour ENGINE + full descriptors land in WS6; this is the stable
// launch API + a seed registry so Guide can resolve a tour name to a launch
// directive today. WS6 replaces the registry source with the ui.tours metadata
// discovery, keeping this launch contract.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";

// Seed registry: name -> { fitting, title, route }. WS6 will populate this from
// each Fitting's ui.tours block; until then a small built-in set + any
// tours/*.json shipped beside this fitting.
const SEED = {
  "quarters-basics": { fitting: "quarters", title: "Quarters basics", route: "/quarters" },
  "compose-a-fitting": { fitting: "compose", title: "Compose a Fitting", route: "/compose" },
  "clone-a-fitting": { fitting: "compose", title: "Clone a Fitting", route: "/compose" },
  "switch-composition": { fitting: "shell", title: "Switch the active composition", route: "/" },
  // The WS6 in-app tour engine's committed tours (tours/*.json). Guide launches
  // these by name; each carries its player mode so the engine opens the right one.
  "compose-demo": { fitting: "compose", title: "Compose, demonstrated", route: "/compose", mode: "demo" },
  "quarters-guided": { fitting: "quarters", title: "Quarters, guided", route: "/quarters", mode: "guided" }
};

export function listTours(toursDir) {
  const out = { ...SEED };
  if (toursDir && existsSync(toursDir)) {
    for (const name of readdirSync(toursDir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const desc = JSON.parse(readFileSync(path.join(toursDir, name), "utf8"));
        const key = desc.name || name.replace(/\.json$/, "");
        out[key] = { fitting: desc.fitting || "shell", title: desc.title || key, route: desc.route || "/", descriptor: desc };
      } catch { /* skip malformed */ }
    }
  }
  return out;
}

// Resolve a tour name to a launch directive. Throws with the known names when
// the name is unknown, so Guide fails loud instead of launching nothing.
export function launchTour(name, toursDir) {
  const tours = listTours(toursDir);
  const tour = tours[name];
  if (!tour) {
    const known = Object.keys(tours).join(", ");
    const err = new Error(`unknown tour "${name}" — known tours: ${known}`);
    err.code = "unknown-tour";
    err.known = Object.keys(tours);
    throw err;
  }
  // The launch directive the WS6 tour engine consumes (it watches
  // ?tour=<name>&mode=<demo|guided>). The tour's own mode wins; default guided.
  const mode = tour.mode === "demo" ? "demo" : "guided";
  return {
    launch: true,
    name,
    title: tour.title,
    route: tour.route,
    fitting: tour.fitting,
    mode,
    url: `${tour.route}?tour=${encodeURIComponent(name)}&mode=${mode}`
  };
}
