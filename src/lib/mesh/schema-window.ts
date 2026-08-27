// The schema window THIS node's client code is written against.
//
// The state service's own version is the number of migration files its binary
// ships (`binarySchemaVersion()` in services/state/src/db.mjs) — that is the
// SERVER's number and a node must never assume it. What a node declares in
// `hello` is the range of server schemas its client code can talk to; the
// service compares its own version against that range and flips the node to
// `behind` (reads fine, writes refuse) when it falls outside.
//
// So: bump `max` when this checkout gains a migration it depends on, and raise
// `min` only when a compatibility floor is genuinely dropped. Widening the
// window silently is how a node keeps writing against a schema it no longer
// understands.
export const CLIENT_SCHEMA = { min: 1, max: 2 } as const;

// Reported to the registry so `/mesh` can show which build a peer is running.
export const CLIENT_VERSION = "garrison-node/1";
