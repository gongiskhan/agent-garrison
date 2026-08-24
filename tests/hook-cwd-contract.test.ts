import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseGarrisonMetadata } from "@/lib/metadata";
import { readYamlFile } from "@/lib/yaml";
import type { GarrisonMetadata } from "@/lib/types";

// The setup/verify hook cwd contract, pinned.
//
// src/lib/runner.ts runs the two hook types from DIFFERENT directories:
//   setup  -> <composition>/apm_modules/_local/<id>   (runFittingSetup)
//   verify -> <composition>                           (verify)
// Nothing enforced that asymmetry, and copying one shape into the other slot is
// invisible until `up` fails. It bit twice:
//   * morning-briefing's setup.sh resolved the scheduler as
//     "$(pwd)/apm_modules/_local/scheduler/..." — from the setup cwd that is
//     .../_local/morning-briefing/apm_modules/_local/scheduler, which never
//     exists, so a well-fitted scheduler reported as "not in your composition".
//   * the retired vault-sync / outpost-worker / outpost-actions declared verify commands as
//     "bash scripts/verify.sh", which from the composition dir is exit 127 —
//     an unconditional `up` abort for anyone who stationed them.
// Both classes are mechanically detectable, so they are gated here rather than
// discovered at runtime.

const SEED_DIR = path.resolve(__dirname, "..", "fittings", "seed");

// Path prefixes that only mean anything relative to a FITTING's own directory.
const FITTING_LOCAL_PREFIXES = ["scripts/", "ui/", "lib/", "payload/", ".apm/", "launchers/"];

interface RawManifest {
  "x-garrison"?: unknown;
}

function seedIds(): string[] {
  return readdirSync(SEED_DIR)
    .filter((name) => statSync(path.join(SEED_DIR, name)).isDirectory())
    .filter((name) => existsSync(path.join(SEED_DIR, name, "apm.yml")))
    .sort();
}

async function loadSeed(id: string): Promise<GarrisonMetadata | null> {
  const manifest = await readYamlFile<RawManifest>(path.join(SEED_DIR, id, "apm.yml"));
  if (!manifest?.["x-garrison"]) return null;
  try {
    return parseGarrisonMetadata(manifest["x-garrison"]);
  } catch {
    // A manifest that no longer parses against the current schema is de-listed
    // debt covered by seed.test.ts; it cannot reach a hook either way.
    return null;
  }
}

// Shell-ish tokenisation: enough to pull out path-looking arguments.
function tokens(command: string): string[] {
  return command
    .split(/[\s'"]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

describe("setup/verify hook cwd contract", () => {
  it("every verify command addresses the fitting through apm_modules/_local/<id>", async () => {
    const offenders: string[] = [];
    for (const id of seedIds()) {
      const metadata = await loadSeed(id);
      const command = metadata?.verify?.command;
      if (!command) continue;
      for (const token of tokens(command)) {
        if (FITTING_LOCAL_PREFIXES.some((prefix) => token.startsWith(prefix))) {
          offenders.push(
            `${id}: verify references "${token}", which only resolves from the ` +
              `fitting dir. Verify runs in the composition dir — use ` +
              `apm_modules/_local/${id}/${token}`
          );
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("every verify command's apm_modules path names its own fitting and exists on disk", async () => {
    const offenders: string[] = [];
    for (const id of seedIds()) {
      const metadata = await loadSeed(id);
      const command = metadata?.verify?.command;
      if (!command) continue;
      for (const token of tokens(command)) {
        const match = /^apm_modules\/_local\/([^/]+)\/(.+)$/.exec(token);
        if (!match) continue;
        const [, referencedId, rest] = match;
        if (referencedId !== id) {
          offenders.push(`${id}: verify reaches into a sibling fitting "${referencedId}" (${token})`);
          continue;
        }
        if (!existsSync(path.join(SEED_DIR, id, rest))) {
          offenders.push(`${id}: verify references ${token}, but ${rest} is not in the seed`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("no setup command reaches through apm_modules/_local — its cwd is already there", async () => {
    const offenders: string[] = [];
    for (const id of seedIds()) {
      const metadata = await loadSeed(id);
      for (const step of metadata?.setup ?? []) {
        if (step.command.includes("apm_modules/_local")) {
          offenders.push(
            `${id}: setup command "${step.command}" contains apm_modules/_local. ` +
              `Setup already runs in apm_modules/_local/${id}, so this doubles the path.`
          );
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("no setup script resolves a sibling fitting via $(pwd)/apm_modules", async () => {
    // The exact morning-briefing bug: $(pwd) is the fitting's own installed dir
    // during setup, so "$(pwd)/apm_modules/_local/<other>" can never resolve.
    // Resolve siblings relative to the script instead ($FITTING_DIR/../<other>).
    const offenders: string[] = [];
    for (const id of seedIds()) {
      const metadata = await loadSeed(id);
      for (const step of metadata?.setup ?? []) {
        for (const token of tokens(step.command)) {
          if (!/\.(sh|mjs|js|py)$/.test(token)) continue;
          const scriptPath = path.join(SEED_DIR, id, token);
          if (!existsSync(scriptPath)) continue;
          // Comment lines are stripped first: the scripts that were fixed
          // document the trap in prose, and matching that would fail the gate
          // for explaining the very bug it guards.
          const source = readFileSync(scriptPath, "utf8")
            .split("\n")
            .filter((line) => !/^\s*(#|\/\/)/.test(line))
            .join("\n");
          if (/\$\(pwd\)\/apm_modules/.test(source)) {
            offenders.push(
              `${id}: ${token} resolves a path as "$(pwd)/apm_modules/...". During setup ` +
                `$(pwd) is apm_modules/_local/${id}, so that path never exists.`
            );
          }
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
