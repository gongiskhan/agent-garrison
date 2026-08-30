# Conventions

These are not suggestions. Code that ignores them will be rejected in review
even if it works.

## Persistence

All persistence goes through `src/lib/store.js`. Use `openDb()` for the
connection and `withTx(fn)` for anything that writes more than one row. Do not
construct a database handle anywhere else: a second handle has its own WAL view
and its own idea of what a transaction is.

## Identifiers

All ids come from `src/lib/identity.js`. Do not write another id generator and
do not import one. The keys it returns are lexicographically sortable, so
`ORDER BY` on the key column is creation order.

## Audit

Every state change calls `record(action, detail)` from `src/lib/audit.js`, in
the same transaction as the change where there is one. A change that leaves no
audit row did not happen as far as this service is concerned.

## Configuration

All configuration goes through `src/lib/settings.js`. `load()` is the only
place `process.env` is read. Add a new setting there, with a default, rather
than reading the environment where you need it.

## Dependencies

No new dependencies. Everything needed is already in `package.json`.

## Style

Routes are modules under `src/routes/` exporting `register(app)`, registered in
`src/server.js`. Tests live under `test/` and follow the shape of
`test/health.test.js`. Follow the existing route and test style.
