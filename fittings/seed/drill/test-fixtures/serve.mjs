// D5 fixture app server — a tiny static file server for the two deterministic
// self-test pages (chat.html, build.html). All vision self-tests run against
// this fixture so they are reproducible. Not part of the shipped fitting
// runtime; test assets only.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function createFixtureServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    let rel = url.pathname === "/" ? "/chat.html" : url.pathname;
    const resolved = path.resolve(HERE, "." + rel);
    if (resolved !== HERE && !resolved.startsWith(HERE + path.sep)) {
      res.writeHead(403); res.end("forbidden"); return;
    }
    try {
      const body = await readFile(resolved, "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    } catch {
      res.writeHead(404); res.end("not found");
    }
  });
}

export async function startFixtureServer(port) {
  const server = createFixtureServer();
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT || 7250);
  await startFixtureServer(port);
  console.log(`drill fixture app on http://127.0.0.1:${port}`);
}
