import path from "node:path";
import { toPosixPath } from "./fs-utils";

// Authoring of `apm.yml` `dependencies.apm[]` entries — shared by the per-
// operative composition writer (compositions.ts) and the global-composition
// writer (global-composition.ts). A local fitting is a `{ path: <relative> }`
// computed from the composition dir; a remote fitting is its bare repo URL.

export type ApmDependency = string | { path: string };

export interface ApmDependencyInput {
  // Absolute path to a local fitting directory. Takes precedence over `repo`.
  absPath?: string;
  // Remote dependency (repo URL / shorthand), used when `absPath` is absent.
  repo?: string;
}

export interface AuthorOpts {
  // Emit absolute `path:` entries instead of composition-relative ones. The
  // per-operative composition is committed to the repo, so it uses RELATIVE
  // paths (portable). The global composition lives in ~/.garrison (machine-local,
  // never committed), so it uses ABSOLUTE paths — robust against the macOS
  // /var->/private/var symlink that makes a relative path resolve one level off
  // when APM runs from a temp project root. (Verified: APM accepts absolute paths.)
  absolute?: boolean;
}

export function authorApmDependency(
  input: ApmDependencyInput,
  composeDir: string,
  opts: AuthorOpts = {}
): ApmDependency {
  if (input.absPath) {
    return {
      path: toPosixPath(opts.absolute ? input.absPath : path.relative(composeDir, input.absPath))
    };
  }
  if (input.repo) {
    return input.repo;
  }
  throw new Error("apm dependency requires either absPath or repo");
}

export function authorApmDependencies(
  inputs: ApmDependencyInput[],
  composeDir: string,
  opts: AuthorOpts = {}
): ApmDependency[] {
  return inputs.map((input) => authorApmDependency(input, composeDir, opts));
}
