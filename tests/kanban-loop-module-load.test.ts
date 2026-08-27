// Every kanban-loop module must LINK.
//
// Why this file exists. ESM resolves named imports at LINK time: one import of
// a symbol the target module no longer exports takes the whole module graph
// down at load, before a single line runs. The kanban-loop fitting has been hit
// by this twice:
//
//   1. scripts/kanban.mjs imported `phaseForList` from lib/engine.mjs, which
//      only imported it for internal use. `node scripts/kanban.mjs --setup`
//      exited 1 on every `up`. The fix was the re-export at engine.mjs:53, and
//      the guard was a HAND-MAINTAINED list of the symbols that one CLI
//      imported from that one module (formerly in
//      tests/kanban-resolved-model.test.ts).
//   2. The Conversations cut deleted `processCard` from lib/engine.mjs and
//      `isUserList` / `insertUserLists` from lib/resolved-model.mjs while
//      scripts/server.mjs still imported all three. The board server — and
//      therefore scripts/start.mjs, the fitting's own entrypoint — failed to
//      load at all. The hand-maintained guard could not see it: wrong file,
//      wrong target module, and its own list had gone stale in the same cut.
//
// So the guard is no longer a list. It reads every relative import and
// re-export in every .mjs of the fitting and checks the named symbols against
// the target module's actual exports. Nothing to keep in sync, and a new
// import line is covered the moment it is written.
//
// Note what this does NOT do: import the entrypoints. scripts/start.mjs calls
// startServer() at module scope, so importing it would bind a port. Only the
// TARGETS of import statements are loaded, which is what carries the exports.
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

// Sandbox anything a module might touch on load. These modules are libraries,
// but a stray home/policy read must never resolve to the real ~/.garrison.
process.env.GARRISON_HOME = mkdtempSync(path.join(tmpdir(), "kanban-module-load-home-"));
process.env.GARRISON_KANBAN_DIR = mkdtempSync(path.join(tmpdir(), "kanban-module-load-board-"));
process.env.GARRISON_RUNS_DIR = mkdtempSync(path.join(tmpdir(), "kanban-module-load-runs-"));
process.env.GARRISON_POLICY_PATH = "/nonexistent/kanban-module-load-policy.json";

const FITTING = path.resolve(__dirname, "..", "fittings", "seed", "kanban-loop");

// `import { a, b as c } from "./x.mjs"` and `export { a } from "./x.mjs"`, both
// possibly spanning lines. Type-only syntax does not exist in .mjs, and a
// dynamic import() is resolved at call time (not a link error), so neither is
// in scope here.
//
// The brace body is `[^{}]*` and not a lazy `[\s\S]*?` ON PURPOSE: a bare
// `export { x };` with no `from` would otherwise let the match run past its own
// closing brace and swallow the NEXT statement's braces, inventing symbol names
// out of the comment prose in between. Refusing to cross a brace makes such a
// statement simply not match, which is correct — it re-exports nothing from
// another module, so there is nothing to link-check.
const NAMED_FROM = /(?:^|\n)\s*(?:import|export)\s*\{([^{}]*)\}\s*from\s*["']([^"']+)["']/g;

interface Requirement {
  /** the file whose import line this is */
  source: string;
  /** the relative specifier it names */
  spec: string;
  /** the named symbols it asks for */
  names: string[];
}

function requirementsOf(file: string): Requirement[] {
  const src = readFileSync(file, "utf8");
  const out: Requirement[] = [];
  for (const match of src.matchAll(NAMED_FROM)) {
    const spec = match[2];
    if (!spec.startsWith(".")) continue; // node builtins + packages are not ours to guard
    const names = match[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      // `a as b` asks the target for `a`; the local alias is irrelevant here.
      .map((s) => s.split(/\s+as\s+/)[0].trim());
    out.push({ source: file, spec, names });
  }
  return out;
}

// Load each distinct target once and report every symbol it fails to provide,
// plus any target that cannot be loaded at all. Paths are reported relative to
// `base` so the message names the fitting file, not a 90-character absolute.
async function linkFailures(sources: string[], base: string): Promise<string[]> {
  const requirements = sources.flatMap(requirementsOf);
  const rel = (p: string) => path.relative(base, p);
  const byTarget = new Map<string, Requirement[]>();
  for (const req of requirements) {
    const target = path.resolve(path.dirname(req.source), req.spec);
    const list = byTarget.get(target);
    if (list) list.push(req);
    else byTarget.set(target, [req]);
  }

  const failures: string[] = [];
  for (const [target, reqs] of byTarget) {
    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(target).href)) as Record<string, unknown>;
    } catch (err) {
      const importers = [...new Set(reqs.map((r) => rel(r.source)))].join(", ");
      failures.push(`${rel(target)} FAILED TO LOAD (imported by ${importers}): ${(err as Error)?.message}`);
      continue;
    }
    for (const req of reqs) {
      for (const name of req.names) {
        if (!(name in mod)) {
          failures.push(`${rel(req.source)} imports "${name}" from ${req.spec}, which does not export it`);
        }
      }
    }
  }
  return failures;
}

function mjsFilesIn(dir: string): string[] {
  return readdirSync(path.join(FITTING, dir))
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => path.join(FITTING, dir, name));
}

// Every .mjs the fitting ships, entrypoints included: they are SOURCES of
// import statements here, never loaded themselves.
const SOURCES = [...mjsFilesIn("lib"), ...mjsFilesIn("scripts")].sort();

