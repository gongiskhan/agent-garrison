// Translate a Kanban list's {trigger, beatCron} into a Garrison scheduler job — the
// single place that registers/removes a scheduler-beat list's beat, used by BOTH
// `kanban.mjs --setup` AND `PATCH /lists/:id` (server.mjs) so a beat the UI configures
// takes effect immediately, not only at the next setup. A scheduler-beat list fires
// `kanban.mjs --tick-list <id>` on its own cron (e.g. Test every 5h).
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Legacy default for the seed Test list (which historically carried no explicit
// beatCron). Any list with its own beatCron uses that instead. KANBAN_LOOP_* is
// the runner's setupConfigEnv projection of the composition's test_beat_cron.
const DEFAULT_TEST_CRON =
  process.env.KANBAN_TEST_BEAT_CRON || process.env.KANBAN_LOOP_TEST_BEAT_CRON || "0 */5 * * *";

// The installed scheduler CLI (sibling fitting), overridable for tests.
export function schedulerCli() {
  return process.env.GARRISON_SCHEDULER_CLI
    || path.resolve(HERE, "..", "..", "scheduler", "scripts", "scheduler.mjs");
}

function kanbanCli() {
  return path.resolve(HERE, "..", "scripts", "kanban.mjs");
}

// One stable beat id per list, so re-registering is idempotent (remove + add).
export function beatIdFor(listId) {
  return `kanban-${listId}-beat`;
}

// The cron a scheduler-beat list should fire on: its own beatCron, else the legacy
// Test default (back-compat), else null (a scheduler-beat list with no schedule is not
// registered — it would otherwise be a silent never/garbage beat).
export function cronForList(list) {
  const own = list?.beatCron && String(list.beatCron).trim();
  if (own) return String(list.beatCron).trim();
  if (list?.id === "test") return DEFAULT_TEST_CRON;
  return null;
}

// Register (or re-register) the beat for a scheduler-beat list; remove it for any other
// trigger. Idempotent + best-effort + non-fatal (a missing scheduler CLI just logs).
// Returns { action, cron? } for logging/tests.
export async function syncListBeat(list, { log = console.log } = {}) {
  if (!list || !list.id) return { action: "noop" };
  const cli = schedulerCli();
  const beatId = beatIdFor(list.id);
  if (!existsSync(cli)) {
    log(`kanban-loop: scheduler CLI not found at ${cli} (skipping beat for ${list.id}).`);
    return { action: "skipped-no-cli" };
  }
  const { spawnSync } = await import("node:child_process");
  // Always remove first so a trigger flip (scheduler-beat → manual) un-registers it.
  spawnSync("node", [cli, "remove", beatId], { stdio: "ignore" });
  if (list.trigger !== "scheduler-beat") return { action: "removed" };
  const cron = cronForList(list);
  if (!cron) {
    log(`kanban-loop: list '${list.id}' is scheduler-beat but has no beatCron — not registered.`);
    return { action: "no-cron" };
  }
  // Quote the CLI path — an install dir containing a space would otherwise split
  // the command and the beat would silently fail to run.
  const cmd = `node '${kanbanCli()}' --tick-list ${list.id}`;
  const add = spawnSync("node", [cli, "add", beatId, cron, cmd], { encoding: "utf8" });
  if (add.status === 0) {
    log(`kanban-loop: registered ${beatId} @ '${cron}' -> ${cmd}`);
    return { action: "registered", cron };
  }
  log(`kanban-loop: scheduler add (${beatId}) failed: ${add.stderr || add.stdout || add.status}`);
  return { action: "add-failed" };
}

// Sync EVERY list's beat for a board (used at --setup). Returns the per-list results.
export async function syncAllBeats(board, opts = {}) {
  const results = [];
  for (const list of board?.lists || []) {
    // Only scheduler-beat lists need a beat; syncListBeat still removes a stale beat for
    // any list that USED to be scheduler-beat, so call it for all and let it decide.
    results.push({ id: list.id, ...(await syncListBeat(list, opts)) });
  }
  return results;
}
