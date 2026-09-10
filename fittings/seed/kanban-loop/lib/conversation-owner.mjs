// The board is shared; conversation artifacts and their reply door stay home.
// Relay through the shell's closed mesh allow-list, never expose loopback URLs.
export async function relayCardConversation(req, res, { card, appUrl, fetchImpl = fetch }) {
  if (!card) return false;
  const method = req.method || "GET";
  if (card.frozen && method !== "GET") {
    res.writeHead(409, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "This card is frozen history and cannot take replies." }));
    return true;
  }
  const owner = card.placement?.target;
  if (!owner || owner === "host") return false;
  if (!appUrl) throw new Error("Cannot reach this conversation's node: the shell URL is not configured.");
  const incoming = new URL(req.url, "http://board.invalid");
  const suffix = incoming.pathname.slice("/api/".length);
  const target = `${appUrl.replace(/\/+$/, "")}/api/mesh/nodes/${encodeURIComponent(owner)}/${suffix}${incoming.search}`;
  const controller = new AbortController();
  const closed = () => controller.abort();
  res.on("close", closed);
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    let body;
    if (method !== "GET" && method !== "HEAD") {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 256 * 1024) throw new Error("Conversation reply is too large.");
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks);
    }
    const response = await fetchImpl(target, { method, body, signal: controller.signal,
      headers: { "content-type": "application/json", accept: req.headers.accept || "application/json" } });
    clearTimeout(timer);
    res.writeHead(response.status, { "content-type": response.headers.get("content-type") || "application/json", "cache-control": "no-store" });
    if (response.body) for await (const chunk of response.body) {
      if (!res.write(chunk)) await new Promise((resolve) => {
        const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
        res.once("drain", done); res.once("close", done);
      });
      if (controller.signal.aborted) break;
    }
    res.end();
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `The conversation on ${owner} is unavailable. Your reply has not been confirmed. Retry uses the same request id.` }));
    } else res.end();
  } finally { clearTimeout(timer); res.off("close", closed); controller.abort(); }
  return true;
}
