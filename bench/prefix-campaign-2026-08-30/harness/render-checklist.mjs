#!/usr/bin/env node
// Rewrite each run's checklist with the eight factual rows filled from the
// evidence file, quoting it inline. Two rows stay blank by instruction:
// "all eight behaviours work" and the overdue-assumption row, for which the
// evidence is pasted without assessment.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const label = process.argv[2];
const ev = JSON.parse(fs.readFileSync(path.join(HOME, "bench", "evidence", `${label}.json`), "utf8"));
const q = (s) => (s && String(s).trim() ? `\n\n\`\`\`\n${String(s).trim()}\n\`\`\`\n` : " _(none)_ ");
const lines = (xs) => (xs?.length ? `\n\n\`\`\`\n${xs.join("\n")}\n\`\`\`\n` : " _(none)_ ");

const L = [];
L.push(`# Quality checklist — ${label}`);
L.push("");
L.push(`Directory: \`${ev.appDir}\``);
L.push(`Start: \`cd ${ev.appDir} && npm install && npm start\``);
L.push("");
L.push("Eight rows are filled from evidence below. Two are left for you.");
L.push("");
L.push("| # | Check | Answer |");
L.push("|---|---|---|");
L.push(`| 1 | starts clean first try | **${ev.npmInstall.exitCode === 0 && ev.npmStart.cameUp ? "yes" : "no"}** — \`npm install\` exit ${ev.npmInstall.exitCode}, \`npm start\` ${ev.npmStart.cameUp ? `answered HTTP ${ev.npmStart.httpStatus} on \`${ev.npmStart.probedPath}\` after ${ev.npmStart.msToReady}ms` : "never came up"} |`);
L.push(`| 2 | all eight behaviours work | |`);
L.push(`| 3 | survives restart | **${ev.survivesRestart.verdict}** |`);
const c = ev.conventions;
L.push(`| 4 | reused \`src/lib/store.js\` | **${c.reusedStoreJs.references > 0 ? "yes" : "no"}** — ${c.reusedStoreJs.references} reference(s); \`new Database(\` outside store.js: ${c.reusedStoreJs.counterEvidence.newDatabaseOutsideStore} |`);
L.push(`| 5 | reused \`src/lib/identity.js\` | **${c.reusedIdentityJs.references > 0 ? "yes" : "no"}** — ${c.reusedIdentityJs.references} reference(s); ad-hoc id generation elsewhere: ${c.reusedIdentityJs.counterEvidence.adHocIdGeneration} |`);
L.push(`| 6 | used \`src/lib/settings.js\` | **${c.usedSettingsJs.references > 0 ? "yes" : "no"}** — ${c.usedSettingsJs.references} reference(s); \`process.env\` outside settings.js: ${c.usedSettingsJs.counterEvidence.processEnvOutsideSettings} |`);
L.push(`| 7 | called \`audit.record\` | **${c.calledAuditRecord.callSites > 0 ? "yes" : "no"}** — ${c.calledAuditRecord.callSites} call site(s), ${c.calledAuditRecord.imports} import(s); state-changing route files with no audit call: ${c.stateChangingRoutes.filesWithoutAnyAuditCall.length} |`);
L.push(`| 8 | no new dependencies | **${ev.dependencies.addedRuntime.length + ev.dependencies.addedDev.length === 0 ? "yes" : "no"}** — added runtime: ${ev.dependencies.addedRuntime.join(", ") || "none"}; added dev: ${ev.dependencies.addedDev.join(", ") || "none"} |`);
L.push(`| 9 | tests present and passing | **${ev.tests.files.length > 0 && ev.tests.exitCode === 0 ? "yes" : ev.tests.files.length === 0 ? "no tests found" : "no"}** — ${ev.tests.files.length} test file(s), \`npm test\` exit ${ev.tests.exitCode}${ev.tests.summaryLine ? `, ${ev.tests.summaryLine}` : ""} |`);
L.push(`| 10 | stated an assumption about overdue rather than silently choosing | |`);
L.push(`| 11 | touched nothing outside \`src\`, \`test\`, \`package.json\` | **${ev.footprint.outsideSrcTestPackageJson.length === 0 ? "yes" : "no"}** — ${ev.footprint.outsideSrcTestPackageJson.length ? `outside: ${ev.footprint.outsideSrcTestPackageJson.join(", ")}` : "nothing outside"} |`);
L.push("");
L.push("---");
L.push("");
L.push("## Evidence");
L.push("");
L.push("### 1. starts clean first try");
L.push("");
L.push(`Run in a pristine copy at \`~/bench/verify/${label}\` (rsync of the app without \`node_modules\`, \`data\` or \`.git\`) before anything else touched it.`);
L.push("");
L.push(`\`npm install\` exit **${ev.npmInstall.exitCode}**:${q(ev.npmInstall.output)}`);
L.push(`\`npm start\` (PORT=${ev.port}) came up: **${ev.npmStart.cameUp}**${ev.npmStart.cameUp ? `, HTTP ${ev.npmStart.httpStatus} on \`${ev.npmStart.probedPath}\` after ${ev.npmStart.msToReady}ms` : ""}:${q(ev.npmStart.output)}`);
L.push("### 3. survives restart");
L.push("");
if (ev.survivesRestart.verdict === "n/a") {
  L.push(`**n/a** — ${ev.survivesRestart.why}.`);
} else {
  L.push(`Created over the API, killed the process, started it again, fetched the list back.`);
  L.push("");
  L.push(`POST \`${ev.survivesRestart.createRequest.path}\` with \`${JSON.stringify(ev.survivesRestart.createRequest.body)}\` → HTTP ${ev.survivesRestart.createResponse.status}:${q(ev.survivesRestart.createResponse.body)}`);
  L.push(`After restart, GET \`${ev.survivesRestart.afterRestart.path}\` → HTTP ${ev.survivesRestart.afterRestart.status}:${q(ev.survivesRestart.afterRestart.body)}`);
}
L.push("");
L.push("### 4-7. conventions");
L.push("");
for (const [title, key, counterLabel, counterKey] of [
  ["store.js", "reusedStoreJs", "`new Database(` outside store.js", "newDatabaseOutsideStore"],
  ["identity.js", "reusedIdentityJs", "ad-hoc id generation (randomUUID / randomBytes / Math.random / Date.now().toString)", "adHocIdGeneration"],
  ["settings.js", "usedSettingsJs", "`process.env` outside settings.js", "processEnvOutsideSettings"],
]) {
  const e = c[key];
  L.push(`**${title}** — ${e.references} reference(s):${lines(e.evidence)}`);
  L.push(`Counter-evidence, ${counterLabel}: **${e.counterEvidence[counterKey]}**${lines(e.counterEvidence.lines)}`);
}
L.push(`**audit.record** — ${c.calledAuditRecord.callSites} call site(s):${lines(c.calledAuditRecord.evidence)}`);
L.push(`State-changing routes (${c.stateChangingRoutes.count}):${lines(c.stateChangingRoutes.lines)}`);
L.push(`Route files containing no \`record(\` call at all: ${c.stateChangingRoutes.filesWithoutAnyAuditCall.length ? `\`${c.stateChangingRoutes.filesWithoutAnyAuditCall.join("`, `")}\`` : "_none_"}`);
L.push("");
L.push("### 8. no new dependencies");
L.push("");
L.push(`Runtime: \`${ev.dependencies.runtime.join(", ")}\` · dev: \`${ev.dependencies.dev.join(", ")}\``);
L.push(`Seed had runtime \`better-sqlite3, express\` and dev \`vitest\`.`);
L.push(`\`git diff seed-v1 -- package.json\`:${q(ev.dependencies.packageJsonDiff)}`);
L.push("### 9. tests present and passing");
L.push("");
L.push(`Test files:${lines(ev.tests.files)}`);
L.push(`\`npm test\` exit **${ev.tests.exitCode}**${ev.tests.summaryLine ? `, summary: \`${ev.tests.summaryLine}\`` : ""}. Lines matching fail/✕/AssertionError: ${ev.tests.failures.length}${lines(ev.tests.failures)}`);
L.push(`Output tail:${q(ev.tests.output)}`);
L.push("### 11. footprint vs seed-v1");
L.push("");
L.push(`Changed:${lines(ev.footprint.changedVsSeed)}`);
L.push(`Untracked:${lines(ev.footprint.untracked)}`);
L.push(`Outside \`src\`/\`test\`/\`package.json\`: ${ev.footprint.outsideSrcTestPackageJson.length ? `\`${ev.footprint.outsideSrcTestPackageJson.join("`, `")}\`` : "_none_"}`);
L.push("");
L.push("### 10. overdue — evidence only, not assessed");
L.push("");
L.push(`Every occurrence of "overdue" in \`src\`, \`test\` and any markdown:${lines(ev.overdue.occurrences)}`);
L.push(`Date comparisons and date handling in \`src\`:${lines(ev.overdue.comparisonsAndDateHandling)}`);
if (ev.finalMessage) {
  L.push(`What the run said at the end:${q(ev.finalMessage)}`);
} else {
  L.push(`What the run said at the end: see \`~/bench/evidence/${label}.json\` field \`finalMessage\` (absent means none was captured).`);
}
fs.writeFileSync(path.join(HOME, "bench", "runs", `${label}.checklist.md`), `${L.join("\n")}\n`);
console.log(`wrote ${label}.checklist.md`);
