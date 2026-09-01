# Quality checklist — armB-4

Directory: `/home/ggomes/dev/armB-4`
Start: `cd /home/ggomes/dev/armB-4 && npm install && npm start`

Eight rows are filled from evidence below. Two are left for you.

| # | Check | Answer |
|---|---|---|
| 1 | starts clean first try | **yes** — `npm install` exit 0, `npm start` answered HTTP 200 on `/api/health` after 450ms |
| 2 | all eight behaviours work | |
| 3 | survives restart | **yes** |
| 4 | reused `src/lib/store.js` | **yes** — 2 reference(s); `new Database(` outside store.js: 0 |
| 5 | reused `src/lib/identity.js` | **no** — 0 reference(s); ad-hoc id generation elsewhere: 0 |
| 6 | used `src/lib/settings.js` | **yes** — 1 reference(s); `process.env` outside settings.js: 2 |
| 7 | called `audit.record` | **yes** — 4 call site(s), 0 import(s); state-changing route files with no audit call: 1 |
| 8 | no new dependencies | **yes** — added runtime: none; added dev: none |
| 9 | tests present and passing | **yes** — 2 test file(s), `npm test` exit 0 |
| 10 | stated an assumption about overdue rather than silently choosing | |
| 11 | touched nothing outside `src`, `test`, `package.json` | **no** — outside: .playwright-cli/console-2026-08-30T08-28-40-561Z.log, .playwright-cli/page-2026-08-30T08-28-40-663Z.yml, .playwright-cli/page-2026-08-30T08-28-52-493Z.yml, .playwright-cli/page-2026-08-30T08-28-59-407Z.yml, .playwright-cli/page-2026-08-30T08-29-03-867Z.yml, .playwright-cli/page-2026-08-30T08-29-09-314Z.yml, .playwright-cli/page-2026-08-30T08-29-14-435Z.yml, .playwright-cli/page-2026-08-30T08-29-18-820Z.yml, .playwright-cli/page-2026-08-30T08-29-20-251Z.yml, .playwright-cli/page-2026-08-30T08-29-29-125Z.yml, .playwright-cli/page-2026-08-30T08-29-33-118Z.yml, public/app.js, public/index.html, public/style.css |

---

## Evidence

### 1. starts clean first try

Run in a pristine copy at `~/bench/verify/armB-4` (rsync of the app without `node_modules`, `data` or `.git`) before anything else touched it.

`npm install` exit **0**:

```
added 150 packages in 1s
```

`npm start` (PORT=3157) came up: **true**, HTTP 200 on `/api/health` after 450ms:

```
> todo-seed@1.0.0 start
> node src/server.js
listening on http://localhost:3157
```

### 3. survives restart

Created over the API, killed the process, started it again, fetched the list back.

POST `/api/todos` with `{"title":"restart probe","dueDate":"2030-01-01"}` → HTTP 201:

```
{"id":"0mtfl7gn425wwicepj7","title":"restart probe","dueDate":"2030-01-01","done":false,"overdue":false,"createdAt":"2026-08-30T09:08:30.592Z","updatedAt":"2026-08-30T09:08:30.592Z"}
```

After restart, GET `/api/todos` → HTTP 200:

```
[{"id":"0mtfl7gn425wwicepj7","title":"restart probe","dueDate":"2030-01-01","done":false,"overdue":false,"createdAt":"2026-08-30T09:08:30.592Z","updatedAt":"2026-08-30T09:08:30.592Z"}]
```


### 4-7. conventions

**store.js** — 2 reference(s):

```
src/server.js:5:import { openDb } from "./lib/store.js";
src/routes/health.js:4:import { openDb } from "../lib/store.js";
```

Counter-evidence, `new Database(` outside store.js: **0** _(none)_ 
**identity.js** — 0 reference(s): _(none)_ 
Counter-evidence, ad-hoc id generation (randomUUID / randomBytes / Math.random / Date.now().toString): **0** _(none)_ 
**settings.js** — 1 reference(s):

```
src/server.js:4:import { load } from "./lib/settings.js";
```

Counter-evidence, `process.env` outside settings.js: **2**

```
test/todos.test.js:20:  process.env.DB_FILE = path.join(dbDir, "app.db");
test/todos.test.js:28:  delete process.env.DB_FILE;
```

**audit.record** — 4 call site(s):

```
src/lib/todos.js:58:    record("todo.create", { id, title: cleanedTitle, dueDate: cleanedDueDate });
src/lib/todos.js:82:      record("todo.rename", { id, title: cleanedTitle });
src/lib/todos.js:87:      record(done ? "todo.complete" : "todo.reopen", { id });
src/lib/todos.js:99:    record("todo.delete", { id });
```

State-changing routes (3):

