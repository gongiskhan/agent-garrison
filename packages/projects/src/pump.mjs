import {startCommitPushPump} from './merge.mjs';

const KEY = Symbol.for('garrison.projects.pump');
const INTERVAL_MS = 10_000;

/** One poller survives app module reloads. The shell supplies its resolver. */
export function ensurePump({client, env = process.env, log = console.info, resolveProject} = {}) {
  if (env.GARRISON_PROJECTS_PUMP === '0') return null;
  if (globalThis[KEY]) return globalThis[KEY];
  const stop = startCommitPushPump({client, env, resolveProject, intervalMs: INTERVAL_MS, log});
  if (!stop) return null;
  const handle = {stop};
  globalThis[KEY] = handle;
  log(`[projects] pump started node=${env.GARRISON_NODE_NAME || 'unknown'} interval=${INTERVAL_MS}ms`);
  return handle;
}
