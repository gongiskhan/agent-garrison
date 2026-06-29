import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..");
const ARTIFACTS_PY = path.join(
  REPO_ROOT,
  "fittings",
  "seed",
  "documents",
  "scripts",
  "artifacts.py"
);

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function runCli(args: string[], stdin?: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn("python3", [ARTIFACTS_PY, ...args], {
      env: { ...process.env, GARRISON_ARTIFACTS_ROOT: undefined } // tests pass --root
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code }));
    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

describe("artifacts.py CLI", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "garrison-artifacts-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("--probe succeeds against a fresh root", async () => {
    const result = await runCli(["--root", tmpRoot, "--probe"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  });

  it("init creates the standard namespaces", async () => {
    const result = await runCli(["--root", tmpRoot, "init"]);
    expect(result.exitCode).toBe(0);
    for (const ns of ["documents", "automations", "voice"]) {
      const stat = await fs.stat(path.join(tmpRoot, ns));
      expect(stat.isDirectory()).toBe(true);
    }
  });

  it("write returns an id and persists a sidecar with the correct shape", async () => {
    const writeResult = await runCli(
      ["--root", tmpRoot, "write", "documents", "spec.md", "--title", "Spec"],
      "## Spec body\n"
    );
    expect(writeResult.exitCode).toBe(0);
    const id = writeResult.stdout.trim();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    const sidecar = JSON.parse(
      await fs.readFile(
        path.join(tmpRoot, "documents", "spec.md.meta.json"),
        "utf8"
      )
    );
    expect(sidecar.id).toBe(id);
    expect(sidecar.filename).toBe("spec.md");
    expect(sidecar.namespace).toBe("documents");
    expect(sidecar.producer).toBe("documents");
    expect(sidecar.title).toBe("Spec");
    expect(sidecar.mime).toBe("text/markdown");
    expect(sidecar.created).toEqual(sidecar.updated);
  });

  it("read returns the original bytes by id", async () => {
    const body = "hello world\n";
    const writeResult = await runCli(
      ["--root", tmpRoot, "write", "documents", "h.md"],
      body
    );
    const id = writeResult.stdout.trim();
    const readResult = await runCli(["--root", tmpRoot, "read", id]);
    expect(readResult.exitCode).toBe(0);
    expect(readResult.stdout).toBe(body);
  });

  it("list returns artifacts sorted by updated desc and filters by namespace", async () => {
    await runCli(["--root", tmpRoot, "write", "documents", "a.md"], "a");
    // sleep briefly so the second write gets a later timestamp
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await runCli(["--root", tmpRoot, "write", "voice", "b.wav"], "wav-bytes");

    const all = await runCli(["--root", tmpRoot, "list"]);
    const allRows = JSON.parse(all.stdout);
    expect(allRows).toHaveLength(2);
    expect(allRows[0].namespace).toBe("voice");
    expect(allRows[1].namespace).toBe("documents");

    const docs = await runCli([
      "--root",
      tmpRoot,
      "list",
      "--namespace",
      "documents"
    ]);
    expect(JSON.parse(docs.stdout)).toHaveLength(1);
  });

  it("link prints the garrison:// URL for a known id", async () => {
    const writeResult = await runCli(
      ["--root", tmpRoot, "write", "documents", "x.md"],
      "x"
    );
    const id = writeResult.stdout.trim();
    const linkResult = await runCli(["--root", tmpRoot, "link", id]);
    expect(linkResult.exitCode).toBe(0);
    expect(linkResult.stdout.trim()).toBe(`garrison://artifacts/${id}`);
  });

  it("delete removes the artifact + sidecar", async () => {
    const writeResult = await runCli(
      ["--root", tmpRoot, "write", "documents", "del.md"],
      "doomed"
    );
    const id = writeResult.stdout.trim();
    const deleteResult = await runCli(["--root", tmpRoot, "delete", id]);
    expect(deleteResult.exitCode).toBe(0);
    await expect(
      fs.stat(path.join(tmpRoot, "documents", "del.md"))
    ).rejects.toThrow();
    await expect(
      fs.stat(path.join(tmpRoot, "documents", "del.md.meta.json"))
    ).rejects.toThrow();
  });

  it("write rejects filenames ending in .meta.json", async () => {
    const result = await runCli(
      ["--root", tmpRoot, "write", "documents", "x.meta.json"],
      "x"
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/reserved for sidecars/);
  });

  it("namespaces are isolated — same filename, different namespaces, different ids", async () => {
    const docResult = await runCli(
      ["--root", tmpRoot, "write", "documents", "notes.md"],
      "doc body"
    );
    const voiceResult = await runCli(
      ["--root", tmpRoot, "write", "voice", "notes.md"],
      "audio bytes"
    );
    expect(docResult.stdout.trim()).not.toBe(voiceResult.stdout.trim());
  });

  it("a sidecar dropped onto disk shows up in list (producer-agnostic)", async () => {
    await fs.mkdir(path.join(tmpRoot, "documents"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "documents", "manual.md"),
      "manual body"
    );
    await fs.writeFile(
      path.join(tmpRoot, "documents", "manual.md.meta.json"),
      JSON.stringify({
        id: "manual-id",
        filename: "manual.md",
        namespace: "documents",
        producer: "manual",
        mime: "text/markdown",
        title: "Manual",
        created: "2026-05-08T00:00:00Z",
        updated: "2026-05-08T00:00:00Z"
      })
    );
    const result = await runCli(["--root", tmpRoot, "list"]);
    const rows = JSON.parse(result.stdout);
    expect(rows.find((row: { id: string }) => row.id === "manual-id")).toBeTruthy();
  });
});
