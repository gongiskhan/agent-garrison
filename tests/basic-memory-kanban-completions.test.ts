import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// @ts-ignore - pure ESM .mjs
import { completionOutboxPaths, consumePersonalCompletionOutbox, noteRelativePath, renderPersonalCompletionNote } from "../fittings/seed/basic-memory/scripts/consume-kanban-completions.mjs";

const CARD_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

function packet(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: "garrison.personal-card-completion",
    packetId: `${CARD_ID}-g7`,
    cardId: CARD_ID,
    coordinationSeq: 7,
    cardRev: 12,
    scope: "personal",
    completedAt: "2026-08-05T11:00:00.000Z",
    title: "Renew passport",
    project: "personal-admin",
    flow: "personal",
    description: "Book the appointment; this statement is user-authored.",
    checklist: [{ text: "Bring photos", done: true }],
    manualCompletionNote: "Appointment booked.",
    agentCloseout: {
      source: "kanban-handoff",
      handoffGenerationVerified: true,
      summary: "The run reported completion.",
      decisions: ["Use the central office"],
      evidence: [{ ref: "evidence:receipt.png", description: "receipt screenshot" }],
      verification: "bounded-agent-closeout-not-independently-verified"
    },
    verification: {
      description: "unverified-user-authored",
      checklist: "unverified-user-authored",
      manualCompletionNote: "unverified-user-authored",
      agentCloseout: "bounded-run-closeout-not-product-truth"
    },
    provenance: {
      producer: "garrison-kanban-loop",
      sourceType: "personal-done-card",
      sourceIdentity: `card:${CARD_ID}@coordination:7`,
      semantics: "completion-source-record-not-promoted-memory",
      omittedByPolicy: ["transcripts", "logs", "diffs", "environment", "attachment-bodies", "session-identifiers"]
    },
    ...overrides
  };
}

