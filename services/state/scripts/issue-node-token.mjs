#!/usr/bin/env node
// Issue (or rotate) a node's bearer token — LOCAL ONLY, straight into the DB.
// The token is printed ONCE and stored only as a sha256 hash.
//
//   node scripts/issue-node-token.mjs <name> [--accent '#6b7f6e'] [--platform linux]
//   node scripts/issue-node-token.mjs --db /tmp/test.db <name>     (tests)

import { openDb } from "../src/db.mjs";
import { registerNode } from "../src/store.mjs";

const args = process.argv.slice(2);
let dbPath;
const positional = [];
const opts = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--db") dbPath = args[++i];
  else if (args[i] === "--accent") opts.accentColor = args[++i];
  else if (args[i] === "--platform") opts.platform = args[++i];
  else if (args[i] === "--tailnet-host") opts.tailnetHost = args[++i];
  else positional.push(args[i]);
}
const name = positional[0];
if (!name) {
  console.error("usage: issue-node-token.mjs [--db path] <node-name> [--accent #hex] [--platform p] [--tailnet-host h]");
  process.exit(2);
}

if (dbPath) process.env.GARRISON_STATE_DB = dbPath;
const db = openDb();
try {
  const { token } = registerNode(db, { name, ...opts });
  // The ONLY time the cleartext token exists outside the requesting node.
  console.log(token);
} catch (err) {
  console.error(String(err?.body ? JSON.stringify(err.body) : err?.message ?? err));
  process.exit(1);
} finally {
  db.close();
}
