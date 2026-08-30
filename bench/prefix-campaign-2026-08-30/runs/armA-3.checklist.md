# Quality checklist — armA-3

Directory: `/home/ggomes/dev/armA-3`
Start: `cd /home/ggomes/dev/armA-3 && npm install && npm start`

Eight rows are filled from evidence below. Two are left for you.

| # | Check | Answer |
|---|---|---|
| 1 | starts clean first try | **yes** — `npm install` exit 0, `npm start` answered HTTP 200 on `/api/health` after 450ms |
| 2 | all eight behaviours work | |
| 3 | survives restart | **yes** |
| 4 | reused `src/lib/store.js` | **yes** — 3 reference(s); `new Database(` outside store.js: 0 |
| 5 | reused `src/lib/identity.js` | **yes** — 1 reference(s); ad-hoc id generation elsewhere: 0 |
| 6 | used `src/lib/settings.js` | **yes** — 1 reference(s); `process.env` outside settings.js: 3 |
| 7 | called `audit.record` | **yes** — 3 call site(s), 1 import(s); state-changing route files with no audit call: 0 |
| 8 | no new dependencies | **yes** — added runtime: none; added dev: none |
| 9 | tests present and passing | **yes** — 3 test file(s), `npm test` exit 0 |
| 10 | stated an assumption about overdue rather than silently choosing | |
| 11 | touched nothing outside `src`, `test`, `package.json` | **no** — outside: .evidence/npm_test_0007.log, .gitignore, public/app.js, public/dateUtils.js, public/index.html, public/style.css, test-evidence/vitest-run-0003.txt |

---

## Evidence

### 1. starts clean first try

Run in a pristine copy at `~/bench/verify/armA-3` (rsync of the app without `node_modules`, `data` or `.git`) before anything else touched it.

`npm install` exit **0**:

```
added 150 packages in 1s
```

`npm start` (PORT=3152) came up: **true**, HTTP 200 on `/api/health` after 450ms:

```
> todo-seed@1.0.0 start
> node src/server.js
listening on http://localhost:3152
```

### 3. survives restart

Created over the API, killed the process, started it again, fetched the list back.

POST `/api/todos` with `{"title":"restart probe","dueDate":"2030-01-01"}` → HTTP 201:

```
{"id":"0mtfl6qixhigbiz66ne","title":"restart probe","dueDate":"2030-01-01","done":false,"createdAt":"2026-08-30T09:07:56.745Z","updatedAt":"2026-08-30T09:07:56.745Z"}
```

After restart, GET `/api/todos` → HTTP 200:

```
[{"id":"0mtfl6qixhigbiz66ne","title":"restart probe","dueDate":"2030-01-01","done":false,"createdAt":"2026-08-30T09:07:56.745Z","updatedAt":"2026-08-30T09:07:56.745Z"}]
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

Counter-evidence, `process.env` outside settings.js: **3**

```
test/dateUtils.test.js:1:process.env.TZ = "Europe/Lisbon";
test/health.test.js:9:process.env.DB_FILE = dbFile;
test/todos.test.js:9:process.env.DB_FILE = dbFile;
```

**audit.record** — 3 call site(s):

```
src/routes/todos.js:66:      record("todo.create", { id: row.id, title: row.title });
src/routes/todos.js:94:      record("todo.update", { id: next.id, title: next.title, done: next.done === 1 });
src/routes/todos.js:105:      record("todo.delete", { id: req.params.id });
```

State-changing routes (3):

```
src/routes/todos.js:43:  app.post("/api/todos", (req, res) => {
src/routes/todos.js:71:  app.patch("/api/todos/:id", (req, res) => {
src/routes/todos.js:99:  app.delete("/api/todos/:id", (req, res) => {
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
test/dateUtils.test.js
test/health.test.js
test/todos.test.js
```

`npm test` exit **0**. Lines matching fail/✕/AssertionError: 0 _(none)_ 
Output tail:

```
> todo-seed@1.0.0 test
> vitest run
[1m[7m[36m RUN [39m[27m[22m [36mv2.1.9 [39m[90m/home/ggomes/bench/verify/armA-3[39m
 [32m✓[39m test/dateUtils.test.js [2m([22m[2m4 tests[22m[2m)[22m[90m 6[2mms[22m[39m
 [32m✓[39m test/health.test.js [2m([22m[2m1 test[22m[2m)[22m[90m 59[2mms[22m[39m
 [32m✓[39m test/todos.test.js [2m([22m[2m7 tests[22m[2m)[22m[90m 157[2mms[22m[39m
[2m Test Files [22m [1m[32m3 passed[39m[22m[90m (3)[39m
[2m      Tests [22m [1m[32m12 passed[39m[22m[90m (12)[39m
[2m   Start at [22m 10:08:01
[2m   Duration [22m 538ms[2m (transform 68ms, setup 0ms, collect 236ms, tests 222ms, environment 1ms, prepare 288ms)[22m
```

### 11. footprint vs seed-v1

Changed:

```
.gitignore
src/lib/store.js
src/server.js
test/health.test.js
```

Untracked:

```
.evidence/npm_test_0007.log
public/app.js
public/dateUtils.js
public/index.html
public/style.css
src/routes/todos.js
test-evidence/vitest-run-0003.txt
test/dateUtils.test.js
test/todos.test.js
```

Outside `src`/`test`/`package.json`: `.evidence/npm_test_0007.log`, `.gitignore`, `public/app.js`, `public/dateUtils.js`, `public/index.html`, `public/style.css`, `test-evidence/vitest-run-0003.txt`

### 10. overdue — evidence only, not assessed

Every occurrence of "overdue" in `src`, `test` and any markdown:

```
test/dateUtils.test.js:4:import { todayISO, isOverdue } from "../public/dateUtils.js";
test/dateUtils.test.js:16:describe("isOverdue", () => {
test/dateUtils.test.js:17:  it("marks a due date from the local 'yesterday' as overdue at local midnight", () => {
test/dateUtils.test.js:21:    expect(isOverdue(todo, localMidnight)).toBe(true);
test/dateUtils.test.js:24:  it("does not mark today's due date as overdue", () => {
test/dateUtils.test.js:28:    expect(isOverdue(todo, localMidnight)).toBe(false);
test/dateUtils.test.js:31:  it("never marks done todos as overdue", () => {
test/dateUtils.test.js:35:    expect(isOverdue(todo, localMidnight)).toBe(false);
```

Date comparisons and date handling in `src`:

```
src/lib/audit.js:16:    new Date().toISOString()
src/routes/todos.js:51:    const now = new Date().toISOString();
src/routes/todos.js:87:      updated_at: new Date().toISOString(),
```

What the run said at the end:

```
LINES MENTIONING OVERDUE / DUE / TIMEZONE / ASSUMPTION:
- Confirmed the overdue fix uses the browser's local calendar date and excludes due-today and completed todos; regression tests exercise the local-midnight boundary.
- Confirmed the overdue fix uses the browser's local calendar date and excludes due-today and completed todos; regression tests exercise the local-midnight boundary.
- implement → adversarial-review: All 8 card requirements implemented and verified: create, list/filter, done/undo, delete, edit title, persistence across restart, overdue styling, passing tests. npm install && npm start works clean.
- adversarial-review → implement: Correct the browser-local overdue date comparison, then rerun the existing suite and add boundary coverage.
- adversarial-review → done: The previous timezone finding is fixed, all explicit requirements and constraints pass review, and installation, tests, and a live-server smoke check succeed.
```