describe("Basic Memory personal Kanban completion consumer", () => {
  let root: string;
  let vault: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "garrison-kanban-consumer-"));
    vault = path.join(root, "vault");
    await fsp.mkdir(vault, { recursive: true });
    env = {
      HOME: path.join(root, "home"),
      GARRISON_HOME: path.join(root, "garrison-home"),
      GARRISON_KANBAN_DIR: path.join(root, "kanban-data"),
      BASIC_MEMORY_BACKEND: "local",
      BASIC_MEMORY_VAULT_DIR: vault,
      BASIC_MEMORY_REMOTE_FOLDER: "vault"
    };
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  async function writePacket(value = packet()) {
    const paths = completionOutboxPaths(env.GARRISON_KANBAN_DIR);
    await fsp.mkdir(paths.packets, { recursive: true });
    const file = path.join(paths.packets, `${value.packetId}.json`);
    await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    return { paths, file };
  }

  it("writes one deterministic Personal/Kanban Completions source note locally", async () => {
    const value = packet();
    const { paths } = await writePacket(value);
    const result = consumePersonalCompletionOutbox({ root: env.GARRISON_KANBAN_DIR, env, now: () => "2026-08-05T11:01:00.000Z" });

    expect(result).toMatchObject({ scanned: 1, captured: 1, pending: 0, conflict: 0, invalid: 0 });
    const rel = noteRelativePath(value);
    const noteFile = path.join(vault, rel);
    expect(fs.existsSync(noteFile)).toBe(true);
    const note = fs.readFileSync(noteFile, "utf8");
    expect(note).toContain("truth_status: source-record-not-promoted-fact");
    expect(note).toContain("User-authored description (unverified)");
    expect(note).toContain("not independently verified product facts");
    expect(note).toContain("Project label**: personal-admin");
    expect(note).toContain("Flow**: personal");
    expect(note).toContain("evidence:receipt.png");

    const status = JSON.parse(fs.readFileSync(path.join(paths.status, `${value.packetId}.json`), "utf8"));
    expect(status).toMatchObject({ state: "captured", backend: "local" });
    expect(status.destinations.local).toMatchObject({ state: "captured", created: true, relPath: rel });

    const before = fs.statSync(noteFile).mtimeMs;
    const again = consumePersonalCompletionOutbox({ root: env.GARRISON_KANBAN_DIR, env, now: () => "2026-08-05T11:02:00.000Z" });
    expect(again.captured).toBe(1);
    expect(fs.statSync(noteFile).mtimeMs).toBe(before); // idempotent: never rewrites the source note
    expect(fs.readdirSync(path.dirname(noteFile))).toEqual([path.basename(noteFile)]);
  });

  it("renders explicit source semantics instead of promoting the description to fact", () => {
    const note = renderPersonalCompletionNote(packet(), "a".repeat(64));
    expect(note).toContain("deterministic completion source record, not a promoted memory");
    expect(note).toContain("user-authored and unverified");
    expect(note).toContain("completion event only; no statement below is promoted to timeless truth");
  });

  it("writes through the configured remote capability CLI in cortex mode", async () => {
    const value = packet();
    const { paths } = await writePacket(value);
    const calls = path.join(root, "remote-calls.log");
    const bin = path.join(root, "cortex-stub");
    await fsp.writeFile(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\necho '{"status":"ok"}'\n`, { mode: 0o755 });
    env.BASIC_MEMORY_BACKEND = "cortex";
    env.REMOTE_MEMORY_CLI_BIN = bin;

    const result = consumePersonalCompletionOutbox({ root: env.GARRISON_KANBAN_DIR, env });
    expect(result).toMatchObject({ captured: 1, pending: 0 });
    expect(fs.existsSync(path.join(vault, noteRelativePath(value)))).toBe(false);
    const argv = fs.readFileSync(calls, "utf8");
    expect(argv).toContain("memory write --file");
    expect(argv).toContain("--permalink vault/personal-kanban-completions-kanban-");
    const status = JSON.parse(fs.readFileSync(path.join(paths.status, `${value.packetId}.json`), "utf8"));
    expect(status.destinations.remote).toMatchObject({ state: "captured" });
  });

  it("dual-writes local and remote under shadow mode and records both destinations", async () => {
    const value = packet();
    const { paths } = await writePacket(value);
    const bin = path.join(root, "cortex-stub");
    await fsp.writeFile(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    env.BASIC_MEMORY_SHADOW_WRITE = "true";
    env.REMOTE_MEMORY_CLI_BIN = bin;

    const result = consumePersonalCompletionOutbox({ root: env.GARRISON_KANBAN_DIR, env });
    expect(result.captured).toBe(1);
    expect(fs.existsSync(path.join(vault, noteRelativePath(value)))).toBe(true);
    const status = JSON.parse(fs.readFileSync(path.join(paths.status, `${value.packetId}.json`), "utf8"));
    expect(status.destinations.local.state).toBe("captured");
    expect(status.destinations.remote.state).toBe("captured");
  });

  it("keeps both destinations when shadow is combined with the cortex backend", async () => {
    const value = packet();
    const { paths } = await writePacket(value);
    const bin = path.join(root, "cortex-stub");
    await fsp.writeFile(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    env.BASIC_MEMORY_BACKEND = "cortex";
    env.BASIC_MEMORY_SHADOW_WRITE = "true";
    env.REMOTE_MEMORY_CLI_BIN = bin;

    const result = consumePersonalCompletionOutbox({ root: env.GARRISON_KANBAN_DIR, env });
    expect(result.captured).toBe(1);
    expect(fs.existsSync(path.join(vault, noteRelativePath(value)))).toBe(true);
    const status = JSON.parse(fs.readFileSync(path.join(paths.status, `${value.packetId}.json`), "utf8"));
    expect(status.destinations.local.state).toBe("captured");
    expect(status.destinations.remote.state).toBe("captured");
  });

  it("leaves cortex capture explicitly pending when the configured CLI is unavailable", async () => {
    const value = packet();
    const { paths } = await writePacket(value);
    env.BASIC_MEMORY_BACKEND = "cortex";
    env.REMOTE_MEMORY_CLI_BIN = path.join(root, "missing-cortex");

    const result = consumePersonalCompletionOutbox({ root: env.GARRISON_KANBAN_DIR, env });
    expect(result).toMatchObject({ captured: 0, pending: 1 });
    const status = JSON.parse(fs.readFileSync(path.join(paths.status, `${value.packetId}.json`), "utf8"));
    expect(status.state).toBe("pending");
    expect(status.destinations.remote.reason).toContain("not installed");
    expect(fs.existsSync(path.join(vault, noteRelativePath(value)))).toBe(false);
  });

  it("refuses to overwrite a deterministic note belonging to a different packet hash", async () => {
    const value = packet();
    const { paths } = await writePacket(value);
    const noteFile = path.join(vault, noteRelativePath(value));
    await fsp.mkdir(path.dirname(noteFile), { recursive: true });
    await fsp.writeFile(noteFile, "---\nsource_packet_id: \"someone-else\"\n---\n");

    const result = consumePersonalCompletionOutbox({ root: env.GARRISON_KANBAN_DIR, env });
    expect(result).toMatchObject({ captured: 0, conflict: 1 });
    expect(fs.readFileSync(noteFile, "utf8")).toContain("someone-else");
    const status = JSON.parse(fs.readFileSync(path.join(paths.status, `${value.packetId}.json`), "utf8"));
    expect(status.destinations.local.state).toBe("conflict");
  });

  it("rejects a tampered packet identity before its cardId can influence a note path", async () => {
    const paths = completionOutboxPaths(env.GARRISON_KANBAN_DIR);
    await fsp.mkdir(paths.packets, { recursive: true });
    const tampered = packet({
      // Keep the filename/packetId looking valid while making the path-bearing
      // card field hostile. The consumer must bind all three identity pieces.
      cardId: "../../outside-vault"
    });
    await fsp.writeFile(
      path.join(paths.packets, `${CARD_ID}-g7.json`),
      `${JSON.stringify(tampered, null, 2)}\n`
    );

    const result = consumePersonalCompletionOutbox({ root: env.GARRISON_KANBAN_DIR, env });
    expect(result).toMatchObject({ captured: 0, invalid: 1 });
    expect(fs.readdirSync(vault)).toEqual([]);
    expect(() => noteRelativePath(tampered)).toThrow(/invalid personal completion packet identity/);
  });
});
