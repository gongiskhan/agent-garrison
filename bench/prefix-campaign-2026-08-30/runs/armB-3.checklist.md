# Quality checklist — armB-3

Directory: `/home/ggomes/dev/armB-3`
Start: `cd /home/ggomes/dev/armB-3 && npm install && npm start`

Eight rows are filled from evidence below. Two are left for you.

| # | Check | Answer |
|---|---|---|
| 1 | starts clean first try | **yes** — `npm install` exit 0, `npm start` answered HTTP 200 on `/api/health` after 449ms |
| 2 | all eight behaviours work | |
| 3 | survives restart | **yes** |
| 4 | reused `src/lib/store.js` | **yes** — 3 reference(s); `new Database(` outside store.js: 0 |
| 5 | reused `src/lib/identity.js` | **yes** — 1 reference(s); ad-hoc id generation elsewhere: 2 |
| 6 | used `src/lib/settings.js` | **yes** — 2 reference(s); `process.env` outside settings.js: 0 |
| 7 | called `audit.record` | **yes** — 3 call site(s), 1 import(s); state-changing route files with no audit call: 0 |
| 8 | no new dependencies | **yes** — added runtime: none; added dev: none |
| 9 | tests present and passing | **yes** — 2 test file(s), `npm test` exit 0 |
| 10 | stated an assumption about overdue rather than silently choosing | |
| 11 | touched nothing outside `src`, `test`, `package.json` | **yes** — nothing outside |

---

## Evidence

### 1. starts clean first try

Run in a pristine copy at `~/bench/verify/armB-3` (rsync of the app without `node_modules`, `data` or `.git`) before anything else touched it.

`npm install` exit **0**:

```
added 150 packages in 1s
```

`npm start` (PORT=3156) came up: **true**, HTTP 200 on `/api/health` after 449ms:

```
> todo-seed@1.0.0 start
> node src/server.js
listening on http://localhost:3156
```

### 3. survives restart

Created over the API, killed the process, started it again, fetched the list back.

POST `/api/todos` with `{"title":"restart probe","dueDate":"2030-01-01"}` → HTTP 201:

```
{"id":"0mtfl7bey2bi2lxs9sw","title":"restart probe","dueDate":"2030-01-01","done":false,"overdue":false,"createdAt":"2026-08-30T09:08:23.818Z","updatedAt":"2026-08-30T09:08:23.818Z"}
```

After restart, GET `/api/todos` → HTTP 200:

```
[{"id":"0mtfl7bey2bi2lxs9sw","title":"restart probe","dueDate":"2030-01-01","done":false,"overdue":false,"createdAt":"2026-08-30T09:08:23.818Z","updatedAt":"2026-08-30T09:08:23.818Z"}]
```


### 4-7. conventions

**store.js** — 3 reference(s):

```
src/server.js:5:import { openDb } from "./lib/store.js";
src/routes/todos.js:4:import { openDb, withTx } from "../lib/store.js";
src/routes/health.js:4:import { openDb } from "../lib/store.js";
```

Counter-evidence, `new Database(` outside store.js: **0** _(none)_ 
**identity.js** — 1 reference(s):

```
src/routes/todos.js:5:import { mintKey } from "../lib/identity.js";
```

Counter-evidence, ad-hoc id generation (randomUUID / randomBytes / Math.random / Date.now().toString): **2**

```
test/todos.test.js:73:      const open = await postTodo(base, { title: `Open task ${Math.random()}` }).then((r) => r.json());
test/todos.test.js:74:      const done = await postTodo(base, { title: `Done task ${Math.random()}` }).then((r) => r.json());
```

**settings.js** — 2 reference(s):

```
src/server.js:4:import { load } from "./lib/settings.js";
src/routes/todos.js:7:import { load } from "../lib/settings.js";
```

Counter-evidence, `process.env` outside settings.js: **0** _(none)_ 
**audit.record** — 3 call site(s):

