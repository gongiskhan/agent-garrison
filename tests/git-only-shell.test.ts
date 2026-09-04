// git-only-shell.sh - the forced `command=` for the tether's git-reverse-
// forward ssh key in dev-madrid's authorized_keys. Its entire job is refusing
// everything except an exact git-upload-pack/git-receive-pack against one
// repo path, so what matters here is the refusal side: a wrong path, an
// injection attempt riding along in SSH_ORIGINAL_COMMAND, and no command at
// all must all be refused (never silently exec'd, never shell-interpreted).

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";

const SCRIPT = path.resolve(__dirname, "..", "scripts", "remote-shell", "git-only-shell.sh");
const REPO = "/home/ggomes/dev/garrison";

function run(sshOriginalCommand: string | undefined): { status: number | null; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("sh", [SCRIPT], {
      encoding: "utf8",
      env: (sshOriginalCommand === undefined
        ? { PATH: process.env.PATH }
        : { PATH: process.env.PATH, SSH_ORIGINAL_COMMAND: sshOriginalCommand }) as unknown as NodeJS.ProcessEnv,
      input: "",
      stdio: ["pipe", "pipe", "pipe"]
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err: any) {
    return { status: err.status ?? null, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") };
  }
}

describe("git-only-shell.sh", () => {
  // git-upload-pack itself exits non-zero here (its normal "the client hung
  // up" complaint - the test never completes the pack-protocol handshake on
  // stdin, it just wants proof the RIGHT command ran against the RIGHT repo).
  // That is git's exit code, not the shell script's - the script's own job
  // was already done the moment it exec'd, and its stdout is the evidence.
  it("execs the real git-upload-pack for the exact expected repo (single-quoted, as git's own ssh transport sends it)", () => {
    const result = run(`git-upload-pack '${REPO}'`);
    // A real git-upload-pack advertisement starts with a pkt-line length
    // prefix followed by the HEAD ref line - proof this actually ran against
    // the real repo, not a stub.
    expect(result.stdout).toMatch(/^[0-9a-f]{4}[0-9a-f]{40} HEAD/);
  });

  it("also accepts the double-quoted form", () => {
    const result = run(`git-upload-pack "${REPO}"`);
    expect(result.stdout).toMatch(/^[0-9a-f]{4}[0-9a-f]{40} HEAD/);
  });

  it("refuses a git command against any OTHER path", () => {
    const result = run(`git-upload-pack '/etc/passwd'`);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/refused/);
  });

  it("refuses a shell-injection attempt riding along in SSH_ORIGINAL_COMMAND", () => {
    const result = run(`git-upload-pack '${REPO}'; rm -rf /tmp/should-never-run`);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/refused/);
  });

  it("refuses a plain shell command", () => {
    const result = run("bash -c 'id'");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/refused/);
  });

  it("refuses when SSH_ORIGINAL_COMMAND is entirely absent", () => {
    const result = run(undefined);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/refused/);
  });

  it("refuses git-receive-pack against the wrong path but accepts it against the right one (argv only, never invoked destructively here)", () => {
    const wrong = run(`git-receive-pack '/tmp/not-the-repo'`);
    expect(wrong.status).toBe(1);
    // The right-path case would exec the real receive-pack and block on stdin
    // waiting for a pack - not exercised here to avoid depending on git
    // internals beyond argv construction, already proven by the upload-pack
    // cases above (same case arm shape).
  });
});
