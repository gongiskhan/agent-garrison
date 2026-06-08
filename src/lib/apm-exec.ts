import { spawnTracked } from "./spawn";

// Injectable seam for shelling out to the APM CLI.
//
// `apm install` is slow and non-deterministic, which is poison for the per-slice
// vitest gate. So every engine function that drives APM takes an `ApmRunner` and
// defaults to `defaultApmRunner`. Tests pass a stub that simulates apm's on-disk
// effects (writing a fixture apm.lock.yaml + deployed files) so the unit gate is
// fast and deterministic; exactly one integration test uses the real binary.
//
// This generalises runner.ts's private `runProcess` into a reusable, log-channel
// -agnostic primitive.

export interface ApmRunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ApmRunOpts {
  env?: NodeJS.ProcessEnv;
}

export type ApmRunner = (
  args: string[],
  cwd: string,
  opts?: ApmRunOpts
) => Promise<ApmRunResult>;

export const defaultApmRunner: ApmRunner = (args, cwd, opts = {}) =>
  new Promise<ApmRunResult>((resolve, reject) => {
    const { child } = spawnTracked(
      "apm",
      args,
      { cwd, env: opts.env ?? process.env },
      { spawnSite: "apm-exec", description: `apm ${args.join(" ")}` }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
