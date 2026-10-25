// UI strings in English and Portuguese, and the one function that turns an
// English finding into a Portuguese one.
//
// Two separate things live here, and keeping them separate is the design:
//
//  1. CHROME — titles, buttons, confirms, badges. Static strings, both
//     languages in this file, so the page can flip without a refetch.
//
//  2. DIAGNOSTICS — the `detail` / `fix` / `command` prose of a finding.
//     English is the SOURCE language: every sentence is authored inline at the
//     `mk()` call that emits it (lib/preflight-core.mjs), where a reader of the
//     check can still see what it says. Each call also tags the finding with a
//     message key and the values it interpolated; `localiseFindings` below
//     rewrites the prose from lib/messages.pt.mjs and strips the tag. English
//     output is byte-identical to a build without this module, so the existing
//     fixture tests prove the tagging changed nothing.
//
// This diverges from project-viewer/lib/i18n.mjs on purpose: that fitting
// refuses to translate prose because its prose is authored content. Ours is
// generated from templates, so it can be translated, and is. The mechanism
// (`t`, `normaliseLang`, `keysFor`) is copied from there so a reader of one
// recognises the other.
//
// Pure. `t()` is a total function: an unknown key returns the key itself rather
// than throwing, because a missing label should look wrong, not take down a page.

import { MESSAGES_PT } from "./messages.pt.mjs";

export const LANGS = ["en", "pt"];
export const DEFAULT_LANG = "en";

/** Coerce anything into a supported language tag. Accepts "pt-BR", "PT", etc. */
export function normaliseLang(value, fallback = DEFAULT_LANG) {
  const raw = String(value ?? "").toLowerCase().trim();
  if (!raw) return fallback;
  const base = raw.split(/[-_]/)[0];
  return LANGS.includes(base) ? base : fallback;
}

/** The other language, for the toggle. Two languages, so this is a flip. */
export function otherLang(lang) {
  return normaliseLang(lang) === "pt" ? "en" : "pt";
}

// Timestamps follow the UI language, never the browser: a Portuguese page on a
// Mac set to en-US must not print 9/17, month first. en-GB rather than en-US
// so both languages read day-first and differ only in separators. Numbers stay
// raw — the counts on this page never reach a grouping separator, and
// milliseconds are a machine value.
export const LOCALE = { en: "en-GB", pt: "pt-PT" };

const formatters = new Map();
function formatter(lang, options) {
  const key = `${lang}|${JSON.stringify(options)}`;
  if (!formatters.has(key)) formatters.set(key, new Intl.DateTimeFormat(LOCALE[normaliseLang(lang)], options));
  return formatters.get(key);
}
export function fmtDateTime(lang, iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso ?? "") : formatter(lang, { dateStyle: "short", timeStyle: "medium" }).format(d);
}
export function fmtTime(lang, iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso ?? "") : formatter(lang, { timeStyle: "medium" }).format(d);
}

// ---------------------------------------------------------------------------
// Interpolation. `{name}` placeholders, filled from `vars`. A value that is
// itself `{ key, vars }` is a nested message (the verify label "the last up
// (…)" inside "X failed verify at …"), resolved in the same language. A key
// with `.one` / `.other` variants is picked by `vars.n` — two forms are
// complete for this pair of languages: English and European Portuguese both
// split exactly singular / non-singular, so no plural engine is needed.
// ---------------------------------------------------------------------------

function fill(template, vars, lang, table) {
  let out = template;
  for (const [name, value] of Object.entries(vars ?? {})) {
    const text = value && typeof value === "object" && typeof value.key === "string"
      ? lookup(table, lang, value.key, value.vars)
      : String(value ?? "");
    out = out.split(`{${name}}`).join(text);
  }
  return out;
}

