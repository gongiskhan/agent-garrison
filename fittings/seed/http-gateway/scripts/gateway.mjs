import http from "node:http";

const port = Number(process.env.GARRISON_GATEWAY_PORT ?? "4777");
const host = process.env.GARRISON_GATEWAY_HOST ?? "127.0.0.1";

const server = http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ ok: true, path: request.url }));
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ component: "http-gateway", host, port }));
});