describe("kanban-loop module graph — every relative import resolves", () => {
  it("finds import statements to check (the parser itself is not silently dead)", () => {
    // A regex that stopped matching would make the assertion below vacuous.
    const requirements = SOURCES.flatMap(requirementsOf);
    expect(requirements.length).toBeGreaterThan(50);
    expect(SOURCES.length).toBeGreaterThan(20);
    // The three files whose stale imports caused (or would have propagated) the
    // outages are all covered.
    const sources = new Set(requirements.map((r) => path.relative(FITTING, r.source)));
    expect(sources).toContain("scripts/server.mjs");
    expect(sources).toContain("scripts/kanban.mjs");
    expect(sources).toContain("scripts/start.mjs");
  });

  it("every target module loads, and exports every symbol its importers name", async () => {
    const failures = await linkFailures(SOURCES, FITTING);
    expect(
      failures,
      `A missing export is a LINK error, not a runtime one: the importing module — and anything that imports it, up to scripts/start.mjs — fails to load entirely, so the fitting never boots.\n  ${failures.join("\n  ")}`
    ).toEqual([]);
  }, 30_000);

  // The symbol sweep above is the diagnostic — it names the file, the symbol
  // and the target. This is the VERDICT, under the runtime that actually runs
  // the fitting.
  //
  // It is a child process on purpose. Vitest does not execute .mjs the way node
  // does: its module runner resolves a missing named import to `undefined`
  // instead of throwing, so a module that node refuses to link imports cleanly
  // under vitest and only fails later, somewhere else, as a confusing
  // "undefined is not a function". That leniency is exactly why the broken
  // server.mjs sailed past the whole suite. Only a real `node` load reproduces
  // what `up` sees.
  it("node itself can load the board server and the setup CLI", async () => {
    for (const entry of ["scripts/server.mjs", "scripts/kanban.mjs"]) {
      const target = pathToFileURL(path.join(FITTING, entry)).href;
      await expect(
        execFileAsync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(target)})`], {
          timeout: 60_000,
          env: process.env
        }),
        `node cannot load ${entry}. This is what \`up\` hits: the fitting does not boot.`
      ).resolves.toBeTruthy();
    }
  }, 90_000);
});

// The guard is only worth its runtime if it actually FAILS on the shape it was
// written for. Rebuild that shape in a temp dir — an entrypoint importing a
// symbol its target dropped, reached through a re-export facade exactly as
// start.mjs reaches resolved-model.mjs through server.mjs — and assert the same
// function reports it.
describe("the guard detects the failure it exists for", () => {
  function fixture(): string {
    const root = mkdtempSync(path.join(tmpdir(), "kanban-module-load-fixture-"));
    mkdirSync(path.join(root, "lib"), { recursive: true });
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    // The target, post-cut: `insertUserLists` is gone.
    writeFileSync(path.join(root, "lib", "resolved-model.mjs"), "export function buildBoard() { return {}; }\n");
    // A facade that re-exports from it — the `export { x } from` form.
    writeFileSync(
      path.join(root, "lib", "engine.mjs"),
      'export { buildBoard } from "./resolved-model.mjs";\nexport function getList() { return null; }\n'
    );
    // The server, still importing the deleted symbol.
    writeFileSync(
      path.join(root, "scripts", "server.mjs"),
      [
        'import { buildBoard, insertUserLists } from "../lib/resolved-model.mjs";',
        'import { getList } from "../lib/engine.mjs";',
        "export function startServer() { return [buildBoard, insertUserLists, getList]; }"
      ].join("\n") + "\n"
    );
    // The entrypoint, which never loads here — only its import line is read.
    writeFileSync(
      path.join(root, "scripts", "start.mjs"),
      'import { startServer } from "./server.mjs";\nstartServer();\n'
    );
    return root;
  }

  it("names the exact importer, symbol and target for a dropped export", async () => {
    const root = fixture();
    const sources = [
      path.join(root, "lib", "engine.mjs"),
      path.join(root, "lib", "resolved-model.mjs"),
      path.join(root, "scripts", "server.mjs"),
      path.join(root, "scripts", "start.mjs")
    ];

    const failures = await linkFailures(sources, root);

    expect(failures).toContain(
      'scripts/server.mjs imports "insertUserLists" from ../lib/resolved-model.mjs, which does not export it'
    );
    // The re-export facade resolves, so the healthy half stays quiet: the
    // report is the one broken edge, not the whole graph.
    expect(failures.filter((f) => f.includes("engine.mjs"))).toEqual([]);
  });

  it("node refuses the same graph outright — the failure mode the sweep is a proxy for", async () => {
    const root = fixture();
    const target = pathToFileURL(path.join(root, "scripts", "start.mjs")).href;
    // start.mjs only imports server.mjs, which imports the missing symbol. node
    // links the whole graph before running anything, so the entrypoint dies on
    // a defect two modules away — and says so.
    await expect(
      execFileAsync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(target)})`], {
        timeout: 30_000
      })
    ).rejects.toThrow(/does not provide an export named 'insertUserLists'/);
  }, 60_000);

  it("passes a graph whose imports all resolve, re-export facade included", async () => {
    const root = fixture();
    // Heal it the way the fix did: drop the stale symbol from the import line.
    writeFileSync(
      path.join(root, "scripts", "server.mjs"),
      [
        'import { buildBoard } from "../lib/resolved-model.mjs";',
        'import { getList } from "../lib/engine.mjs";',
        "export function startServer() { return [buildBoard, getList]; }"
      ].join("\n") + "\n"
    );
    const sources = [
      path.join(root, "lib", "engine.mjs"),
      path.join(root, "lib", "resolved-model.mjs"),
      path.join(root, "scripts", "server.mjs"),
      path.join(root, "scripts", "start.mjs")
    ];

    expect(await linkFailures(sources, root)).toEqual([]);
  });
});
