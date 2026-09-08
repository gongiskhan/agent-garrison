// Cursor IDE can keep recent composers only in its own SQLite store. Read the
// selected composer's visible message text through its ordered bubble headers;
// never export the database, attached files, workspace state or credentials.
import { execFileSync } from "node:child_process";

export function readCursorDesktopTranscript(file, composerId) {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(String(composerId))) return { available: false, events: [] };
  const sql = `select json_extract(b.value, '$.bubbleId') as id,
    json_extract(b.value, '$.type') as role,
    substr(json_extract(b.value, '$.text'), 1, 20000) as text,
    substr(json_extract(b.value, '$.thinking.text'), 1, 10000) as thinking
    from cursorDiskKV c, json_each(c.value, '$.fullConversationHeadersOnly') h
    join cursorDiskKV b on b.key = 'bubbleId:${composerId}:' || json_extract(h.value, '$.bubbleId')
    where c.key = 'composerData:${composerId}' and json_valid(c.value) and json_valid(b.value)
    order by cast(h.key as integer) desc limit 100`;
  try {
    const out = execFileSync("sqlite3", ["-readonly", "-json", file, sql], {
      encoding: "utf8", timeout: 2000, maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });
    const events = JSON.parse(out || "[]").reverse().flatMap((row) => {
      const blocks = [];
      if (typeof row.thinking === "string" && row.thinking) blocks.push({ type: "thinking", text: row.thinking });
      if (typeof row.text === "string" && row.text) blocks.push({ type: "text", text: row.text });
      return blocks.length ? [{ id: `cursor-db:${row.id}`, role: row.role === 1 ? "user" : "assistant", ts: null, blocks }] : [];
    });
    return { available: true, events };
  } catch { return { available: false, events: [] }; }
}
