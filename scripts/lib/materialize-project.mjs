// Loadout materializer — rebuild a project's working environment from its
// descriptor (brief D2). Runs on WHICHEVER machine needs the environment: the
// host (for the Phase 1 host-local proof, via scripts/materialize-loadout.mjs)
// and every outpost (called by the worker on claim).
//
// Deliberately dependency-free .mjs so it can run on a bare Mac with nothing but
// node, and so the host CLI and the worker execute THE SAME CODE — a materializer
// that behaved differently in the two places would make the host-local gate
// meaningless as evidence for the remote case.
//
// IDEMPOTENT BY CONSTRUCTION. Second run against the same target is a fast
// no-op except the fetch: clone-or-fetch (never re-clone), migrate the checkout
// (never reset it — a reset would destroy work in progress), re-render `.env`
// (cheap, and it must be fresh per claim), re-run setup (declared idempotent),
// re-run verify.

import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// Run a command, returning its result rather than throwing, so the caller
// decides what is fatal. stdout/stderr are capped: a runaway install must not
// exhaust the worker before its own timeout.
const OUTPUT_CAP = 512 * 1024;

export function run(command, { cwd, env = {}, timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-lc", command], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      // Group leader so the timeout can kill the whole tree; an install that
      // spawned children would otherwise orphan them holding locks.
      detached: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      if (stdout.length < OUTPUT_CAP) stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < OUTPUT_CAP) stderr += d.toString();
    });
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: `${stderr}\n${err.message}`, command });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr, command });
    });
  });
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Where a project's checkout lives on this machine.
export function checkoutPath(loadout, { projectsRoot }) {
  const root = loadout.projects_root_override || projectsRoot;
  return path.join(root, loadout.id);
}

