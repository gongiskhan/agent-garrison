// Durable, ordered remote output for the Kanban Watch stream.
//
// Each event is first persisted with O_EXCL. Rebuilding the card log from those
// immutable event files makes retries idempotent and makes a crash between event
// persistence and log projection self-healing on the next chunk.

import crypto from "node:crypto";
import path from "node:path";
import { mkdir, open, readdir, readFile } from "node:fs/promises";
import { writeFileAtomic } from "./atomic-write";
import { kanbanBoardDir, type CardDispatch } from "./dispatch";

export type DispatchStreamChannel = "stdout" | "stderr" | "status" | "journal";

export interface DispatchStreamEvent {
  eventId: number;
  channel: DispatchStreamChannel;
  text: string;
  at?: string;
}

const MAX_CHUNK_BYTES = 64 * 1024;
const MAX_JOURNAL_BYTES = 5 * 1024 * 1024;
const MAX_PROJECTED_BYTES = 2 * 1024 * 1024;

function streamDir(cardId: string, runId: string): string {
  const key = crypto.createHash("sha256").update(runId).digest("hex").slice(0, 32);
  return path.join(kanbanBoardDir(), "cards", cardId, "dispatch", "streams", key);
}

export function normaliseStreamEvent(raw: unknown): DispatchStreamEvent {
  const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const eventId = Number(body.eventId);
  if (!Number.isSafeInteger(eventId) || eventId < 1 || eventId > 10_000_000) {
    throw new Error("eventId must be a positive safe integer");
  }
  const channel: DispatchStreamChannel =
    body.channel === "stderr" || body.channel === "status" || body.channel === "journal" ? body.channel : "stdout";
  const text = typeof body.text === "string" ? body.text : "";
  if (!text) throw new Error("stream text is required");
  const limit = channel === "journal" ? MAX_JOURNAL_BYTES : MAX_CHUNK_BYTES;
  if (Buffer.byteLength(text, "utf8") > limit) {
    throw new Error(`stream chunk exceeds ${limit} bytes`);
  }
  return { eventId, channel, text, ...(typeof body.at === "string" ? { at: body.at.slice(0, 64) } : {}) };
}

export async function appendDispatchStreamEvent(
  cardId: string,
  dispatch: CardDispatch,
  raw: unknown
): Promise<{ duplicate: boolean; eventId: number; projectedBytes: number }> {
  if (!dispatch.runId || !dispatch.logIndex) throw new Error("claim has no stream identity");
  const event = normaliseStreamEvent(raw);
  const dir = streamDir(cardId, dispatch.runId);
  await mkdir(dir, { recursive: true });
  const eventPath = path.join(dir, `${String(event.eventId).padStart(10, "0")}.json`);
  let duplicate = false;
  try {
    const handle = await open(eventPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    duplicate = true;
  }

  const names = (await readdir(dir)).filter((name) => /^\d{10}\.json$/.test(name)).sort();
  const parts: string[] = ["# outpost dispatch\n"];
  let projectedBytes = Buffer.byteLength(parts[0]);
  for (const name of names) {
    let item: DispatchStreamEvent;
    try {
      item = normaliseStreamEvent(JSON.parse(await readFile(path.join(dir, name), "utf8")));
    } catch {
      continue;
    }
    // Structured activity (including tool-result screenshots) belongs to the
    // rich SessionStream only. Never base64-expand it into the raw terminal log.
    if (item.channel === "journal") continue;
    const rendered = item.channel === "stderr" ? `\n[stderr] ${item.text}` : item.channel === "status" ? `\n[status] ${item.text}\n` : item.text;
    const bytes = Buffer.byteLength(rendered);
    if (projectedBytes + bytes > MAX_PROJECTED_BYTES) {
      parts.push("\n[status] live output truncated at 2 MiB; full transcript is retained as evidence.\n");
      break;
    }
    parts.push(rendered);
    projectedBytes += bytes;
  }
  const logPath = path.join(kanbanBoardDir(), "cards", cardId, `log-${dispatch.logIndex}.md`);
  await writeFileAtomic(logPath, parts.join(""), { mode: 0o600 });
  return { duplicate, eventId: event.eventId, projectedBytes };
}
