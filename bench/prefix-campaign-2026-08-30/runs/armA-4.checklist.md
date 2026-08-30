# Quality checklist — armA-4

Directory: `/home/ggomes/dev/armA-4`
Start: `cd /home/ggomes/dev/armA-4 && npm install && npm start`

Eight rows are filled from evidence below. Two are left for you.

| # | Check | Answer |
|---|---|---|
| 1 | starts clean first try | **yes** — `npm install` exit 0, `npm start` answered HTTP 200 on `/api/health` after 452ms |
| 2 | all eight behaviours work | |
| 3 | survives restart | **yes** |
| 4 | reused `src/lib/store.js` | **yes** — 2 reference(s); `new Database(` outside store.js: 0 |
| 5 | reused `src/lib/identity.js` | **no** — 0 reference(s); ad-hoc id generation elsewhere: 0 |
| 6 | used `src/lib/settings.js` | **yes** — 1 reference(s); `process.env` outside settings.js: 0 |
| 7 | called `audit.record` | **yes** — 3 call site(s), 0 import(s); state-changing route files with no audit call: 1 |
| 8 | no new dependencies | **yes** — added runtime: none; added dev: none |
| 9 | tests present and passing | **yes** — 2 test file(s), `npm test` exit 0 |
| 10 | stated an assumption about overdue rather than silently choosing | |
| 11 | touched nothing outside `src`, `test`, `package.json` | **no** — outside: FLOW_PLAN.md, public/app.js, public/index.html, public/style.css |

---

## Evidence

### 1. starts clean first try

Run in a pristine copy at `~/bench/verify/armA-4` (rsync of the app without `node_modules`, `data` or `.git`) before anything else touched it.

`npm install` exit **0**:

```
added 150 packages in 1s
```

`npm start` (PORT=3153) came up: **true**, HTTP 200 on `/api/health` after 452ms:

```
> todo-seed@1.0.0 start
> node src/server.js
listening on http://localhost:3153
```

### 3. survives restart

Created over the API, killed the process, started it again, fetched the list back.

POST `/api/todos` with `{"title":"restart probe","dueDate":"2030-01-01"}` → HTTP 201:

```
{"id":"0mtfl6vqhkx3ky3w120","title":"restart probe","dueDate":"2030-01-01","done":false,"createdAt":"2026-08-30T09:08:03.497Z","updatedAt":"2026-08-30T09:08:03.497Z"}
```

After restart, GET `/api/todos` → HTTP 200:

```
[{"id":"0mtfl6vqhkx3ky3w120","title":"restart probe","dueDate":"2030-01-01","done":false,"createdAt":"2026-08-30T09:08:03.497Z","updatedAt":"2026-08-30T09:08:03.497Z"}]
```


### 4-7. conventions

**store.js** — 2 reference(s):

```
src/server.js:3:import { openDb } from "./lib/store.js";
src/routes/health.js:4:import { openDb } from "../lib/store.js";
```

Counter-evidence, `new Database(` outside store.js: **0** _(none)_ 
**identity.js** — 0 reference(s): _(none)_ 
Counter-evidence, ad-hoc id generation (randomUUID / randomBytes / Math.random / Date.now().toString): **0** _(none)_ 
**settings.js** — 1 reference(s):

```
src/server.js:2:import { load } from "./lib/settings.js";
```

Counter-evidence, `process.env` outside settings.js: **0** _(none)_ 
**audit.record** — 3 call site(s):

```
src/lib/todos.js:33:    record("todo.create", { id, title, dueDate: dueDate ?? null });
src/lib/todos.js:67:    record("todo.update", { id, changes });
src/lib/todos.js:79:    record("todo.delete", { id });
```

State-changing routes (3):

```
src/routes/todos.js:21:  app.post("/api/todos", (req, res) => {
src/routes/todos.js:41:  app.patch("/api/todos/:id", (req, res) => {
src/routes/todos.js:63:  app.delete("/api/todos/:id", (req, res) => {
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
[1m[7m[36m RUN [39m[27m[22m [36mv2.1.9 [39m[90m/home/ggomes/bench/verify/armA-4[39m
 [32m✓[39m test/health.test.js [2m([22m[2m1 test[22m[2m)[22m[90m 52[2mms[22m[39m
 [32m✓[39m test/todos.test.js [2m([22m[2m5 tests[22m[2m)[22m[90m 133[2mms[22m[39m
[2m Test Files [22m [1m[32m2 passed[39m[22m[90m (2)[39m
[2m      Tests [22m [1m[32m6 passed[39m[22m[90m (6)[39m
[2m   Start at [22m 10:08:07
[2m   Duration [22m 536ms[2m (transform 64ms, setup 0ms, collect 253ms, tests 184ms, environment 0ms, prepare 174ms)[22m
```

### 11. footprint vs seed-v1

Changed:

```
src/lib/store.js
src/server.js
```

Untracked:

```
FLOW_PLAN.md
public/app.js
public/index.html
public/style.css
src/lib/todos.js
src/routes/todos.js
src/routes/ui.js
test/todos.test.js
```

Outside `src`/`test`/`package.json`: `FLOW_PLAN.md`, `public/app.js`, `public/index.html`, `public/style.css`

### 10. overdue — evidence only, not assessed

Every occurrence of "overdue" in `src`, `test` and any markdown:

```
FLOW_PLAN.md:52:- Row gets class `overdue` when `dueDate < today's date` (string comparison works for `YYYY-MM-DD`) and `!done`. `style.css` gives `.overdue` a distinct color/weight.
FLOW_PLAN.md:90:- [ ] Overdue todos visually distinct in the UI
```

Date comparisons and date handling in `src`:

```
src/lib/todos.js:29:    const now = new Date().toISOString();
src/lib/todos.js:55:    const now = new Date().toISOString();
src/lib/audit.js:16:    new Date().toISOString()
```

What the run said at the end:

```
LINES MENTIONING OVERDUE / DUE / TIMEZONE / ASSUMPTION:
  - Create with due date and without due date — both return 201 with expected shape.
  - Due-date validation: impossible calendar date (`2026-99-99`) rejected 400, non-string due date rejected 400, valid leap day (`2024-02-29`) accepted 201.
  - Create with due date and without due date — both return 201 with expected shape.
  - Due-date validation: imp
- implement → adversarial-review: All acceptance criteria from the card are implemented and verified: create/list/filter/complete/undo/delete/edit, persistence across restart, overdue visual distinction, passing tests, no new dependen
```

