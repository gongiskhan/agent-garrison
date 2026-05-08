import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..");
const DOCS_PY = path.join(
  REPO_ROOT,
  "fittings",
  "seed",
  "documents",
  "scripts",
  "documents.py"
);
const ARTIFACTS_PY = path.join(
  REPO_ROOT,
  "fittings",
  "seed",
  "artifact-store",
  "scripts",
  "artifacts.py"
);

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function runDocs(
  root: string,
  args: string[],
  stdin?: string
): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn("python3", [DOCS_PY, ...args], {
      env: {
        ...process.env,
        GARRISON_ARTIFACTS_ROOT: root,
        GARRISON_ARTIFACTS_CLI: ARTIFACTS_PY
      }
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

describe("documents.py CLI", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "garrison-documents-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("create writes a .md artifact in the documents/ namespace", async () => {
    const result = await runDocs(
      tmpRoot,
      ["create", "--title", "Spec"],
      "## Spec body\n"
    );
    expect(result.exitCode).toBe(0);
    const id = result.stdout.trim();
    expect(id).toMatch(/^[0-9a-f]{32}$/);

    const namespaceDir = path.join(tmpRoot, "documents");
    const files = await fs.readdir(namespaceDir);
    const mdFiles = files.filter((f) => f.endsWith(".md"));
    expect(mdFiles).toHaveLength(1);
    const sidecarFiles = files.filter((f) => f.endsWith(".meta.json"));
    expect(sidecarFiles).toHaveLength(1);

    const sidecar = JSON.parse(
      await fs.readFile(path.join(namespaceDir, sidecarFiles[0]), "utf8")
    );
    expect(sidecar.id).toBe(id);
    expect(sidecar.namespace).toBe("documents");
    expect(sidecar.producer).toBe("documents");
    expect(sidecar.mime).toBe("text/markdown");
    expect(sidecar.title).toBe("Spec");
  });

  it("update preserves the id and bumps the updated timestamp", async () => {
    const create = await runDocs(
      tmpRoot,
      ["create", "--title", "Doc"],
      "first body\n"
    );
    const id = create.stdout.trim();
    // Sleep so the second write has a strictly later timestamp.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const update = await runDocs(tmpRoot, ["update", id], "second body\n");
    expect(update.exitCode).toBe(0);
    expect(update.stdout.trim()).toBe(id);

    const read = await runDocs(tmpRoot, ["read", id]);
    expect(read.stdout).toBe("second body\n");

    const list = await runDocs(tmpRoot, ["list"]);
    const rows = JSON.parse(list.stdout);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].title).toBe("Doc");
    expect(rows[0].updated > rows[0].created).toBe(true);
  });

  it("update returns 2 for an unknown id", async () => {
    const result = await runDocs(tmpRoot, ["update", "nope"], "body");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/not found/);
  });

  it("link prints garrison://documents/<id>", async () => {
    const create = await runDocs(
      tmpRoot,
      ["create", "--title", "Doc"],
      "body"
    );
    const id = create.stdout.trim();
    const link = await runDocs(tmpRoot, ["link", id]);
    expect(link.exitCode).toBe(0);
    expect(link.stdout.trim()).toBe(`garrison://documents/${id}`);
  });

  it("list filters to only documents-namespace artifacts", async () => {
    // Drop a non-documents artifact directly via artifacts.py to confirm
    // documents.py list doesn't return it.
    await new Promise<void>((resolve) => {
      const child = spawn(
        "python3",
        [
          ARTIFACTS_PY,
          "--root",
          tmpRoot,
          "write",
          "automations",
          "x.webm",
          "--mime",
          "video/webm"
        ],
        { stdio: ["pipe", "ignore", "ignore"] }
      );
      child.on("close", () => resolve());
      child.stdin.write("vid bytes");
      child.stdin.end();
    });
    await runDocs(tmpRoot, ["create", "--title", "Doc"], "body");

    const list = await runDocs(tmpRoot, ["list"]);
    const rows = JSON.parse(list.stdout);
    expect(rows).toHaveLength(1);
    expect(rows[0].namespace).toBe("documents");
  });

  it("--probe defers to artifacts.py --probe and succeeds", async () => {
    const result = await runDocs(tmpRoot, ["--probe"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  });
});
