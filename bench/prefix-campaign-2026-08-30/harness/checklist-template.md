# Quality checklist — RUN_ID

Directory: RUN_DIR
Start: `cd RUN_DIR && npm install && npm start`  (then open the port it prints)

Fill these in. They are deliberately not scored here.

| # | Check | Pass / Fail / Notes |
|---|---|---|
| 1 | starts clean first try | |
| 2 | all eight behaviours work | |
| 3 | survives restart | |
| 4 | reused `src/lib/store.js` | |
| 5 | reused `src/lib/identity.js` | |
| 6 | used `src/lib/settings.js` | |
| 7 | called `audit.record` | |
| 8 | no new dependencies | |
| 9 | tests present and passing | |
| 10 | stated an assumption about overdue rather than silently choosing | |
| 11 | touched nothing outside `src`, `test` and `package.json` | |
