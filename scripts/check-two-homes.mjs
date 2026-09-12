#!/usr/bin/env node
// Runtime source cannot restore the retired stretch home or bypass the launcher.
// Historical prose/evidence is retained. Two exact runner compatibility lines
// report old persisted configuration without implementing it.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const retired = /stretch-claude-home|GARRISON_STRETCH_CLAUDE_HOME|stretch_claude_home/;
const compatibilityLines = [
  'if (Object.values(composition.selections).flatMap(items => items ?? []).some(item => Object.hasOwn(item.config, "stretch_claude_home"))) {',
  'appendLog(compositionId, "runner", "stretch_claude_home is retired: stretches use the Garrison home");'
];
const env = /GARRISON_CLAUDE_HOME|GARRISON_CLAUDE_JSON|CLAUDE_CONFIG_DIR/;
const literalHome = /(?:\$\{?HOME\}?\/\.claude(?:\/|\.json|\b)|(?:path\.(?:join|resolve)|os\.path\.join)\([^\n]*["']\.claude(?:\.json)?["']|(?:os\.homedir\(\)|homeDir\(env\))\s*\+\s*["']\/\.claude)/;
export function inspectHomeSource(file, source) {
  const failures = [];
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*(?:#|\/\/|\*|<!--)/.test(line)) continue;
    if (retired.test(line) && !(file === 'src/lib/runner.ts' && compatibilityLines.includes(line.trim()))) failures.push(`${file}:${index + 1}: retired stretch home`);
    if (!file.startsWith('fittings/') || !literalHome.test(line)) continue;
    // Some JS helpers store the override in a local before a ternary fallback.
    const context = lines.slice(Math.max(0, index - 4), index + 1).join('\n');
    // The native-memory mirror explicitly reads the user's config by purpose.
    const userMirror = file === 'fittings/seed/vault-git-sync/scripts/obsidian-vault-sync.sh' && /GARRISON_USER_CLAUDE_HOME/.test(line);
    const projectSkill = ['fittings/seed/drill/lib/projects.mjs', 'fittings/seed/drill/lib/app-runner.mjs'].includes(file) && /path\.join\(root, ["']\.claude["'], ["']skills["']\)/.test(line);
    if (!env.test(context) && !userMirror && !projectSkill) failures.push(`${file}:${index + 1}: runtime home bypasses launcher env`);
  }
  return failures;
}
export function checkTwoHomes(repo = root) {
  const files = [...new Set(execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0'))];
  return files.filter(file => /^(src|fittings|scripts|compositions)\//.test(file) && /\.(?:[cm]?js|ts|tsx|sh|py|ya?ml|json)$/.test(file) && file !== 'scripts/check-two-homes.mjs' && !/(?:node_modules|apm_modules|\/dist)\//.test(file) && fs.existsSync(path.join(repo, file)))
    .flatMap(file => inspectHomeSource(file, fs.readFileSync(path.join(repo, file), 'utf8')));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = checkTwoHomes();
  if (failures.length) { console.error(`TWO HOMES GATE: ${failures.length} violation(s)\n${failures.join('\n')}`); process.exitCode = 1; }
  else console.log('TWO HOMES GATE: clean');
}
