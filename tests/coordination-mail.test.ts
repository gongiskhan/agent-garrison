// GARRISON-FLOW-V2 S2 (Q9) — the coordination mail abstraction. The durable file
// record lands in BOTH runDirs with an honest transport, a ledger mail row is
// appended, and the agent-mail transport is used when the status-file contract
// points at a reachable MCP endpoint.
import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "gh-mail-"));
process.env.GARRISON_HOME = HOME;

// @ts-ignore — pure .mjs
import { sendCoordMail } from "../fittings/seed/kanban-loop/lib/coord-mail.mjs";
// @ts-ignore — pure .mjs
import { createCard, loadCard } from "../fittings/seed/kanban-loop/lib/board.mjs";

const kroot = () => mkdtempSync(join(tmpdir(), "mail-kanban-"));
const runDir = (tag: string) => {
  const d = mkdtempSync(join(tmpdir(), `mail-run-${tag}-`));
  return d;
};

// The ledger file for a repo path (mirrors coordination.repoSlug — sha1[:16]).
async function ledgerRows(repoPath: string) {
  const crypto = await import("node:crypto");
  const path = await import("node:path");
  const slug = crypto.createHash("sha1").update(path.resolve(repoPath)).digest("hex").slice(0, 16);
  const file = join(HOME, "coord", "intents", `${slug}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function mailFiles(dir: string) {
  const d = join(dir, "coordination", "mail");
  return existsSync(d) ? readdirSync(d) : [];
}

describe("sendCoordMail — file fallback (agent-mail absent)", () => {
  it("writes the record into BOTH runDirs with transport 'file' + a ledger mail row", async () => {
    const root = kroot();
    const repoPath = mkdtempSync(join(tmpdir(), "mail-repo-"));
    const from = await createCard(root, { title: "from", project: "p", list: "review" });
    const to = await createCard(root, { title: "to", project: "p", list: "implement" });
    const fromCard = { ...from, runDir: runDir("from") };
    const toCard = { ...to, runDir: runDir("to") };

    const rec = await sendCoordMail({ root, fromCard, toCard, subject: "hi", body: "overlap heads-up", repoPath });

    expect(rec.transport).toBe("file"); // no coord-agentmail.json under this HOME
    expect(mailFiles(fromCard.runDir).length).toBe(1);
    expect(mailFiles(toCard.runDir).length).toBe(1);
    // both copies are identical and carry the honest transport
    const readOne = (dir: string) => JSON.parse(readFileSync(join(dir, "coordination", "mail", mailFiles(dir)[0]), "utf8"));
    expect(readOne(fromCard.runDir).transport).toBe("file");
    expect(readOne(toCard.runDir).fromCardId).toBe(from.id);

    // a mail row on the ledger
    const rows = await ledgerRows(repoPath);
    expect(rows.some((r: any) => r.kind === "mail" && r.session === `kanban:${from.id}`)).toBe(true);

    // a mail event on both cards
    expect((await loadCard(root, from.id)).events.some((e: any) => e.kind === "mail")).toBe(true);
    expect((await loadCard(root, to.id)).events.some((e: any) => e.kind === "mail")).toBe(true);
  });
});

describe("sendCoordMail — agent-mail transport (status-file contract)", () => {
  it("records transport 'agent-mail' when the MCP endpoint answers", async () => {
    // A stub MCP server: any POST gets a JSON-RPC result (no error).
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;
    // Write the own-port status file coord-mail reads.
    mkdirSync(join(HOME, "ui-fittings"), { recursive: true });
    writeFileSync(join(HOME, "ui-fittings", "coord-agentmail.json"), JSON.stringify({ url: `http://127.0.0.1:${port}`, mcpUrl: `http://127.0.0.1:${port}/mcp` }));

    try {
      const root = kroot();
      const from = await createCard(root, { title: "from2", project: "p", list: "review" });
      const to = await createCard(root, { title: "to2", project: "p", list: "implement" });
      const rec = await sendCoordMail({
        root,
        fromCard: { ...from, runDir: runDir("from2") },
        toCard: { ...to, runDir: runDir("to2") },
        subject: "hi",
        body: "via mcp"
      });
      expect(rec.transport).toBe("agent-mail");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
