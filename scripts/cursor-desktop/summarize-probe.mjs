import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const file = process.argv[2] ?? path.join(os.homedir(), '.garrison/cursor-probe/events.jsonl');
const records = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
const payloads = records.filter(record => record.kind === 'payload');
const expected = ['sessionStart', 'sessionEnd', 'beforeSubmitPrompt', 'afterAgentResponse', 'afterAgentThought', 'beforeShellExecution', 'afterShellExecution', 'beforeMCPExecution', 'afterMCPExecution', 'beforeReadFile', 'afterFileEdit', 'preToolUse', 'postToolUse', 'stop'];
const schema = expected.map(event => {
  const samples = payloads.filter(record => record.payload.hook_event_name === event);
  return { event, count: samples.length, fields: [...new Set(samples.flatMap(record => Object.keys(record.payload)))].sort() };
});
const holds = records.filter(record => record.kind === 'hold').map(hold => {
  const returned = records.find(record => record.pid === hold.pid && record.kind === 'return' && record.at >= hold.at);
  const confirmation = returned?.response?.followup_message && payloads.find(record => record.at >= returned.at && record.payload.conversation_id === hold.conversation_id && record.payload.hook_event_name === 'beforeSubmitPrompt' && record.payload.prompt === returned.response.followup_message);
  return {
    requested_seconds: hold.seconds,
    started_at: new Date(hold.at).toISOString(),
    return_reason: returned?.reason ?? null,
    held_seconds: returned ? (returned.at - hold.at) / 1000 : null,
    elapsed_since_start_seconds: returned ? null : Math.floor((Date.now() - hold.at) / 1000),
    followup_observed: Boolean(confirmation),
    followup_delay_ms: confirmation ? confirmation.at - returned.at : null
  };
});

console.log(JSON.stringify({
  generated_at: new Date().toISOString(),
  cursor_versions: [...new Set(payloads.map(record => record.payload.cursor_version))],
  platforms: [...new Set(payloads.map(record => record.platform))],
  workspace_root_counts: [...new Set(payloads.map(record => record.payload.workspace_roots?.length))],
  schema,
  missing_events: schema.filter(row => row.count === 0).map(row => row.event),
  stop_statuses: [...new Set(payloads.filter(record => record.payload.hook_event_name === 'stop').map(record => record.payload.status))],
  session_end_reasons: [...new Set(payloads.filter(record => record.payload.hook_event_name === 'sessionEnd').map(record => record.payload.reason))],
  holds
}, null, 2));
