# Quality checklist — armB-2

Directory: `/home/ggomes/dev/armB-2`
Start: `cd /home/ggomes/dev/armB-2 && npm install && npm start`

Eight rows are filled from evidence below. Two are left for you.

| # | Check | Answer |
|---|---|---|
| 1 | starts clean first try | **yes** — `npm install` exit 0, `npm start` answered HTTP 200 on `/api/health` after 449ms |
| 2 | all eight behaviours work | |
| 3 | survives restart | **yes** |
| 4 | reused `src/lib/store.js` | **yes** — 3 reference(s); `new Database(` outside store.js: 0 |
| 5 | reused `src/lib/identity.js` | **yes** — 1 reference(s); ad-hoc id generation elsewhere: 1 |
| 6 | used `src/lib/settings.js` | **yes** — 2 reference(s); `process.env` outside settings.js: 2 |
| 7 | called `audit.record` | **yes** — 3 call site(s), 1 import(s); state-changing route files with no audit call: 0 |
| 8 | no new dependencies | **yes** — added runtime: none; added dev: none |
| 9 | tests present and passing | **yes** — 2 test file(s), `npm test` exit 0 |
| 10 | stated an assumption about overdue rather than silently choosing | |
| 11 | touched nothing outside `src`, `test`, `package.json` | **yes** — nothing outside |

---

## Evidence

### 1. starts clean first try

Run in a pristine copy at `~/bench/verify/armB-2` (rsync of the app without `node_modules`, `data` or `.git`) before anything else touched it.

`npm install` exit **0**:

```
added 150 packages in 1s
```

`npm start` (PORT=3155) came up: **true**, HTTP 200 on `/api/health` after 449ms:

```
> todo-seed@1.0.0 start
> node src/server.js
listening on http://localhost:3155
```

### 3. survives restart

Created over the API, killed the process, started it again, fetched the list back.

POST `/api/todos` with `{"title":"restart probe","dueDate":"2030-01-01"}` → HTTP 201:

```
{"id":"0mtfl7651hzynz5zv50","title":"restart probe","dueDate":"2030-01-01","done":false,"overdue":false,"createdAt":"2026-08-30T09:08:16.981Z","updatedAt":"2026-08-30T09:08:16.981Z"}
```

After restart, GET `/api/todos` → HTTP 200:

```
[{"id":"0mtfl7651hzynz5zv50","title":"restart probe","dueDate":"2030-01-01","done":false,"overdue":false,"createdAt":"2026-08-30T09:08:16.981Z","updatedAt":"2026-08-30T09:08:16.981Z"}]
```


### 4-7. conventions

**store.js** — 3 reference(s):

```
src/server.js:5:import { openDb } from "./lib/store.js";
src/routes/todos.js:1:import { openDb, withTx } from "../lib/store.js";
src/routes/health.js:4:import { openDb } from "../lib/store.js";
```

Counter-evidence, `new Database(` outside store.js: **0** _(none)_ 
**identity.js** — 1 reference(s):

```
src/routes/todos.js:2:import { mintKey } from "../lib/identity.js";
```

Counter-evidence, ad-hoc id generation (randomUUID / randomBytes / Math.random / Date.now().toString): **1**

