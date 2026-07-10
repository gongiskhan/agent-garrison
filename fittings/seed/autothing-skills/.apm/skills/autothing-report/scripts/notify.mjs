#!/usr/bin/env node
// autothing-report: compose + send the Slack notification via an incoming webhook.
//
// Usage:
//   node notify.mjs --project <name> --status <passed|completed-with-blockers|...> \
//     --summary <text-or-file> --gallery-url <url> --report-url <url> [--title <t>]
//
// Webhook resolution (in order): $AUTOTHING_SLACK_WEBHOOK_URL, then
// ~/.config/autothing/.env (line AUTOTHING_SLACK_WEBHOOK_URL=...). If none is set,
// it prints the composed Block Kit payload (so the caller can send it via the Slack
// MCP instead) and exits 0 — a missing webhook never fails the run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : null; };
function webhook() {
  if (process.env.AUTOTHING_SLACK_WEBHOOK_URL) return process.env.AUTOTHING_SLACK_WEBHOOK_URL.trim();
  try {
    const m = fs.readFileSync(path.join(os.homedir(), '.config', 'autothing', '.env'), 'utf8')
      .match(/^\s*AUTOTHING_SLACK_WEBHOOK_URL\s*=\s*(.+?)\s*$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {}
  return null;
}

const project = arg('--project') || 'project';
const status = arg('--status') || 'done';
const gallery = arg('--gallery-url') || '';
const report = arg('--report-url') || '';
let summary = arg('--summary') || '';
if (summary && fs.existsSync(summary)) { try { summary = fs.readFileSync(summary, 'utf8'); } catch {} }
summary = summary.slice(0, 2800); // Slack section text hard limit ~3000

const emoji = /passed/.test(status) ? ':white_check_mark:'
  : /blocker/.test(status) ? ':warning:' : ':information_source:';
const blocks = [
  { type: 'header', text: { type: 'plain_text', text: (arg('--title') || `autothing ${status} — ${project}`).slice(0, 150) } },
  { type: 'section', text: { type: 'mrkdwn', text: `${emoji} *${project}* finished with status *${status}*.` } },
];
if (summary) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: summary } });
const links = [];
if (gallery) links.push(`<${gallery}|:movie_camera: Video gallery>`);
if (report) links.push(`<${report}|:page_facing_up: Session logs + run artifacts>`);
if (links.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: links.join('   •   ') } });
blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Tailscale links — reachable on your tailnet only.' }] });

const payload = { text: `autothing ${status} — ${project}`, blocks };
const hook = webhook();
if (!hook) {
  console.error('autothing-report: no AUTOTHING_SLACK_WEBHOOK_URL (env or ~/.config/autothing/.env). ' +
    'Composed Slack payload below — set the webhook, or send it via the Slack MCP:');
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}
try {
  const r = await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (!r.ok) { console.error(`autothing-report: Slack webhook returned ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`); process.exit(0); }
  console.log('autothing-report: Slack notification sent.');
} catch (e) {
  console.error(`autothing-report: Slack send failed (${e.message}). Payload:`);
  console.log(JSON.stringify(payload));
  process.exit(0);
}