// A step's record, for the caller's transcript. NEVER includes env values.
function step(name, result) {
  return {
    name,
    command: result.command,
    exitCode: result.exitCode,
    ok: result.exitCode === 0,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

// Materialize the environment. `envContent` is the ALREADY-RENDERED .env body,
// produced on the host from the vault — this function never touches a vault and
// never resolves a secret, which is what keeps the master key on the host.
export async function materialize(
  loadout,
  { projectsRoot, envContent = null, branch = null, log = () => {} } = {}
) {
  const target = checkoutPath(loadout, { projectsRoot });
  const steps = [];
  const fail = (s) => ({ ok: false, target, steps, failed: s });

  await mkdir(path.dirname(target), { recursive: true });

  // 1. Clone or fetch. Never re-clone an existing checkout: it may hold work.
  if (await exists(path.join(target, ".git"))) {
    log(`fetch ${loadout.id}`);
    const r = await run(`git fetch --all --prune`, { cwd: target });
    steps.push(step("fetch", r));
    if (r.exitCode !== 0) return fail("fetch");
  } else {
    log(`clone ${loadout.id}`);
    const r = await run(
      `git clone ${shellQuote(loadout.repo_remote)} ${shellQuote(target)}`,
      { cwd: path.dirname(target), timeoutMs: 30 * 60 * 1000 }
    );
    steps.push(step("clone", r));
    if (r.exitCode !== 0) return fail("clone");
  }

  // 2. Put the checkout on the right branch.
  //
  // MIGRATE, NEVER RESET. `git checkout -B` or `reset --hard` here would silently
  // destroy uncommitted work in a checkout a human may also be using. If the
  // tree is dirty we stay put and say so, rather than "fixing" it.
  const wanted = branch || loadout.default_branch;
  const dirty = await run(`git status --porcelain`, { cwd: target });
  steps.push(step("status", dirty));
  if (dirty.exitCode !== 0) return fail("status");
  if (dirty.stdout.trim()) {
    steps.push({
      name: "branch",
      command: `(skipped)`,
      exitCode: 75,
      ok: false,
      stdout: "",
      stderr: `working tree is dirty — refusing to run on an unverified branch; commit, stash, or clean it explicitly`
    });
    return fail("dirty checkout");
  } else {
    // Create the branch from the remote's default when it does not exist yet,
    // otherwise just switch. `git switch -c <b> --track` fails if it exists, so
    // try a plain switch first.
    let sw = await run(`git switch ${shellQuote(wanted)}`, { cwd: target });
    steps.push(step("branch", sw));
    if (sw.exitCode !== 0) {
      // A new machine branch starts from the authored remote default, never
      // from whichever local HEAD happened to be checked out.
      sw = await run(
        `git switch -c ${shellQuote(wanted)} ${shellQuote(`origin/${loadout.default_branch}`)}`,
        { cwd: target }
      );
      steps.push(step("branch create", sw));
      if (sw.exitCode !== 0) return fail("branch");
    }
    const current = await run(`git branch --show-current`, { cwd: target });
    steps.push(step("branch verify", current));
    if (current.exitCode !== 0 || current.stdout.trim() !== wanted) return fail("branch verify");
    // Fast-forward only. A merge or rebase here could conflict, and resolving a
    // conflict is not a materializer's job.
    if (wanted === loadout.default_branch) {
      const pull = await run(`git pull --ff-only origin ${shellQuote(loadout.default_branch)}`, { cwd: target });
      steps.push(step("pull", pull));
      if (pull.exitCode !== 0) return fail("pull");
    } else {
      // A long-lived per-machine dispatch branch may legitimately be ahead of
      // and diverged from the default branch. Fetch it for human integration,
      // but never auto-merge/rebase machine work here.
      steps.push({
        name: "pull",
        command: `(not applicable on ${wanted})`,
        exitCode: 0,
        ok: true,
        stdout: "dispatch branches are not automatically merged with the default branch",
        stderr: ""
      });
    }
  }

  // 3. Secrets. Written BEFORE install/setup, because those steps commonly read
  // .env. 0600 and owner-only, refreshed on every materialization (D3).
  if (envContent !== null) {
    const envPath = path.join(target, ".env");
    await writeFile(envPath, envContent, { mode: 0o600 });
    // Explicit chmod after the write: the mode option is masked by umask, so a
    // umask of 0022 would otherwise leave the secrets file group/world readable.
    const { chmod } = await import("node:fs/promises");
    await chmod(envPath, 0o600);
    steps.push({
      name: "env",
      // The COMMAND is recorded, never the content.
      command: `write .env (${envContent.split("\n").filter((l) => l && !l.startsWith("#")).length} vars, mode 0600)`,
      exitCode: 0,
      ok: true,
      stdout: "",
      stderr: ""
    });
  }

  // 4. APM install, when the project declares a manifest.
  if (loadout.apm_manifest_path) {
    const manifestDir = path.dirname(path.join(target, loadout.apm_manifest_path));
    const r = await run(`apm install`, { cwd: manifestDir, timeoutMs: 30 * 60 * 1000 });
    steps.push(step("apm install", r));
    if (r.exitCode !== 0) return fail("apm install");
  }

  // 5. Setup — side-effect-causing prep, declared idempotent by the descriptor.
  for (const command of loadout.setup_commands) {
    const r = await run(command, { cwd: target, timeoutMs: 30 * 60 * 1000 });
    steps.push(step(`setup: ${command}`, r));
    if (r.exitCode !== 0) return fail(`setup: ${command}`);
  }

  // 6. Verify — read-only, and the gate. It must pass BEFORE any model starts,
  // so a broken environment costs zero tokens.
  const verify = await run(loadout.verify_command, { cwd: target });
  steps.push(step("verify", verify));
  if (verify.exitCode !== 0) return fail("verify");

  return { ok: true, target, steps, failed: null };
}

// Render a materialization transcript. Secret VALUES never appear (the env step
// records only a count), but setup output could echo one, so the caller passes
// the values to mask.
export function materializationTranscript(result, { secretValues = [] } = {}) {
  const mask = (text) => {
    let out = String(text ?? "");
    for (const v of [...secretValues].filter(Boolean).sort((a, b) => b.length - a.length)) {
      if (out.includes(v)) out = out.split(v).join("***REDACTED***");
    }
    return out;
  };
  const lines = [`# materialization: ${result.ok ? "OK" : `FAILED at ${result.failed}`}`, `target: ${result.target}`, ``];
  for (const s of result.steps) {
    lines.push(`## ${s.name} (exit ${s.exitCode})`);
    if (s.stdout?.trim()) lines.push(mask(s.stdout.trim()));
    if (s.stderr?.trim()) lines.push(`stderr: ${mask(s.stderr.trim())}`);
    lines.push("");
  }
  return lines.join("\n");
}