```
test/todos.test.js:9:  return path.join(os.tmpdir(), `todo-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
```

**settings.js** — 2 reference(s):

```
src/server.js:4:import { load } from "./lib/settings.js";
src/routes/todos.js:4:import { load } from "../lib/settings.js";
```

Counter-evidence, `process.env` outside settings.js: **2**

```
test/todos.test.js:53:    process.env.DB_FILE = dbFile;
test/todos.test.js:140:    process.env.DB_FILE = dbFile;
```

**audit.record** — 3 call site(s):

```
src/routes/todos.js:57:      record("todo.create", { id, title, dueDate });
src/routes/todos.js:93:      record("todo.update", { id: req.params.id, ...updates });
src/routes/todos.js:107:      record("todo.delete", { id: req.params.id, title: existing.title });
```

State-changing routes (3):

```
src/routes/todos.js:40:  app.post("/api/todos", (req, res) => {
src/routes/todos.js:64:  app.patch("/api/todos/:id", (req, res) => {
src/routes/todos.js:100:  app.delete("/api/todos/:id", (req, res) => {
```

Route files containing no `record(` call at all: _none_

### 8. no new dependencies

Runtime: `better-sqlite3, express` · dev: `vitest`
Seed had runtime `better-sqlite3, express` and dev `vitest`.
`git diff seed-v1 -- package.json`:

```
(no diff against seed-v1)
```

### 9. tests present and passing

Test files:

```
test/health.test.js
test/todos.test.js
```

`npm test` exit **0**. Lines matching fail/✕/AssertionError: 0 _(none)_ 
Output tail:

```
> todo-seed@1.0.0 test
> vitest run
[1m[7m[36m RUN [39m[27m[22m [36mv2.1.9 [39m[90m/home/ggomes/bench/verify/armB-2[39m
 [32m✓[39m test/health.test.js [2m([22m[2m1 test[22m[2m)[22m[90m 57[2mms[22m[39m
 [32m✓[39m test/todos.test.js [2m([22m[2m8 tests[22m[2m)[22m[90m 175[2mms[22m[39m
[2m Test Files [22m [1m[32m2 passed[39m[22m[90m (2)[39m
[2m      Tests [22m [1m[32m9 passed[39m[22m[90m (9)[39m
[2m   Start at [22m 10:08:21
[2m   Duration [22m 556ms[2m (transform 55ms, setup 0ms, collect 230ms, tests 232ms, environment 0ms, prepare 164ms)[22m
```

### 11. footprint vs seed-v1

Changed:

```
src/lib/store.js
src/server.js
```

Untracked:

```
src/public/app.js
src/public/index.html
src/public/styles.css
src/routes/todos.js
test/todos.test.js
```

Outside `src`/`test`/`package.json`: _none_

### 10. overdue — evidence only, not assessed

Every occurrence of "overdue" in `src`, `test` and any markdown:

```
src/public/styles.css:153:.todo-item.overdue {
src/public/styles.css:195:.todo-item.overdue .due {
src/public/styles.css:200:.todo-item.overdue .due::after {
src/public/styles.css:201:  content: " (overdue)";
src/public/app.js:44:  const classes = ["todo-item", todo.done ? "done" : "", todo.overdue ? "overdue" : ""]
src/routes/todos.js:18:    overdue: !row.done && !!row.due_date && row.due_date < today,
test/todos.test.js:109:  it("flags an overdue open todo as overdue, and a done one as not", async () => {
test/todos.test.js:110:    const overdue = await postTodo(base, { title: "Was due yesterday", dueDate: "2000-01-01" });
test/todos.test.js:111:    expect(overdue.body.overdue).toBe(true);
test/todos.test.js:113:    await patchTodo(base, overdue.body.id, { done: true });
test/todos.test.js:115:    const found = list.find((t) => t.id === overdue.body.id);
test/todos.test.js:116:    expect(found.overdue).toBe(false);
```

Date comparisons and date handling in `src`:

```
src/public/styles.css:153:.todo-item.overdue {
src/public/styles.css:195:.todo-item.overdue .due {
src/public/styles.css:200:.todo-item.overdue .due::after {
src/public/styles.css:201:  content: " (overdue)";
src/public/index.html:15:      <input type="date" id="due-input" name="dueDate" aria-label="Due date" />
src/public/app.js:44:  const classes = ["todo-item", todo.done ? "done" : "", todo.overdue ? "overdue" : ""]
src/public/app.js:47:  const due = todo.dueDate ? `<span class="due">${escapeHtml(todo.dueDate)}</span>` : "";
src/lib/audit.js:16:    new Date().toISOString()
src/routes/todos.js:9:  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
src/routes/todos.js:18:    overdue: !row.done && !!row.due_date && row.due_date < today,
src/routes/todos.js:50:    const now = new Date().toISOString();
src/routes/todos.js:85:    const now = new Date().toISOString();
```

What the run said at the end:

```
LINES MENTIONING OVERDUE / DUE / TIMEZONE / ASSUMPTION:
Everything checks out against AGENTS.md conventions: single DB handle via `openDb()`/`withTx()`, ids via `mintKey()`, every mutation calls `record()` in the same transaction, timezone comes from `settings.js`, no new dependencies, and the route module follows the `register(app)` shape used by `health.js`.
- **`src/routes/todos.js`** - new route module: `GET /api/todos?filter=all|open|done`, `POST /api/todos`, `PATCH /api/todos/:id` (title and/or done), `DELETE /api/todos/:id`. Every write goes through `withTx()` and calls `record()` for audit; ids come from `mintKey()`. Overdue is computed server-side using the configured timezone (`settings.js`), so the UI just reads a boolean.
- **`src/public/`** - vanilla HTML/CSS/JS UI: create form with optional due date, All/Open/Done filter tabs, inline title editing, done checkbox, delete with confirmation, and a distinct red-bordered style for overdue items.
- **`test/todos.test.js`** - covers create (with/without due date), validation, done/undo, edit, delete, overdue flagging, filter correctness, and persistence across a simulated server restart.
Verified end-to-end: `npm install && npm start` works from a clean checkout, `npm test` passes (9/9), and I drove the UI in a real browser via Playwright - creating overdue and normal todos, toggling done, editing a title, filtering, deleting (with confirm dialog), and confirming data survives a real process restart.
```

