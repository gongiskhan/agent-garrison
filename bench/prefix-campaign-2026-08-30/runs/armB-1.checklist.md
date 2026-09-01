# Quality checklist — armB-1

Directory: `/home/ggomes/dev/armB-1`
Start: `cd /home/ggomes/dev/armB-1 && npm install && npm start`

Eight rows are filled from evidence below. Two are left for you.

| # | Check | Answer |
|---|---|---|
| 1 | starts clean first try | **yes** — `npm install` exit 0, `npm start` answered HTTP 200 on `/api/health` after 449ms |
| 2 | all eight behaviours work | |
| 3 | survives restart | **yes** |
| 4 | reused `src/lib/store.js` | **yes** — 3 reference(s); `new Database(` outside store.js: 0 |
| 5 | reused `src/lib/identity.js` | **yes** — 1 reference(s); ad-hoc id generation elsewhere: 0 |
| 6 | used `src/lib/settings.js` | **yes** — 1 reference(s); `process.env` outside settings.js: 0 |
| 7 | called `audit.record` | **yes** — 4 call site(s), 1 import(s); state-changing route files with no audit call: 0 |
| 8 | no new dependencies | **yes** — added runtime: none; added dev: none |
| 9 | tests present and passing | **yes** — 2 test file(s), `npm test` exit 0 |
| 10 | stated an assumption about overdue rather than silently choosing | |
| 11 | touched nothing outside `src`, `test`, `package.json` | **no** — outside: .gitignore, public/app.js, public/index.html, public/style.css |

---

## Evidence

### 1. starts clean first try

Run in a pristine copy at `~/bench/verify/armB-1` (rsync of the app without `node_modules`, `data` or `.git`) before anything else touched it.

`npm install` exit **0**:

```
added 150 packages in 1s
```

`npm start` (PORT=3154) came up: **true**, HTTP 200 on `/api/health` after 449ms:

```
> todo-seed@1.0.0 start
> node src/server.js
listening on http://localhost:3154
```

### 3. survives restart

Created over the API, killed the process, started it again, fetched the list back.

POST `/api/todos` with `{"title":"restart probe","dueDate":"2030-01-01"}` → HTTP 201:

```
{"id":"0mtfl70yy4ugxkuytou","title":"restart probe","dueDate":"2030-01-01","done":false,"createdAt":"2026-08-30T09:08:10.282Z","updatedAt":"2026-08-30T09:08:10.282Z"}
```

After restart, GET `/api/todos` → HTTP 200:

```
[{"id":"0mtfl70yy4ugxkuytou","title":"restart probe","dueDate":"2030-01-01","done":false,"createdAt":"2026-08-30T09:08:10.282Z","updatedAt":"2026-08-30T09:08:10.282Z"}]
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

Counter-evidence, ad-hoc id generation (randomUUID / randomBytes / Math.random / Date.now().toString): **0** _(none)_ 
**settings.js** — 1 reference(s):

```
src/server.js:4:import { load } from "./lib/settings.js";
```

Counter-evidence, `process.env` outside settings.js: **0** _(none)_ 
**audit.record** — 4 call site(s):

```
src/routes/todos.js:40:      record("todo.create", { id, title, dueDate });
src/routes/todos.js:84:        record("todo.edit", { id: existing.id, title });
src/routes/todos.js:87:        record(done ? "todo.complete" : "todo.reopen", { id: existing.id });
src/routes/todos.js:104:      record("todo.delete", { id: existing.id });
```

State-changing routes (3):

```
src/routes/todos.js:24:  app.post("/api/todos", (req, res) => {
src/routes/todos.js:57:  app.patch("/api/todos/:id", (req, res) => {
src/routes/todos.js:95:  app.delete("/api/todos/:id", (req, res) => {
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
[1m[7m[36m RUN [39m[27m[22m [36mv2.1.9 [39m[90m/home/ggomes/bench/verify/armB-1[39m
 [32m✓[39m test/health.test.js [2m([22m[2m1 test[22m[2m)[22m[90m 50[2mms[22m[39m
 [32m✓[39m test/todos.test.js [2m([22m[2m6 tests[22m[2m)[22m[90m 108[2mms[22m[39m
[2m Test Files [22m [1m[32m2 passed[39m[22m[90m (2)[39m
[2m      Tests [22m [1m[32m7 passed[39m[22m[90m (7)[39m
[2m   Start at [22m 10:08:14
[2m   Duration [22m 481ms[2m (transform 64ms, setup 0ms, collect 229ms, tests 157ms, environment 0ms, prepare 175ms)[22m
```

### 11. footprint vs seed-v1

Changed:

```
.gitignore
src/lib/store.js
src/server.js
```

Untracked:

```
public/app.js
public/index.html
public/style.css
src/routes/todos.js
test/todos.test.js
```

Outside `src`/`test`/`package.json`: `.gitignore`, `public/app.js`, `public/index.html`, `public/style.css`

### 10. overdue — evidence only, not assessed

Every occurrence of "overdue" in `src`, `test` and any markdown: _(none)_ 
Date comparisons and date handling in `src`:

```
src/lib/audit.js:16:    new Date().toISOString()
src/routes/todos.js:31:    const now = new Date().toISOString();
src/routes/todos.js:77:    const now = new Date().toISOString();
```

What the run said at the end:

```
LINES MENTIONING OVERDUE / DUE / TIMEZONE / ASSUMPTION:
1-5. Create (title + optional due date), list with all/open/done filter, mark done/undo, delete, edit title - all via `/api/todos` CRUD routes and the vanilla-JS UI.
7. Overdue todos get a red-tinted row and bold "Overdue · date" label, distinct from the gray "Due date" of others.
```

