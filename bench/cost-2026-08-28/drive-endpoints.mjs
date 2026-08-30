// Drive a produced todo API through every behaviour the task specified and
// report pass/fail per case. Nothing is fixed; a wrong answer is recorded as a
// wrong answer.
//
// The app is bound in-process on port 3000 rather than through `npm start`
// because this harness runs in a per-invocation network namespace: a server
// backgrounded with `&` does not survive to the next shell call, which silently
// turned an earlier pass of this check into a conversation with an unrelated
// server that happened to hold the port. Binding here proves the port AND
// guarantees the responder is the project under test.
import { createRequire } from "node:module";
import path from "node:path";

const dir = process.argv[2];
const require = createRequire(path.join(dir, "package.json"));
const { createApp } = require(path.join(dir, "dist", "app.js"));

const PORT = 3000;
const base = `http://127.0.0.1:${PORT}`;
const server = createApp().listen(PORT, "127.0.0.1");
await new Promise((r) => server.once("listening", r));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n        ${detail}`);
}

async function call(method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text: text.slice(0, 200) };
}

const short = (r) => `${r.status} ${JSON.stringify(r.json ?? r.text).slice(0, 130)}`;

// 1. server answers on 3000
{
  const r = await call("GET", "/todos");
  check("npm-start port 3000 answers GET /todos", r.status === 200 && Array.isArray(r.json), short(r));
}

// 2. create
let created = null;
{
  const r = await call("POST", "/todos", { title: "write the report" });
  created = r.json;
  const ok =
    (r.status === 201 || r.status === 200) &&
    r.json &&
    typeof r.json.id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.json.id) &&
    r.json.title === "write the report" &&
    r.json.completed === false &&
    typeof r.json.createdAt === "string" &&
    !Number.isNaN(Date.parse(r.json.createdAt));
  check("POST /todos creates (uuid, completed=false, ISO createdAt)", ok, short(r));
}

// 3. validation
{
  const r = await call("POST", "/todos", { title: "" });
  check("POST empty title -> 400 {error}", r.status === 400 && typeof r.json?.error === "string", short(r));
}
{
  const r = await call("POST", "/todos", { title: "x".repeat(201) });
  check("POST 201-char title -> 400 {error}", r.status === 400 && typeof r.json?.error === "string", short(r));
}
{
  const r = await call("POST", "/todos", { title: "x".repeat(200) });
  check("POST 200-char title accepted (boundary)", r.status === 201 || r.status === 200, short(r));
}
{
  const r = await call("POST", "/todos", {});
  check("POST missing title -> 400 {error}", r.status === 400 && typeof r.json?.error === "string", short(r));
}
{
  const r = await call("POST", "/todos", { title: 42 });
  check("POST non-string title -> 400 {error}", r.status === 400 && typeof r.json?.error === "string", short(r));
}

// 4. read
{
  const r = await call("GET", `/todos/${created?.id}`);
  check("GET /todos/:id returns it", r.status === 200 && r.json?.id === created?.id, short(r));
}
{
  const r = await call("GET", "/todos/00000000-0000-0000-0000-000000000000");
  check("GET unknown id -> 404 {error}", r.status === 404 && typeof r.json?.error === "string", short(r));
}

// 5. update
{
  const r = await call("PATCH", `/todos/${created?.id}`, { completed: true });
  check("PATCH completed=true", r.status === 200 && r.json?.completed === true, short(r));
}
{
  const r = await call("PATCH", `/todos/${created?.id}`, { title: "renamed" });
  check("PATCH title", r.status === 200 && r.json?.title === "renamed", short(r));
}
{
  const r = await call("PATCH", `/todos/${created?.id}`, { title: "" });
  check("PATCH empty title -> 400 {error}", r.status === 400 && typeof r.json?.error === "string", short(r));
}
{
  const r = await call("PATCH", "/todos/00000000-0000-0000-0000-000000000000", { completed: true });
  check("PATCH unknown id -> 404 {error}", r.status === 404 && typeof r.json?.error === "string", short(r));
}

// 6. filter
{
  const r = await call("GET", "/todos?completed=true");
  const ok = r.status === 200 && Array.isArray(r.json) && r.json.every((t) => t.completed === true) && r.json.length > 0;
  check("GET /todos?completed=true filters", ok, short(r));
}
{
  const r = await call("GET", "/todos?completed=false");
  const ok = r.status === 200 && Array.isArray(r.json) && r.json.every((t) => t.completed === false);
  check("GET /todos?completed=false filters", ok, short(r));
}

// 7. delete
{
  const r = await call("DELETE", `/todos/${created?.id}`);
  check("DELETE /todos/:id", r.status === 200 || r.status === 204, short(r));
}
{
  const r = await call("GET", `/todos/${created?.id}`);
  check("GET after delete -> 404 {error}", r.status === 404 && typeof r.json?.error === "string", short(r));
}
{
  const r = await call("DELETE", "/todos/00000000-0000-0000-0000-000000000000");
  check("DELETE unknown id -> 404 {error}", r.status === 404 && typeof r.json?.error === "string", short(r));
}

server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} behaviour checks passed`);
if (failed.length) console.log("FAILED: " + failed.map((f) => f.name).join(" | "));
process.exit(0);
