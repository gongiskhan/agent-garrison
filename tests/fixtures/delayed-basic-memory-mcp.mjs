// Hermetic MCP startup fixture: tool discovery intentionally trails SDK startup.
import readline from "node:readline";
const input = readline.createInterface({ input: process.stdin });
for await (const line of input) {
  const message = JSON.parse(line);
  if (message.id == null) continue;
  let result = {};
  if (message.method === "initialize") {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "delayed-memory-fixture", version: "1" } };
  } else if (message.method === "tools/list") {
    result = { tools: [{ name: "read_note", description: "Read a fixture note", inputSchema: { type: "object", properties: {} } }] };
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
}
