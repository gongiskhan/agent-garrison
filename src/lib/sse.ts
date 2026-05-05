/**
 * Read a Server-Sent Events stream from a fetch response body.
 *
 * Used by the chat panel to consume `/api/runner/[id]/chat` POST-SSE
 * (the runtime emits `chunk` / `tool` / `done` / `error` events).
 *
 * For one-way log tailing (`/api/runner/[id]/logs`), prefer the native
 * `EventSource` — it handles reconnection automatically.
 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: unknown) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (!block.trim()) continue;

      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          data += (data ? "\n" : "") + line.slice(5).trimStart();
        }
      }

      if (event === "open") continue;
      let parsed: unknown = null;
      if (data) {
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = { raw: data };
        }
      }
      onEvent(event, parsed);
    }
  }
}