```
src/routes/todos.js:66:      record("todo.created", { id, title, dueDate });
src/routes/todos.js:102:      record("todo.updated", { id: req.params.id, ...updates });
src/routes/todos.js:116:      record("todo.deleted", { id: req.params.id });
```

State-changing routes (3):

```
src/routes/todos.js:51:  app.post("/api/todos", (req, res) => {
src/routes/todos.js:71:  app.patch("/api/todos/:id", (req, res) => {
src/routes/todos.js:108:  app.delete("/api/todos/:id", (req, res) => {
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
[1m[7m[36m RUN [39m[27m[22m [36mv2.1.9 [39m[90m/home/ggomes/bench/verify/armB-3[39m
 [32m✓[39m test/health.test.js [2m([22m[2m1 test[22m[2m)[22m[90m 53[2mms[22m[39m
 [32m✓[39m test/todos.test.js [2m([22m[2m6 tests[22m[2m)[22m[90m 156[2mms[22m[39m
[2m Test Files [22m [1m[32m2 passed[39m[22m[90m (2)[39m
[2m      Tests [22m [1m[32m7 passed[39m[22m[90m (7)[39m
[2m   Start at [22m 10:08:28
[2m   Duration [22m 541ms[2m (transform 58ms, setup 0ms, collect 228ms, tests 209ms, environment 0ms, prepare 167ms)[22m
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
src/public/styles.css:146:.todo-item.is-overdue {
src/public/styles.css:191:.todo-item.is-overdue .todo-due {
src/public/app.js:44:  if (todo.overdue) item.classList.add("is-overdue");
src/public/app.js:78:    dueEl.textContent = (todo.overdue ? "Overdue - due " : "Due ") + formatDue(todo.dueDate);
src/routes/todos.js:25:    overdue: !row.done && !!row.due_date && row.due_date < todayStr,
test/todos.test.js:114:  it("flags a past-due, open todo as overdue", async () => {
test/todos.test.js:116:      const overdue = await postTodo(base, { title: "Was due yesterday", dueDate: "2000-01-01" }).then((r) =>
test/todos.test.js:119:      expect(overdue.overdue).toBe(true);
test/todos.test.js:121:      await fetch(`${base}/api/todos/${overdue.id}`, {
test/todos.test.js:127:      const stillThere = all.find((t) => t.id === overdue.id);
test/todos.test.js:128:      expect(stillThere.overdue).toBe(false);
```

Date comparisons and date handling in `src`:

```
src/public/styles.css:146:.todo-item.is-overdue {
src/public/styles.css:191:.todo-item.is-overdue .todo-due {
src/public/index.html:23:        <input id="due-input" class="due-input" type="date" name="dueDate" aria-label="Due date" />
src/public/app.js:44:  if (todo.overdue) item.classList.add("is-overdue");
src/public/app.js:78:    dueEl.textContent = (todo.overdue ? "Overdue - due " : "Due ") + formatDue(todo.dueDate);
src/lib/audit.js:16:    new Date().toISOString()
src/routes/todos.js:16:  }).format(new Date());
src/routes/todos.js:25:    overdue: !row.done && !!row.due_date && row.due_date < todayStr,
src/routes/todos.js:59:    const now = new Date().toISOString();
src/routes/todos.js:95:    const now = new Date().toISOString();
```

What the run said at the end:

```
LINES MENTIONING OVERDUE / DUE / TIMEZONE / ASSUMPTION:
- No new dependencies, no new config reads outside `settings.js` (reused the existing `timezone` setting to compute "overdue" against local calendar date).
**Frontend** (`src/public/`) — plain HTML/CSS/JS, no build step, served via `express.static`: create form with optional due date, All/Open/Done tabs, checkbox toggle, inline title editing, delete, and a red-bordered/red-text treatment for overdue open items.
**Tests** (`test/todos.test.js`) — 6 cases covering create (with/without due date, and rejection of blank titles), done/undo, open/done filtering, edit+delete, and overdue flagging. All 7 tests pass (`npm test`).
```

