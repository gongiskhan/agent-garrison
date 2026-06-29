import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// D1 — the File Browser fitting. Real own-port server, scoped to a temp root.
// The security-critical surface: path-traversal confinement + credential refusal.

const REPO = path.resolve(__dirname, "..");
const START = path.join(REPO, "fittings", "seed", "file-browser", "scripts", "start.mjs");
const PORT = 7195;
const BASE = `http://127.0.0.1:${PORT}`;

let srv: ChildProcess | null = null;
let root: string;
let outside: string;

async function waitHealthy(ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(`${BASE}/health`)).ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "garrison-fb-"));
  outside = mkdtempSync(path.join(tmpdir(), "garrison-fb-out-"));
  mkdirSync(path.join(root, "reports"));
  writeFileSync(path.join(root, "reports", "q3.md"), "# Q3\n\nrevenue up");
  writeFileSync(path.join(root, "notes.txt"), "hello");
  writeFileSync(path.join(root, "vault.json"), '{"secret":"NOPE"}'); // must NOT be browsable
  writeFileSync(path.join(outside, "target.txt"), "ORIGINAL");
  symlinkSync(outside, path.join(root, "linkdir")); // symlinked dir -> outside
  symlinkSync(path.join(outside, "target.txt"), path.join(root, "linkfile.txt")); // symlinked file -> outside
  srv = spawn("node", [START], {
    env: { ...process.env, GARRISON_FILEBROWSER_ROOT: root, FILEBROWSER_UI_PORT: String(PORT), FILEBROWSER_UI_HOST: "127.0.0.1" },
    stdio: "ignore"
  });
  await waitHealthy(8000);
});

afterAll(() => {
  if (srv && !srv.killed) srv.kill("SIGTERM");
  srv = null;
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("file-browser fitting (D1)", () => {
  it("lists the scoped root (dirs first), hiding credential files", async () => {
    const data = await (await fetch(`${BASE}/api/tree?path=`)).json();
    const names = data.items.map((i: any) => i.name);
    expect(names).toContain("reports");
    expect(names).toContain("notes.txt");
    expect(names).not.toContain("vault.json"); // sensitive file hidden
    expect(data.items[0].type).toBe("dir"); // dirs first
  });

  it("reads a text file and classifies markdown", async () => {
    const txt = await (await fetch(`${BASE}/api/file?path=notes.txt`)).json();
    expect(txt.content).toBe("hello");
    expect(txt.kind).toBe("text");
    const md = await (await fetch(`${BASE}/api/file?path=${encodeURIComponent("reports/q3.md")}`)).json();
    expect(md.kind).toBe("markdown");
    expect(md.content).toContain("# Q3");
  });

  it("writes a file within the root", async () => {
    const w = await (await fetch(`${BASE}/api/file`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "reports/new.txt", content: "written" })
    })).json();
    expect(w.ok).toBe(true);
    const r = await (await fetch(`${BASE}/api/file?path=${encodeURIComponent("reports/new.txt")}`)).json();
    expect(r.content).toBe("written");
  });

  it("REFUSES path traversal out of the root", async () => {
    const res = await fetch(`${BASE}/api/file?path=${encodeURIComponent("../../../etc/passwd")}`);
    expect(res.status).toBe(403);
    const w = await fetch(`${BASE}/api/file`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "../escape.txt", content: "x" })
    });
    expect(w.status).toBe(403);
  });

  it("REFUSES to serve a credential file even by direct path", async () => {
    const res = await fetch(`${BASE}/api/file?path=vault.json`);
    expect(res.status).toBe(403);
  });

  it("REFUSES to READ through a symlinked file pointing outside (O_NOFOLLOW)", async () => {
    const res = await fetch(`${BASE}/api/file?path=linkfile.txt`);
    expect(res.status).toBe(403);
  });

  it("REFUSES to write THROUGH a symlinked dir that points outside the root", async () => {
    const w = await fetch(`${BASE}/api/file`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "linkdir/pwned.txt", content: "x" })
    });
    expect(w.status).toBe(403);
    const { readFileSync, existsSync } = await import("node:fs");
    expect(existsSync(path.join(outside, "pwned.txt"))).toBe(false);
  });

  it("REFUSES to overwrite THROUGH an existing symlinked file pointing outside", async () => {
    const w = await fetch(`${BASE}/api/file`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "linkfile.txt", content: "HACKED" })
    });
    expect(w.status).toBe(403);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(path.join(outside, "target.txt"), "utf8")).toBe("ORIGINAL"); // untouched
  });

  it("rejects a cross-origin request (CSRF guard)", async () => {
    const res = await fetch(`${BASE}/api/tree?path=`, { headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });
});