function lookup(table, lang, key, vars) {
  const n = vars && typeof vars.n === "number" ? vars.n : null;
  const plural = n !== null ? table[`${key}.${n === 1 ? "one" : "other"}`] : undefined;
  const template = plural ?? table[key];
  if (typeof template !== "string") return key;
  return fill(template, vars, lang, table);
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

const CHROME = {
  en: {
    "app.title": "Preflight",
    "app.subtitle": "Composition doctor",
    "overall.pass": "PASS",
    "overall.warn": "WARN",
    "overall.fail": "FAIL",
    "counts": "{pass} pass · {warn} warn · {fail} fail",
    "info.chip": "{n} info — checked, nothing to do",
    "active.chip": "active: {id}",
    "degraded.chip": "degraded — app down",
    "refresh": "Refresh",
    "refresh.busy": "Refreshing…",
    "generated.at": "at {time}",
    "lang.title": "Ler a interface em português",
    "lang.en": "EN",
    "lang.pt": "PT",
    "status.info": "info",
    "status.pass": "pass",
    "status.warn": "warn",
    "status.fail": "fail",

    "resolved.since": "Resolved since the last run:",
    "headline.failing.one": "{n} fitting failing verify:",
    "headline.failing.other": "{n} fittings failing verify:",
    "headline.none": "No fitting is failing verify",
    "headline.other": "Other issues:",
    "other.library-crosscheck": "registry",
    "other.port-collisions": "port",
    "other.serve-coverage": "serve",
    "other.orphans": "orphan",
    "other.drift": "drift",
    "other.kind-vocabulary": "kind",
    "other.repo-root": "setup",
    "chip.title": "Show every finding that mentions {id}",
    "filter.about": "Everything about",
    "filter.showAll": "Show all checks",

    "sweep.label": "Verify sweep",
    "sweep.run": "Run full verify sweep",
    "sweep.running": "Sweeping… (can take minutes)",
    "sweep.note": "Requires a stopped composition. Runs setup and every verify hook.",
    "sweep.title.stop": "Stop the composition first; the sweep runs setup and every verify hook",
    "sweep.title.appDown": "Needs the Garrison app up",
    "sweep.needsStopped": "Stop the composition before running its verify sweep. Refresh if its state has changed.",
    "sweep.confirm": "Run the FULL verify sweep for \"{id}\"?\n\nThis is heavy: it flips the runner status, may run apm install, and runs every setup + verify hook. It is the same code path up() uses.",

    "check.app-reachable": "Garrison app",
    "check.repo-root": "Repo root",
    "check.manifest-parse": "Manifests",
    "check.ledger": "Finding ledger",
    "check.verify-results": "1 · Verify results (last up)",
    "check.verify-sweep": "1b · Live verify sweep",
    "check.library-crosscheck": "2 · Library registration",
    "check.port-collisions": "3 · Ports (both axes)",
    "check.serve-coverage": "4 · Tailscale serve coverage",
    "check.orphans": "5 · Orphan processes",
    "check.drift": "6 · Composition drift",
    "check.kind-vocabulary": "7 · Capability kinds",
    "check.hook-cwd": "8 · Hook working directories",
    "check.config-projection": "9 · Config projection",
    "section.rows.one": "{n} row",
    "section.rows.other": "{n} rows",

    "fix.label": "fix:",
    "fix.button": "Fix it",
    "fix.running": "Fixing…",
    "fix.retry": "Retry repair",
    "fix.done": "{message} — refresh to re-check",
    "fix.confirm": "Fix \"{id}\"?\n\nThis will run:\n{command}",
    "card.button": "File as card",
    "card.running": "Filing…",
    "card.confirm": "File \"{check}/{id}\" as a Kanban card in backlog?",
    "evidence.show": "Show evidence",
    "evidence.hide": "Hide evidence",
    "age.new": "new",
    "age.regressed": "regressed from {status}",

    "journal.title": "Recent fixes (what the doctor did)",
    "journal.uncommitted": "uncommitted",
    "journal.review": "Review every change below before committing library.json.",
    "journal.commit": "Commit library.json",
    "journal.committing": "Committing…",
    "journal.commitConfirm": "Commit the full data/library.json diff shown below?\n\nThis includes every change shown, including edits made elsewhere. The server refuses if the diff or git state has changed. Other staged files stay staged; nothing is pushed.",
    "journal.failed": "FAILED: {error}",
    "journal.params": "params:",
    "res.ok": "resolved ✓ re-checked",
    "res.bad": "NOT resolved — re-check failed",

    "error.load": "Could not load Preflight: {error}",
    "error.retry": "Retry",
    "loading": "Building the report…",
    "loading.note": "Reading every manifest, the live listeners and the tailnet. The next open is instant."
  },
  pt: {
    "app.title": "Preflight",
    "app.subtitle": "Médico da composição",
    "overall.pass": "OK",
    "overall.warn": "AVISO",
    "overall.fail": "FALHA",
    "counts": "{pass} ok · {warn} avisos · {fail} falhas",
    "info.chip": "{n} info — verificado, nada a fazer",
    "active.chip": "ativa: {id}",
    "degraded.chip": "degradado — app em baixo",
    "refresh": "Atualizar",
    "refresh.busy": "A atualizar…",
    "generated.at": "às {time}",
    "lang.title": "Read the interface in English",
    "lang.en": "EN",
    "lang.pt": "PT",
    "status.info": "info",
    "status.pass": "ok",
    "status.warn": "aviso",
    "status.fail": "falha",

    "resolved.since": "Resolvido desde a última execução:",
    "headline.failing.one": "{n} fitting a falhar o verify:",
    "headline.failing.other": "{n} fittings a falhar o verify:",
    "headline.none": "Nenhum fitting está a falhar o verify",
    "headline.other": "Outros problemas:",
    "other.library-crosscheck": "registo",
    "other.port-collisions": "porta",
    "other.serve-coverage": "serve",
    "other.orphans": "órfão",
    "other.drift": "drift",
    "other.kind-vocabulary": "kind",
    "other.repo-root": "setup",
    "chip.title": "Mostrar tudo o que menciona {id}",
    "filter.about": "Tudo sobre",
    "filter.showAll": "Mostrar todos os checks",

    "sweep.label": "Varredura de verify",
    "sweep.run": "Correr a varredura completa",
    "sweep.running": "A correr… (pode demorar minutos)",
    "sweep.note": "Exige uma composição parada. Corre o setup e todos os hooks de verify.",
    "sweep.title.stop": "Para a composição primeiro; a varredura corre o setup e todos os hooks de verify",
    "sweep.title.appDown": "Precisa da app Garrison a correr",
    "sweep.needsStopped": "Para a composição antes de correr a varredura de verify. Atualiza se o estado dela mudou.",
    "sweep.confirm": "Correr a varredura COMPLETA de verify para \"{id}\"?\n\nÉ pesado: muda o estado do runner, pode correr apm install e corre todos os hooks de setup + verify. É o mesmo caminho que o up() usa.",

    "check.app-reachable": "App Garrison",
    "check.repo-root": "Raiz do repositório",
    "check.manifest-parse": "Manifestos",
    "check.ledger": "Histórico de findings",
    "check.verify-results": "1 · Resultados do verify (último up)",
    "check.verify-sweep": "1b · Varredura de verify ao vivo",
    "check.library-crosscheck": "2 · Registo na library",
    "check.port-collisions": "3 · Portas (ambos os eixos)",
    "check.serve-coverage": "4 · Cobertura do tailscale serve",
    "check.orphans": "5 · Processos órfãos",
    "check.drift": "6 · Drift da composição",
    "check.kind-vocabulary": "7 · Kinds de capacidade",
    "check.hook-cwd": "8 · Diretórios de trabalho dos hooks",
    "check.config-projection": "9 · Projeção da config",
    "section.rows.one": "{n} linha",
    "section.rows.other": "{n} linhas",

    "fix.label": "solução:",
    "fix.button": "Corrigir",
    "fix.running": "A corrigir…",
    "fix.retry": "Tentar de novo",
    "fix.done": "{message} — atualiza para voltar a verificar",
    "fix.confirm": "Corrigir \"{id}\"?\n\nIsto vai executar:\n{command}",
    "card.button": "Criar cartão",
    "card.running": "A criar…",
    "card.confirm": "Criar um cartão no backlog do Kanban para \"{check}/{id}\"?",
    "evidence.show": "Mostrar evidência",
    "evidence.hide": "Esconder evidência",
    "age.new": "novo",
    "age.regressed": "regrediu de {status}",

    "journal.title": "Correções recentes (o que o médico fez)",
    "journal.uncommitted": "por commitar",
    "journal.review": "Revê todas as alterações abaixo antes de commitar o library.json.",
    "journal.commit": "Commitar library.json",
    "journal.committing": "A commitar…",
    "journal.commitConfirm": "Commitar o diff completo do data/library.json mostrado abaixo?\n\nInclui todas as alterações mostradas, mesmo as feitas noutro lado. O servidor recusa se o diff ou o estado do git tiverem mudado. Outros ficheiros em stage ficam em stage; nada é enviado (push).",
    "journal.failed": "FALHOU: {error}",
    "journal.params": "parâmetros:",
    "res.ok": "resolvido ✓ reverificado",
    "res.bad": "NÃO resolvido — a reverificação falhou",

    "error.load": "Não foi possível carregar o Preflight: {error}",
    "error.retry": "Tentar de novo",
    "loading": "A construir o relatório…",
    "loading.note": "A ler todos os manifestos, os listeners ativos e a tailnet. A próxima abertura é instantânea."
  }
};

/**
 * Look up a chrome string. `vars` fills {placeholders}; a key with .one/.other
 * variants is picked by `vars.n`. An unknown key returns the key, so a gap is
 * visible in the page instead of crashing the render.
 */
export function t(lang, key, vars) {
  const table = CHROME[normaliseLang(lang)] ?? CHROME[DEFAULT_LANG];
  const n = vars && typeof vars.n === "number" ? vars.n : null;
  const variant = n !== null ? `${key}.${n === 1 ? "one" : "other"}` : null;
  const template = (variant && (table[variant] ?? CHROME[DEFAULT_LANG][variant])) ?? table[key] ?? CHROME[DEFAULT_LANG][key] ?? key;
  return fill(template, vars, lang, table);
}

/** Exposed for the test suite, which asserts both tables carry the same keys. */
export function keysFor(lang) {
  return Object.keys(CHROME[normaliseLang(lang)]).sort();
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

const DIAGNOSTICS = { pt: MESSAGES_PT };

/** Exposed for the parity test: every key the Portuguese catalog defines. */
export function diagnosticKeysFor(lang) {
  return Object.keys(DIAGNOSTICS[normaliseLang(lang)] ?? {}).sort();
}

/**
 * Rewrite each finding's prose in `lang` from its `i18n` tag, then strip the
 * tag so the wire shape is identical in every language. English is the source
 * language: it returns the findings untouched apart from the strip. Never
 * touches `evidence` (raw command output), `action.id` or `action.params`
 * (they cross the wire to the repair whitelist and must match byte-for-byte).
 */
export function localiseFindings(findings, lang = DEFAULT_LANG) {
  const target = normaliseLang(lang);
  const table = DIAGNOSTICS[target];
  return findings.map((finding) => {
    const { i18n, ...rest } = finding;
    if (!table || !i18n || typeof i18n.key !== "string") return rest;
    const vars = i18n.vars ?? {};
    const has = (key) => typeof table[key] === "string" || (typeof vars.n === "number" && typeof table[`${key}.other`] === "string");
    const out = { ...rest };
    if (has(i18n.key)) {
      let detail = lookup(table, target, i18n.key, vars);
      if (i18n.demote && has(i18n.demote)) {
        detail = lookup(table, target, "finding.demoted", { detail, reason: lookup(table, target, i18n.demote, vars) });
      }
      out.detail = detail;
    }
    if (out.fix && has(`${i18n.key}.fix`)) out.fix = lookup(table, target, `${i18n.key}.fix`, vars);
    if (out.action && has(`${i18n.key}.command`)) {
      out.action = { ...out.action, command: lookup(table, target, `${i18n.key}.command`, vars) };
    }
    return out;
  });
}