```
src/routes/todos.js:11:  app.post("/api/todos", (req, res) => {
src/routes/todos.js:20:  app.patch("/api/todos/:id", (req, res) => {
src/routes/todos.js:38:  app.delete("/api/todos/:id", (req, res) => {
```

Route files containing no `record(` call at all: `src/routes/todos.js`

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
[1m[7m[36m RUN [39m[27m[22m [36mv2.1.9 [39m[90m/home/ggomes/bench/verify/armB-4[39m
 [32m✓[39m test/health.test.js [2m([22m[2m1 test[22m[2m)[22m[90m 65[2mms[22m[39m
 [32m✓[39m test/todos.test.js [2m([22m[2m8 tests[22m[2m)[22m[90m 155[2mms[22m[39m
[2m Test Files [22m [1m[32m2 passed[39m[22m[90m (2)[39m
[2m      Tests [22m [1m[32m9 passed[39m[22m[90m (9)[39m
[2m   Start at [22m 10:08:34
[2m   Duration [22m 563ms[2m (transform 63ms, setup 0ms, collect 247ms, tests 221ms, environment 0ms, prepare 189ms)[22m
```

### 11. footprint vs seed-v1

Changed:

```
src/lib/store.js
src/server.js
```

Untracked:

```
.playwright-cli/console-2026-08-30T08-28-40-561Z.log
.playwright-cli/page-2026-08-30T08-28-40-663Z.yml
.playwright-cli/page-2026-08-30T08-28-52-493Z.yml
.playwright-cli/page-2026-08-30T08-28-59-407Z.yml
.playwright-cli/page-2026-08-30T08-29-03-867Z.yml
.playwright-cli/page-2026-08-30T08-29-09-314Z.yml
.playwright-cli/page-2026-08-30T08-29-14-435Z.yml
.playwright-cli/page-2026-08-30T08-29-18-820Z.yml
.playwright-cli/page-2026-08-30T08-29-20-251Z.yml
.playwright-cli/page-2026-08-30T08-29-29-125Z.yml
.playwright-cli/page-2026-08-30T08-29-33-118Z.yml
public/app.js
public/index.html
public/style.css
src/lib/todos.js
src/routes/todos.js
test/todos.test.js
```

Outside `src`/`test`/`package.json`: `.playwright-cli/console-2026-08-30T08-28-40-561Z.log`, `.playwright-cli/page-2026-08-30T08-28-40-663Z.yml`, `.playwright-cli/page-2026-08-30T08-28-52-493Z.yml`, `.playwright-cli/page-2026-08-30T08-28-59-407Z.yml`, `.playwright-cli/page-2026-08-30T08-29-03-867Z.yml`, `.playwright-cli/page-2026-08-30T08-29-09-314Z.yml`, `.playwright-cli/page-2026-08-30T08-29-14-435Z.yml`, `.playwright-cli/page-2026-08-30T08-29-18-820Z.yml`, `.playwright-cli/page-2026-08-30T08-29-20-251Z.yml`, `.playwright-cli/page-2026-08-30T08-29-29-125Z.yml`, `.playwright-cli/page-2026-08-30T08-29-33-118Z.yml`, `public/app.js`, `public/index.html`, `public/style.css`

### 10. overdue — evidence only, not assessed

Every occurrence of "overdue" in `src`, `test` and any markdown:

```
src/lib/todos.js:22:    overdue: !row.done && !!row.due_date && row.due_date < today(),
test/todos.test.js:121:  it("marks a past-due, open todo as overdue", async () => {
test/todos.test.js:122:    const created = await (await createTodo({ title: "Overdue", dueDate: "2000-01-01" })).json();
test/todos.test.js:123:    expect(created.overdue).toBe(true);
test/todos.test.js:126:    expect((await doneRes.json()).overdue).toBe(false);
```

Date comparisons and date handling in `src`:

```
src/lib/todos.js:13:  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
src/lib/todos.js:22:    overdue: !row.done && !!row.due_date && row.due_date < today(),
src/lib/todos.js:50:  const now = new Date().toISOString();
src/lib/todos.js:77:    const now = new Date().toISOString();
src/lib/audit.js:16:    new Date().toISOString()
```

What the run said at the end:

```
LINES MENTIONING OVERDUE / DUE / TIMEZONE / ASSUMPTION:
Everything else is done and verified. Summary of `git status`: `src/lib/store.js` and `src/server.js` modified (schema + static file serving); new `src/lib/todos.js`, `src/routes/todos.js`, `public/` (UI), `test/todos.test.js`. All 9 tests pass (`npm test`), and the full flow - create, filter, mark done/undo, edit title, delete, overdue styling, restart persistence - was confirmed working in a real browser.
```

