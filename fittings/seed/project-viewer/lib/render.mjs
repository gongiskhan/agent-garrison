// The deterministic renderer. Pure: it receives a manifest plus the already
// extracted-and-verified sample texts and returns an HTML string. It never
// touches git or the filesystem, which is what makes "re-rendering is free"
// testable — the suite asserts byte-identical output across runs.
//
// Language is a parameter, not a build. Same manifest plus same language always
// yields the same bytes, so a bilingual interface costs nothing at render time
// and nothing in tokens. Chrome strings come from i18n.mjs; prose comes from the
// manifest through pickText, which reads a plain string or a per-language map.
//
// The half-and-half unit format from the brief is one CSS grid per step: code on
// one side, plain-language description on the other. Directional connectors sit
// between steps and indicate order only; there is no diagram anywhere, by design.
//
// Trust rule enforced here: a step whose sample failed verification renders an
// integrity-failure panel INSTEAD of code. There is no code path that displays
// unverified text as though it were the repo's.

import { escapeHtml, renderCodeBlock } from "./highlight.mjs";
import { renderFilePatch } from "./diff.mjs";
import { DEFAULT_LANG, LANGS, normaliseLang, pickText, t } from "./i18n.mjs";

// ---------------------------------------------------------------- prose

/**
 * Model-authored text is rendered as plain text, escaped, with two affordances:
 * `backtick spans` become <code>, and blank lines become paragraphs. Deliberately
 * NOT markdown: a full markdown pipeline would need a sanitiser, and a
 * hand-rolled sanitiser is a standing XSS liability for text a model wrote. The
 * descriptions in this product are prose, not documents, so the trade costs
 * nothing real.
 *
 * Accepts a string or a per-language map, so a bilingual manifest needs no
 * special handling at any call site.
 */
export function prose(text, lang = DEFAULT_LANG) {
  const raw = pickText(text, lang).trim();
  if (!raw) return "";
  return raw
    .split(/\n\s*\n/)
    .map((para) => {
      const escaped = escapeHtml(para.replace(/\s*\n\s*/g, " "));
      const withCode = escaped.replace(/`([^`]+)`/g, "<code>$1</code>");
      return `<p>${withCode}</p>`;
    })
    .join("");
}

/** Escaped single-line text from a string-or-map field. */
function line(text, lang) {
  return escapeHtml(pickText(text, lang));
}

// ---------------------------------------------------------------- page shell

/**
 * A compact machine index of the page, emitted as an inert JSON script block.
 *
 * This is the "good for agents" half of the brief made concrete. A person reads
 * the rendered document; an agent reads this one block and knows every step's
 * file, line range, anchor commit and staleness without scraping markup or
 * guessing at class names. Browsers ignore an unknown script type, so it costs
 * the human reader nothing.
 */
export function machineIndex(flow, { stateIndex = null } = {}) {
  if (!flow) return null;
  return {
    flowId: flow.flowId,
    source: flow.source,
    anchoredAt: flow.anchoredAt ?? null,
    provenance: flow.provenance ?? null,
    currentState: stateIndex,
    states: (flow.states ?? []).map((state, i) => ({
      index: i,
      id: state.id,
      url: `/flow/${encodeURIComponent(flow.flowId)}/state/${i}`,
      steps: (state.steps ?? []).map((step) => ({
        id: step.id,
        kind: step.kind,
        collapsed: step.collapsed === true || step.kind === "glue",
        file: step.sample?.file ?? step.diffSample?.file ?? null,
        startLine: step.sample?.startLine ?? null,
        endLine: step.sample?.endLine ?? null,
        highlights: step.sample?.highlights ?? null,
        sha: step.sample?.sha ?? step.diffSample?.sha ?? flow.anchoredAt?.sha ?? null,
        staleness: step.staleness?.status ?? "fresh",
        narrated: hasProse(step.description),
      })),
    })),
  };
}

function hasProse(value) {
  return pickText(value, DEFAULT_LANG).trim().length > 0 || pickText(value, "pt").trim().length > 0;
}

function machineBlock(data) {
  if (!data) return "";
  // Escaped so a `</script>` inside any string cannot break out of the block.
  const json = JSON.stringify(data, null, 2).replace(/</g, "\\u003c");
  return `<script type="application/json" id="pv-index">${json}</script>`;
}

/**
 * Both languages, side by side, with the current one marked.
 *
 * The old control was one link labelled with the language you would GET — so an
 * English page showed the word "Português", and every reader sensibly read that as
 * "this page is in Portuguese". A toggle whose label is its destination is only
 * unambiguous to whoever wrote it. Two segments with the active one marked cannot be
 * misread, and it is what the shell does for its own two-state controls.
 */
function langControl(current) {
  const items = LANGS.map((code) => {
    const label = t(code, "lang.code");
    if (code === current) {
      return `<span class="langopt is-active" aria-current="true">${escapeHtml(label)}</span>`;
    }
    return (
      `<a class="langopt" href="/lang/${code}" rel="nofollow" title="${escapeHtml(
        t(current, `lang.to.${code}`)
      )}">${escapeHtml(label)}</a>`
    );
  }).join("");
  return `<div class="langswitch" role="group" aria-label="${escapeHtml(t(current, "lang.landmark"))}">${items}</div>`;
}

/**
 * Said out loud when the interface language and the PROSE language differ.
 *
 * Without this the reader flips to Portuguese, sees English descriptions, and
 * reasonably concludes the translation is broken. It is not: chrome is translated
 * because it is a fixed set of strings, while prose is authored once in a language
 * chosen at intake, because writing every description twice doubles the only
 * genuinely expensive part of this product. A stated limit is not a bug; a silent
 * one is.
 *
 * `proseLang` is read from viewer.json, not from a flow — the flow schema is locked
 * at version 1 and this needed no field in it.
 */
function proseLangNote(interfaceLang, proseLang) {
  if (!proseLang || proseLang === interfaceLang) return "";
  const named = t(interfaceLang, `prose.lang.${proseLang}`);
  if (!named || named.startsWith("prose.lang.")) return "";
  return (
    `<p class="prose-lang-note">${escapeHtml(
      t(interfaceLang, "prose.otherLang", { lang: named })
    )}</p>`
  );
}

export function layout({
  title,
  project,
  body,
  activeNav = "",
  extraClass = "",
  lang = DEFAULT_LANG,
  machine = null,
  proseLang = null,
}) {
  const L = normaliseLang(lang);
  const nav = [
    ["/", t(L, "nav.flows")],
    ["/findings", t(L, "nav.findings")],
    ["/uncommitted", t(L, "nav.uncommitted")],
    ["/commits", t(L, "nav.commits")],
    ["/files", t(L, "nav.files")],
    ["/docs", t(L, "nav.docs")],
    ["/compare", t(L, "nav.compare")],
  ]
    .map(
      ([href, label]) =>
        `<a href="${href}" class="${activeNav === href ? "is-active" : ""}">${escapeHtml(label)}</a>`
    )
    .join("");

  return `<!doctype html>
<html lang="${L}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — ${escapeHtml(t(L, "brand"))}</title>
<link rel="stylesheet" href="/assets/viewer.css">
</head>
<body class="${escapeHtml(extraClass)}" data-lang="${L}">
<a class="skip" href="#content">${escapeHtml(t(L, "skip.toContent"))}</a>
<header class="topbar">
  <div class="brand"><a href="/">${escapeHtml(t(L, "brand"))}</a>${
    project
      ? `<a class="project" href="/projects" title="${escapeHtml(t(L, "projects.switch.why"))}">${escapeHtml(
          project
        )}<span class="project-caret" aria-hidden="true">▾</span></a>`
      : ""
  }</div>
  <nav class="mainnav" aria-label="${escapeHtml(t(L, "nav.landmark"))}">${nav}</nav>
  ${langControl(L)}
</header>
<main id="content">${proseLangNote(L, proseLang)}${body}</main>
${machineBlock(machine)}
<script src="/assets/viewer.js" defer></script>
</body>
</html>
`;
}

// ---------------------------------------------------------------- badges

/**
 * A staleness badge, but ONLY when there is something to say.
 *
 * A badge on every step is a badge nobody reads: when nothing is stale, a wall of
 * green trains the eye to skip the very element that must catch it the day one
 * turns amber. Freshness is reported once, on the flow header, and per-step badges
 * are reserved for trouble.
 */
export function stalenessBadge(staleness, lang = DEFAULT_LANG) {
  const L = normaliseLang(lang);
  const status = staleness?.status ?? "fresh";
  if (status === "fresh") return "";
  const known = ["stale", "invalidated"].includes(status);
  const label = known ? t(L, `badge.${status}`) : status;
  const why = known ? t(L, `badge.${status}.why`) : "";
  const reason = staleness?.reason ? ` — ${staleness.reason}` : "";
  return `<span class="badge b-${escapeHtml(status)}" title="${escapeHtml(why + reason)}">${escapeHtml(
    label
  )}</span>`;
}

/** One badge for the whole flow: how much of it is currently trustworthy. */
function flowTrustBadge(flow, lang) {
  const L = normaliseLang(lang);
  let total = 0;
  let bad = 0;
  for (const state of flow.states ?? []) {
    for (const step of state.steps ?? []) {
      total += 1;
      const s = step.staleness?.status ?? "fresh";
      if (s !== "fresh") bad += 1;
    }
  }
  if (total === 0) return "";
  if (bad === 0) {
    return `<span class="badge b-verified" title="${escapeHtml(t(L, "badge.fresh.why"))}">${escapeHtml(
      t(L, "flow.allVerified", { n: total })
    )}</span>`;
  }
  return `<span class="badge b-stale" title="${escapeHtml(t(L, "badge.stale.why"))}">${escapeHtml(
    t(L, "flow.needsWork", { stale: bad, n: total })
  )}</span>`;
}

function sourceBadge(source, lang) {
  const L = normaliseLang(lang);
  const why = ["ui", "e2e", "drillbook", "commit"].includes(source) ? t(L, `source.${source}.why`) : "";
  return `<span class="badge b-src b-src-${escapeHtml(source)}" title="${escapeHtml(why)}">${escapeHtml(
    source
  )}</span>`;
}

function kindLabel(kind, lang) {
  const L = normaliseLang(lang);
  return ["code", "db", "filewrite", "dep", "glue"].includes(kind) ? t(L, `kind.${kind}`) : kind;
}

// ---------------------------------------------------------------- steps

/**
 * One step. `resolved` is the verification result for this step's sample:
 *   { ok: true, text }                     → render the code
 *   { ok: false, expected, actual, error } → render the integrity panel
 */
export function renderStep(
  step,
  resolved,
  { flowId, findings = [], lang = DEFAULT_LANG, position = null, total = null, stateId = null } = {}
) {
  const L = normaliseLang(lang);
  const kind = step.kind ?? "code";
  const collapsed = step.collapsed === true || kind === "glue";
  const stepFindings = findings.filter((f) => f.stepId === step.id);
  const narrated = pickText(step.description, L).trim().length > 0;

  const codePane = renderCodePane(step, resolved, L);
  // No title in this pane: the step header already carries it, and repeating it
  // wasted a line on every single step.
  const descPane =
    `<div class="pane desc" aria-label="${escapeHtml(t(L, "desc.landmark"))}">` +
    (narrated
      ? prose(step.description, L)
      : // A step generated mechanically but not yet narrated says so. An empty
        // half otherwise reads as "the explanation is short" when the truth is
        // "the explanation has not been written".
        `<p class="not-narrated"><b>${escapeHtml(t(L, "step.notNarrated"))}.</b> ${escapeHtml(
          t(L, "step.notNarrated.why")
        )}</p>`) +
    (kind === "dep" && step.note ? `<div class="dep-note">${prose(step.note, L)}</div>` : "") +
    renderStepFindings(stepFindings, L) +
    `</div>`;

  const anchorFile = step.sample?.file ?? step.diffSample?.file ?? "";
  const anchorLine = step.sample?.startLine ?? "";
  const endLine = step.sample?.endLine ?? "";
  const sha = step.sample?.sha ?? step.diffSample?.sha ?? "";

  // Everything an agent needs to jump straight to the source, on the element
  // itself. Names are stable and are asserted by the test suite.
  const attrs = [
    `data-step="${escapeHtml(step.id)}"`,
    `data-flow="${escapeHtml(flowId ?? "")}"`,
    stateId ? `data-state="${escapeHtml(stateId)}"` : "",
    `data-kind="${escapeHtml(kind)}"`,
    `data-file="${escapeHtml(anchorFile)}"`,
    anchorLine ? `data-start-line="${anchorLine}"` : "",
    endLine ? `data-end-line="${endLine}"` : "",
    sha ? `data-sha="${escapeHtml(sha)}"` : "",
    `data-staleness="${escapeHtml(step.staleness?.status ?? "fresh")}"`,
    `data-collapsed="${collapsed ? "true" : "false"}"`,
    `data-narrated="${narrated ? "true" : "false"}"`,
  ]
    .filter(Boolean)
    .join(" ");

  const head =
    `<div class="step-head">` +
    (position && total ? `<span class="stepn" title="${escapeHtml(t(L, "step.position", { i: position, n: total }))}">${position}/${total}</span>` : "") +
    `<span class="kind k-${escapeHtml(kind)}">${escapeHtml(kindLabel(kind, L))}</span>` +
    `<h3 class="step-title">${line(step.title, L)}</h3>` +
    stalenessBadge(step.staleness, L) +
    (anchorFile
      ? `<a class="anchor" href="/files/${encodeURI(anchorFile)}"><code>${escapeHtml(anchorFile)}${
          anchorLine ? `:${anchorLine}` : ""
        }</code></a>`
      : "") +
    (collapsed
      ? `<span class="fold-hint"><span class="when-closed">${escapeHtml(
          t(L, "fold.expand")
        )}</span><span class="when-open">${escapeHtml(t(L, "fold.collapse"))}</span></span>`
      : "") +
    `</div>`;

  const inner = `<div class="split">${codePane}${descPane}</div>`;

  // Collapse, never omit: a folded step still carries its full content in the
  // DOM, so an agent reading the HTML never hits a dead end.
  const bodyHtml = collapsed
    ? `<details class="step-fold"><summary>${head}</summary>${inner}</details>`
    : `${head}${inner}`;

  // `id` so the outline can link straight to a step, and so any reader can share
  // a link to one specific step rather than to a whole state.
  return (
    `<article id="${escapeHtml(step.id)}" class="step k-${escapeHtml(kind)}${
      collapsed ? " is-collapsed" : ""
    }" ${attrs}>${bodyHtml}</article>` +
    renderConnectors(step)
  );
}

function renderCodePane(step, resolved, L) {
  if (step.kind === "db" || step.kind === "filewrite") {
    const label = step.kind === "db" ? t(L, "pane.db") : t(L, "pane.filewrite");
    return (
      `<div class="pane code-pane external">` +
      `<div class="pane-label">${escapeHtml(label)}</div>` +
      `<pre class="ascii">${escapeHtml(pickText(step.asciiSample, L))}</pre>` +
      `</div>`
    );
  }

  if (step.diffSample) {
    if (resolved && resolved.ok === false) return integrityPanel(step.diffSample, resolved, L);
    return (
      `<div class="pane code-pane" aria-label="${escapeHtml(t(L, "code.landmark"))}">` +
      renderFilePatch(step.diffSample.patch, {
        file: step.diffSample.file,
        status: step.diffSample.status ?? "modified",
        emptyLabel: t(L, "diff.noChanges"),
      }) +
      `</div>`
    );
  }

  if (!step.sample) {
    return `<div class="pane code-pane empty"><p class="muted">${escapeHtml(t(L, "step.noSample"))}</p></div>`;
  }

  if (!resolved || resolved.ok === false) return integrityPanel(step.sample, resolved, L);

  return (
    `<div class="pane code-pane" aria-label="${escapeHtml(t(L, "code.landmark"))}">` +
    `<div class="pane-label"><code>${escapeHtml(step.sample.file)}</code>` +
    `<span class="lines">${escapeHtml(
      t(L, "pane.lines", { from: step.sample.startLine, to: step.sample.endLine })
    )}</span>` +
    (step.sample.sha ? `<span class="at-sha">@ ${escapeHtml(step.sample.sha.slice(0, 8))}</span>` : "") +
    `</div>` +
    renderCodeBlock(resolved.text, {
      startLine: step.sample.startLine,
      lang: step.sample.lang ?? "ts",
      highlights: step.sample.highlights ?? [],
      file: step.sample.file,
    }) +
    `</div>`
  );
}

/**
 * The trust guarantee, made visible. When a sample's hash does not match the
 * repo, the viewer says so loudly and shows no code at all. A viewer that
 * silently showed the wrong lines would be worse than no viewer.
 */
function integrityPanel(sample, resolved, L) {
  const reason = resolved?.error ?? t(L, "integrity.default");
  return (
    `<div class="pane code-pane integrity-fail">` +
    `<div class="pane-label"><code>${escapeHtml(sample.file ?? "")}</code></div>` +
    `<div class="integrity">` +
    `<strong>${escapeHtml(t(L, "integrity.title"))}</strong>` +
    `<p>${escapeHtml(t(L, "integrity.body", { mode: "update" }))}</p>` +
    `<p class="why">${escapeHtml(reason)}</p>` +
    (resolved?.expected && resolved?.actual
      ? `<dl class="hashes">` +
        `<dt>${escapeHtml(t(L, "integrity.recorded"))}</dt><dd><code>${escapeHtml(
          String(resolved.expected).slice(0, 16)
        )}…</code></dd>` +
        `<dt>${escapeHtml(t(L, "integrity.found"))}</dt><dd><code>${escapeHtml(
          String(resolved.actual).slice(0, 16)
        )}…</code></dd>` +
        `</dl>`
      : "") +
    `</div></div>`
  );
}

function renderStepFindings(findings, L) {
  if (!findings.length) return "";
  const items = findings
    .map(
      (f) =>
        `<li class="finding sev-${escapeHtml(f.severity)} st-${escapeHtml(
          f.status ?? "open"
        )}" data-finding="${escapeHtml(f.id)}">` +
        `<span class="sev">${escapeHtml(f.severity)}</span> ${line(f.text, L)}` +
        `</li>`
    )
    .join("");
  return `<div class="step-findings"><h5>${escapeHtml(t(L, "step.findings"))}</h5><ul>${items}</ul></div>`;
}

/** Direction only — never a diagram. An arrow and an optional caption. */
function renderConnectors(step) {
  const links = step.next;
  if (!Array.isArray(links) || links.length === 0) {
    return `<div class="connector implicit" aria-hidden="true"><span class="arrow">↓</span></div>`;
  }
  return links
    .map(
      (l) =>
        `<div class="connector" data-to="${escapeHtml(l.to)}">` +
        `<span class="arrow">↓</span>` +
        (l.label ? `<span class="edge-label">${escapeHtml(l.label)}</span>` : "") +
        `</div>`
    )
    .join("");
}

// ---------------------------------------------------------------- flow page

/**
 * The logic/code view toggle, on every flow page.
 *
 * Same two-segment shape as the language control, because it answers the same
 * question — "which one am I in, and what does the other button give me?" — but it
 * lives in the page, not the topbar: the choice is about THIS flow's presentation,
 * and a topbar control claims to govern the whole application. The links go through
 * a cookie-setting route rather than straight to the pages so the choice survives:
 * the next flow the reader opens comes up in the view they left.
 */
function viewSwitch(flowId, active, L) {
  const seg = (mode, label, why) =>
    mode === active
      ? `<span class="viewopt is-active" aria-current="true">${escapeHtml(label)}</span>`
      : `<a class="viewopt" href="/flow/${encodeURIComponent(flowId)}/view/${mode}" title="${escapeHtml(why)}">${escapeHtml(label)}</a>`;
  return (
    `<div class="viewswitch" role="group" aria-label="${escapeHtml(t(L, "view.landmark"))}">` +
    seg("logic", t(L, "view.logic"), t(L, "view.logic.why")) +
    seg("code", t(L, "view.code"), t(L, "view.code.why")) +
    `</div>`
  );
}

export function renderFlowState(
  flow,
  { stateIndex = 0, samples = new Map(), findings = [], project = null, proseLang = null, lang = DEFAULT_LANG } = {}
) {
  const L = normaliseLang(lang);
  const states = flow.states ?? [];
  const idx = Math.max(0, Math.min(stateIndex, states.length - 1));
  const state = states[idx];
  const flowFindings = findings.filter((f) => f.flowId === flow.flowId);

  const crumbs = states
    .map((s, i) => {
      const cls = i === idx ? "crumb is-current" : "crumb";
      return (
        `<a class="${cls}" href="/flow/${encodeURIComponent(flow.flowId)}/state/${i}">` +
        `<span class="n">${i + 1}</span>${line(s.label, L)}</a>`
      );
    })
    .join(`<span class="crumb-sep" aria-hidden="true">›</span>`);

  const stepTotal = (state?.steps ?? []).length;
  const steps = (state?.steps ?? [])
    .map((step, i) =>
      renderStep(step, samples.get(step.id), {
        flowId: flow.flowId,
        findings: flowFindings,
        lang: L,
        position: i + 1,
        total: stepTotal,
        stateId: state?.id ?? null,
      })
    )
    .join("");

  const prev = idx > 0 ? `/flow/${encodeURIComponent(flow.flowId)}/state/${idx - 1}` : null;
  const next = idx < states.length - 1 ? `/flow/${encodeURIComponent(flow.flowId)}/state/${idx + 1}` : null;

  const body =
    `<header class="flow-head">` +
    `<div class="flow-title"><h1>${line(flow.title, L)}</h1>${sourceBadge(flow.source, L)}` +
    flowTrustBadge(flow, L) +
    (flow.anchoredAt?.dirty
      ? `<span class="badge b-dirty" title="${escapeHtml(t(L, "badge.uncommitted.why"))}">${escapeHtml(
          t(L, "badge.uncommitted")
        )}</span>`
      : "") +
    `</div>` +
    (flow.summary ? `<div class="flow-summary">${prose(flow.summary, L)}</div>` : "") +
    renderProvenance(flow, L) +
    `</header>` +
    `<div class="viewbar">${viewSwitch(flow.flowId, "code", L)}</div>` +
    `<nav class="breadcrumb" aria-label="${escapeHtml(t(L, "flow.states"))}">${crumbs}</nav>` +
    `<section class="state" aria-labelledby="state-title">` +
    `<h2 class="state-title" id="state-title"><span class="n">${idx + 1}/${states.length}</span> ${line(
      state?.label,
      L
    )}</h2>` +
    (state?.description ? `<div class="state-desc">${prose(state.description, L)}</div>` : "") +
    steps +
    `</section>` +
    `<nav class="statenav" aria-label="${escapeHtml(t(L, "flow.states"))}">` +
    (prev ? `<a class="prev" href="${prev}">${escapeHtml(t(L, "flow.prev"))}</a>` : `<span></span>`) +
    (next ? `<a class="next" href="${next}">${escapeHtml(t(L, "flow.next"))}</a>` : `<span></span>`) +
    `</nav>` +
    renderFlowButtons(flow, L);

  return layout({
    title: pickText(flow.title, L),
    project,
    body,
    activeNav: "/",
    extraClass: "page-flow",
    lang: L, proseLang,
    machine: machineIndex(flow, { stateIndex: idx }),
  });
}

function renderProvenance(flow, L) {
  const p = flow.provenance ?? {};
  const bits = [];
  if (p.testFile)
    bits.push(`test <code>${escapeHtml(p.testFile)}</code>${p.testTitle ? ` — “${escapeHtml(p.testTitle)}”` : ""}`);
  if (p.drillbookPage)
    bits.push(
      `drillbook <code>${escapeHtml(p.drillbookPage)}${p.drillbookStep ? `#${escapeHtml(p.drillbookStep)}` : ""}</code>`
    );
  if (p.commitSha) bits.push(`commit <code>${escapeHtml(p.commitSha.slice(0, 8))}</code>`);
  if (p.uiPath) bits.push(`route <code>${escapeHtml(p.uiPath)}</code>`);
  if (flow.anchoredAt?.sha) bits.push(`<code>${escapeHtml(flow.anchoredAt.sha.slice(0, 8))}</code>`);
  if (!bits.length) return "";
  return `<p class="provenance">${bits.join(" · ")}</p>`;
}

/**
 * The prompt-button pattern: the viewer is the control surface, and each button
 * asks this fitting's own server to compose a prompt and dispatch it. Buttons
 * post same-origin because kanban and the gateway both refuse cross-origin
 * mutations; the server relays.
 */
function renderFlowButtons(flow, L) {
  return (
    `<section class="actions" data-flow="${escapeHtml(flow.flowId)}">` +
    `<h3>${escapeHtml(t(L, "flow.act"))}</h3>` +
    `<div class="buttons">` +
    button("update", t(L, "btn.update"), t(L, "btn.update.why")) +
    button("generate-tests", t(L, "btn.generateTests"), t(L, "btn.generateTests.why")) +
    button("compare", t(L, "btn.compare"), t(L, "btn.compare.why")) +
    `</div>` +
    `<p class="hint">${escapeHtml(t(L, "flow.hint"))}</p>` +
    `<div class="dispatch-result" role="status" aria-live="polite"></div>` +
    `</section>`
  );
}

/**
 * What an empty viewer says.
 *
 * Before this, a project with no flows rendered one grey sentence telling the reader
 * to "run the skill" — which is the one thing this fitting exists to spare them. The
 * first screen is also the only place to be honest about the deal: the first run costs
 * real tokens and asks questions, and everything after it is cheap. Saying that here
 * beats a button that quietly spends money.
 */
function firstRunPanel(L) {
  const steps = ["index.first.step1", "index.first.step2", "index.first.step3"]
    .map((key) => `<li>${escapeHtml(t(L, key))}</li>`)
    .join("");
  return (
    `<section class="first-run">` +
    `<h2>${escapeHtml(t(L, "index.first.title"))}</h2>` +
    `<p>${escapeHtml(t(L, "index.first.body"))}</p>` +
    `<ol class="first-run-steps">${steps}</ol>` +
    `<div class="buttons">${button("full-run", t(L, "btn.analyse"), t(L, "btn.analyse.why"))}</div>` +
    `<p class="hint">${escapeHtml(t(L, "index.first.cost"))}</p>` +
    `<div class="dispatch-result" role="status" aria-live="polite"></div>` +
    `</section>`
  );
}

/**
 * The project picker.
 *
 * Plain forms, no JavaScript. This is the one screen a reader reaches when something
 * is already wrong — the viewer is showing the wrong repository, or an empty one —
 * and a control that needs a working fetch to recover is the wrong control for that
 * moment. Every row states what it is instead of implying it: how many flows are
 * there, whether the directory is still a repository at all, which one the
 * composition configured. A picker that only showed names would make an unanalysed
 * project and a broken path look identical.
 */
export function renderProjects(rows, { project = null, lang = DEFAULT_LANG, notice = null } = {}) {
  const L = normaliseLang(lang);

  const list = rows
    .map((row) => {
      const state = !row.isRepo
        ? `<span class="proj-state is-bad">${escapeHtml(t(L, "projects.state.notRepo"))}</span>`
        : row.flows > 0
          ? `<span class="proj-state">${escapeHtml(
              t(L, row.flows === 1 ? "projects.state.flow" : "projects.state.flows").replace(
                "{n}",
                String(row.flows)
              )
            )}</span>`
          : `<span class="proj-state is-empty">${escapeHtml(t(L, "projects.state.unanalysed"))}</span>`;

      const tags =
        (row.isDefault ? `<span class="proj-tag">${escapeHtml(t(L, "projects.tag.default"))}</span>` : "") +
        (row.isCurrent ? `<span class="proj-tag is-current">${escapeHtml(t(L, "projects.tag.current"))}</span>` : "");

      const open = row.isCurrent
        ? ""
        : `<a class="pv-btn" href="/project/${escapeHtml(row.key)}">${escapeHtml(t(L, "projects.open"))}</a>`;

      const forget = row.isDefault
        ? ""
        : `<form method="post" action="/projects/remove" class="proj-forget">` +
          `<input type="hidden" name="key" value="${escapeHtml(row.key)}">` +
          `<button type="submit" class="pv-btn is-quiet" title="${escapeHtml(
            t(L, "projects.forget.why")
          )}">${escapeHtml(t(L, "projects.forget"))}</button></form>`;

      return (
        `<li class="proj-row${row.isCurrent ? " is-current" : ""}">` +
        `<div class="proj-id"><span class="proj-name">${escapeHtml(row.label)}</span>${tags}` +
        `<code class="proj-path">${escapeHtml(row.path)}</code></div>` +
        `<div class="proj-meta">${state}</div>` +
        `<div class="proj-actions">${open}${forget}</div>` +
        `</li>`
      );
    })
    .join("");

  const body =
    `<header class="page-head">` +
    `<h1>${escapeHtml(t(L, "projects.title"))}</h1>` +
    `<p class="lede">${escapeHtml(t(L, "projects.lede"))}</p>` +
    `</header>` +
    (notice
      ? `<p class="proj-notice" role="alert">${escapeHtml(t(L, `projects.error.${notice}`))}</p>`
      : "") +
    `<ul class="proj-list">${list}</ul>` +
    `<section class="proj-add">` +
    `<h2>${escapeHtml(t(L, "projects.add.title"))}</h2>` +
    `<p>${escapeHtml(t(L, "projects.add.body"))}</p>` +
    `<form method="post" action="/projects/add">` +
    `<label class="proj-add-label" for="proj-add-path">${escapeHtml(t(L, "projects.add.label"))}</label>` +
    `<div class="proj-add-row">` +
    `<input id="proj-add-path" name="path" type="text" required spellcheck="false" autocapitalize="off" ` +
    `placeholder="${escapeHtml(t(L, "projects.add.placeholder"))}">` +
    `<button type="submit" class="pv-btn">${escapeHtml(t(L, "projects.add.submit"))}</button>` +
    `</div></form>` +
    `<p class="hint">${escapeHtml(t(L, "projects.add.hint"))}</p>` +
    `</section>`;

  return layout({
    title: t(L, "projects.title"),
    project,
    body,
    activeNav: "/projects",
    extraClass: "page-projects",
    lang: L,
  });
}

function button(mode, label, title) {
  return (
    `<button type="button" class="pv-btn" data-mode="${escapeHtml(mode)}" title="${escapeHtml(title)}">` +
    `${escapeHtml(label)}</button>`
  );
}

// ---------------------------------------------------------------- flow outline

/**
 * The flow's landing view: every state and every step, on one page.
 *
 * The brief asks for exactly this — "from the flow's landing view, you can jump
 * directly to any state or step through them one by one" — and the breadcrumb only
 * delivered half of it. Without an outline, a flow's total shape is invisible: you
 * cannot see how many steps it has, how they are distributed, or which are folded
 * without clicking through every state. That matters for a reader deciding whether
 * to read it, and it matters for judging whether a flow is too detailed or too
 * thin. It is also the cheapest page for an agent: one request, the whole map.
 */
export function renderFlowOutline(flow, { project = null, findings = [], proseLang = null, lang = DEFAULT_LANG } = {}) {
  const L = normaliseLang(lang);
  const states = flow.states ?? [];
  const flowFindings = findings.filter((f) => f.flowId === flow.flowId);
  const stepTotal = states.reduce((n, s) => n + (s.steps?.length ?? 0), 0);

  let running = 0;
  const stateBlocks = states
    .map((state, i) => {
      const steps = state.steps ?? [];
      const rows = steps
        .map((step) => {
          running += 1;
          const kind = step.kind ?? "code";
          const collapsed = step.collapsed === true || kind === "glue";
          const narrated = pickText(step.description, L).trim().length > 0;
          const file = step.sample?.file ?? step.diffSample?.file ?? "";
          const lines =
            step.sample?.startLine != null ? `${step.sample.startLine}–${step.sample.endLine}` : "";
          const stepFindings = flowFindings.filter((f) => f.stepId === step.id).length;
          return (
            `<li class="o-step k-${escapeHtml(kind)}"` +
            ` data-step="${escapeHtml(step.id)}" data-kind="${escapeHtml(kind)}"` +
            ` data-file="${escapeHtml(file)}"` +
            (step.sample?.startLine != null ? ` data-start-line="${step.sample.startLine}"` : "") +
            ` data-collapsed="${collapsed ? "true" : "false"}"` +
            ` data-narrated="${narrated ? "true" : "false"}">` +
            `<span class="o-n">${running}</span>` +
            `<span class="kind k-${escapeHtml(kind)}">${escapeHtml(kindLabel(kind, L))}</span>` +
            `<a class="o-title" href="/flow/${encodeURIComponent(flow.flowId)}/state/${i}#${escapeHtml(
              step.id
            )}">${line(step.title, L)}</a>` +
            (file
              ? `<code class="o-file">${escapeHtml(file)}${lines ? `:${lines}` : ""}</code>`
              : `<span class="o-file o-none">—</span>`) +
            `<span class="o-flags">` +
            (collapsed ? `<span class="o-flag is-folded">${escapeHtml(t(L, "outline.folded"))}</span>` : "") +
            (narrated ? "" : `<span class="o-flag is-unnarrated">${escapeHtml(t(L, "outline.notNarrated"))}</span>`) +
            stalenessBadge(step.staleness, L) +
            (stepFindings ? `<span class="badge b-find">${stepFindings}</span>` : "") +
            `</span></li>`
          );
        })
        .join("");

      return (
        `<section class="o-state" data-state="${escapeHtml(state.id)}">` +
        `<h2 class="o-state-head">` +
        `<span class="n">${i + 1}/${states.length}</span>` +
        `<a href="/flow/${encodeURIComponent(flow.flowId)}/state/${i}" title="${escapeHtml(
          t(L, "outline.openState")
        )}">${line(state.label, L)}</a>` +
        `<span class="o-count">${escapeHtml(
          t(L, steps.length === 1 ? "outline.stateStep" : "outline.stateSteps", { n: steps.length })
        )}</span>` +
        `</h2>` +
        (state.description ? `<p class="o-state-desc">${escapeHtml(truncate(pickText(state.description, L), 180))}</p>` : "") +
        `<ol class="o-steps">${rows}</ol>` +
        `</section>`
      );
    })
    .join("");

  const body =
    `<header class="flow-head">` +
    `<div class="flow-title"><h1>${line(flow.title, L)}</h1>${sourceBadge(flow.source, L)}` +
    flowTrustBadge(flow, L) +
    `</div>` +
    (flow.summary ? `<div class="flow-summary">${prose(flow.summary, L)}</div>` : "") +
    renderProvenance(flow, L) +
    `</header>` +
    `<div class="viewbar">${viewSwitch(flow.flowId, "code", L)}</div>` +
    `<div class="o-bar">` +
    `<span class="o-total">${escapeHtml(
      t(L, "outline.total", { states: states.length, steps: stepTotal })
    )}</span>` +
    `<a class="pv-link" href="/flow/${encodeURIComponent(flow.flowId)}/state/0">${escapeHtml(
      t(L, "outline.start")
    )} →</a>` +
    `</div>` +
    `<p class="lede">${escapeHtml(t(L, "outline.lede"))}</p>` +
    stateBlocks;

  return layout({
    title: pickText(flow.title, L),
    project,
    body,
    activeNav: "/",
    extraClass: "page-outline",
    lang: L, proseLang,
    machine: machineIndex(flow, { stateIndex: null }),
  });
}

// ---------------------------------------------------------------- logic view

/**
 * The logic view: the whole flow as one vertical map of WHAT happens, with the
 * code left out entirely.
 *
 * This is not the outline with the file names removed. The outline is an index of
 * the code view — it answers "where do I click to read step 7". This answers a
 * different question, asked earlier: "what does this flow actually do, functionally,
 * before I care how". Each stage carries its own narration — the `logic` field,
 * authored at analysis time separately from the step descriptions, because a
 * paragraph about WHAT a stage achieves is not the same text as three paragraphs
 * about HOW its steps do it.
 *
 * The shape honours the brief's rule even though this is the "flowchart" view:
 * flows, not graphs. One column, top to bottom, arrows meaning only "then". A stage
 * without narration still shows its mechanical spine — the step titles in order —
 * and says the narration is missing rather than hiding the gap (collapse, never
 * omit, applied to prose).
 */
export function renderFlowLogic(
  flow,
  { project = null, findings = [], proseLang = null, lang = DEFAULT_LANG } = {}
) {
  const L = normaliseLang(lang);
  const states = flow.states ?? [];
  const flowFindings = findings.filter((f) => f.flowId === flow.flowId);
  const href = (i, stepId = null) =>
    `/flow/${encodeURIComponent(flow.flowId)}/state/${i}${stepId ? `#${encodeURIComponent(stepId)}` : ""}`;

  // Where a connector target lives, so a jump can say what it means instead of
  // naming an id the reader has never seen.
  const stepHome = new Map();
  states.forEach((s, i) => (s.steps ?? []).forEach((st) => stepHome.set(st.id, { state: i, title: st.title })));
  const stateHome = new Map(states.map((s, i) => [s.id, { state: i, label: s.label }]));

  const stages = states
    .map((state, i) => {
      const steps = state.steps ?? [];

      const nodes = steps
        .map((step, j) => {
          const quiet = step.collapsed === true || step.kind === "glue";
          const findCount = flowFindings.filter((f) => f.stepId === step.id).length;

          // The sequential edge label, when the author gave the hand-off a name
          // ("click the Fittings tab"). Links that leave the straight line become
          // jump chips on the node itself — a second arrow column would be a graph.
          const nextStep = steps[j + 1];
          const links = step.next ?? [];
          const seq = nextStep ? links.find((l) => l.to === nextStep.id) : null;
          const jumps = links
            .filter((l) => l !== seq)
            .map((l) => {
              const to = String(l.to ?? "");
              const target = to.startsWith("state:") ? stateHome.get(to.slice(6)) : stepHome.get(to);
              if (!target) return "";
              const text = to.startsWith("state:")
                ? pickText(target.label, L)
                : pickText(stepHome.get(to)?.title, L);
              return (
                `<a class="lg-jump" href="${href(target.state, to.startsWith("state:") ? null : to)}">` +
                `↳ ${line(l.label ?? text, L)}</a>`
              );
            })
            .join("");

          const edge =
            j < steps.length - 1
              ? `<li class="lg-edge" aria-hidden="true"><span class="arrow">↓</span>${
                  seq?.label ? `<span class="edge-label">${line(seq.label, L)}</span>` : ""
                }</li>`
              : "";

          return (
            `<li class="lg-node k-${escapeHtml(step.kind ?? "code")}${quiet ? " is-quiet" : ""}" data-step="${escapeHtml(step.id)}">` +
            `<span class="kind k-${escapeHtml(step.kind ?? "code")}">${escapeHtml(kindLabel(step.kind, L))}</span>` +
            `<a class="lg-title" href="${href(i, step.id)}">${line(step.title, L)}</a>` +
            (findCount ? `<span class="badge b-find">${findCount}</span>` : "") +
            jumps +
            `</li>` +
            edge
          );
        })
        .join("");

      return (
        `<section class="lg-stage" data-state="${escapeHtml(state.id)}">` +
        `<h2 class="lg-stage-head"><span class="n">${i + 1}</span>` +
        `<a href="${href(i)}" title="${escapeHtml(t(L, "logic.openState"))}">${line(state.label, L)}</a>` +
        `</h2>` +
        (state.logic
          ? `<div class="lg-logic">${prose(state.logic, L)}</div>`
          : `<p class="lg-not-narrated">${escapeHtml(t(L, "logic.notNarrated"))}` +
            ` <span class="why">${escapeHtml(t(L, "logic.notNarrated.why"))}</span></p>`) +
        `<ol class="lg-nodes">${nodes}</ol>` +
        `</section>` +
        (i < states.length - 1
          ? `<div class="lg-stage-link" aria-hidden="true"><span class="arrow">↓</span></div>`
          : "")
      );
    })
    .join("");

  const body =
    `<header class="flow-head">` +
    `<div class="flow-title"><h1>${line(flow.title, L)}</h1>${sourceBadge(flow.source, L)}` +
    flowTrustBadge(flow, L) +
    `</div>` +
    (flow.summary ? `<div class="flow-summary">${prose(flow.summary, L)}</div>` : "") +
    renderProvenance(flow, L) +
    `</header>` +
    `<div class="viewbar">${viewSwitch(flow.flowId, "logic", L)}</div>` +
    `<p class="lede">${escapeHtml(t(L, "logic.lede"))}</p>` +
    stages;

  return layout({
    title: pickText(flow.title, L),
    project,
    body,
    activeNav: "/",
    extraClass: "page-logic",
    lang: L, proseLang,
    machine: machineIndex(flow, { stateIndex: null }),
  });
}

// ---------------------------------------------------------------- index

export function renderIndex(
  flows,
  { project = null, findings = [], head = null, lastRefresh = null, proseLang = null, lang = DEFAULT_LANG } = {}
) {
  const L = normaliseLang(lang);
  const groups = ["drillbook", "e2e", "ui", "commit"];

  const sections = groups
    .map((source) => {
      const items = flows.filter((f) => f.source === source);
      if (!items.length) return "";
      return (
        `<section class="flow-group">` +
        `<h2>${escapeHtml(t(L, `index.group.${source}`))}<span class="count">${items.length}</span></h2>` +
        `<p class="blurb">${escapeHtml(t(L, `index.group.${source}.why`))}</p>` +
        `<ul class="flow-list">` +
        items.map((f) => flowCard(f, findings, L)).join("") +
        `</ul></section>`
      );
    })
    .join("");

  const open = findings.filter((f) => (f.status ?? "open") === "open");
  const summary =
    `<section class="summary">` +
    `<dl>` +
    `<div><dt>${escapeHtml(t(L, "index.stat.flows"))}</dt><dd>${flows.length}</dd></div>` +
    `<div><dt>${escapeHtml(t(L, "index.stat.openFindings"))}</dt><dd><a href="/findings">${
      open.length
    }</a></dd></div>` +
    `<div><dt>${escapeHtml(t(L, "index.stat.verified"))}</dt><dd>${countVerified(flows)}</dd></div>` +
    `<div><dt>${escapeHtml(t(L, "index.stat.staleSteps"))}</dt><dd>${countStale(flows)}</dd></div>` +
    (head
      ? `<div><dt>${escapeHtml(t(L, "index.stat.head"))}</dt><dd><code>${escapeHtml(
          head.slice(0, 8)
        )}</code></dd></div>`
      : "") +
    (lastRefresh?.sha
      ? `<div><dt>${escapeHtml(t(L, "index.stat.lastRefresh"))}</dt><dd><code>${escapeHtml(
          lastRefresh.sha.slice(0, 8)
        )}</code></dd></div>`
      : "") +
    `</dl></section>`;

  const body =
    `<header class="page-head">` +
    `<h1>${escapeHtml(t(L, "index.title"))}</h1>` +
    `<p class="lede">${escapeHtml(t(L, "index.lede"))}</p>` +
    `</header>` +
    summary +
    (sections || firstRunPanel(L));

  return layout({ title: t(L, "index.title"), project, body, activeNav: "/", extraClass: "page-index", lang: L, proseLang });
}

function flowCard(flow, findings, L) {
  const n = (flow.states ?? []).reduce((acc, s) => acc + (s.steps?.length ?? 0), 0);
  const open = findings.filter((f) => f.flowId === flow.flowId && (f.status ?? "open") === "open").length;
  const stale = (flow.states ?? []).some((s) => (s.steps ?? []).some((t2) => t2.staleness?.status === "stale"));
  // Links to the outline, not to state 0: a reader arriving from the index wants to
  // see what the flow contains before committing to walking through it.
  return (
    `<li class="flow-card${flow.broken ? " is-broken" : ""}">` +
    `<a href="/flow/${encodeURIComponent(flow.flowId)}"><span class="ft">${line(flow.title, L)}</span></a>` +
    (flow.broken
      ? `<span class="badge b-invalidated" title="${escapeHtml(flow.broken)}">${escapeHtml(
          t(L, "badge.unreadable")
        )}</span>`
      : `${sourceBadge(flow.source, L)}` +
        `<span class="meta">${escapeHtml(
          t(L, "index.card.meta", { states: flow.states?.length ?? 0, steps: n })
        )}</span>` +
        (stale ? `<span class="badge b-stale">${escapeHtml(t(L, "badge.hasStale"))}</span>` : "") +
        (open ? `<span class="badge b-find">${escapeHtml(t(L, "badge.open", { n: open }))}</span>` : "")) +
    (flow.summary ? `<p class="fs">${escapeHtml(truncate(pickText(flow.summary, L), 180))}</p>` : "") +
    `</li>`
  );
}

function countVerified(flows) {
  let n = 0;
  for (const f of flows) {
    for (const s of f.states ?? []) {
      for (const step of s.steps ?? []) {
        if ((step.staleness?.status ?? "fresh") === "fresh") n += 1;
      }
    }
  }
  return n;
}

function countStale(flows) {
  let n = 0;
  for (const f of flows) {
    for (const s of f.states ?? []) {
      for (const step of s.steps ?? []) {
        if (step.staleness?.status === "stale" || step.staleness?.status === "invalidated") n += 1;
      }
    }
  }
  return n;
}

// ---------------------------------------------------------------- findings

export function renderFindings(findings, { project = null, flows = [], proseLang = null, lang = DEFAULT_LANG } = {}) {
  const L = normaliseLang(lang);
  const titleOf = (id) => pickText(flows.find((f) => f.flowId === id)?.title, L) || id;
  const order = { high: 0, medium: 1, low: 2, info: 3 };
  const sorted = [...findings].sort(
    (a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9) || String(a.id).localeCompare(String(b.id))
  );

  const rows = sorted
    .map((f) => {
      const span = f.span?.file
        ? `<a href="/files/${encodeURI(f.span.file)}"><code>${escapeHtml(f.span.file)}${
            f.span.startLine ? `:${f.span.startLine}` : ""
          }</code></a>`
        : "";
      return (
        `<tr class="f-row sev-${escapeHtml(f.severity)} st-${escapeHtml(
          f.status ?? "open"
        )}" data-finding="${escapeHtml(f.id)}">` +
        `<td><input type="checkbox" class="f-pick" value="${escapeHtml(f.id)}" aria-label="${escapeHtml(
          t(L, "findings.pick")
        )}"></td>` +
        `<td><span class="sev">${escapeHtml(f.severity)}</span></td>` +
        `<td>${escapeHtml(f.category ?? "")}</td>` +
        `<td class="f-text">${line(f.text, L)}` +
        (f.suggestion ? `<div class="f-sug">${line(f.suggestion, L)}</div>` : "") +
        `</td>` +
        `<td><a href="/flow/${encodeURIComponent(f.flowId)}/state/0">${escapeHtml(
          truncate(titleOf(f.flowId), 40)
        )}</a></td>` +
        `<td>${span}</td>` +
        `<td>${f.evidence ? `<span class="ev ev-${escapeHtml(f.evidence)}">${escapeHtml(f.evidence)}</span>` : ""}</td>` +
        `<td class="f-status"><span class="st">${escapeHtml(f.status ?? "open")}</span></td>` +
        `<td class="f-act">` +
        `<button type="button" class="f-set" data-status="dismissed" data-id="${escapeHtml(f.id)}">${escapeHtml(
          t(L, "findings.dismiss")
        )}</button>` +
        `<button type="button" class="f-set" data-status="accepted" data-id="${escapeHtml(f.id)}">${escapeHtml(
          t(L, "findings.accept")
        )}</button>` +
        `</td></tr>`
      );
    })
    .join("");

  const cols = ["sev", "kind", "finding", "flow", "span", "evidence", "status"]
    .map((k) => `<th>${escapeHtml(t(L, `findings.col.${k}`))}</th>`)
    .join("");

  const body =
    `<h1>${escapeHtml(t(L, "findings.title"))}</h1>` +
    `<p class="lede">${escapeHtml(t(L, "findings.lede"))}</p>` +
    (rows
      ? `<div class="table-wrap"><table class="findings"><thead><tr><th></th>${cols}<th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="empty">${escapeHtml(t(L, "findings.empty"))}</p>`) +
    // After the table, per the fitting-wide rule — and here the order is also the
    // workflow: you tick findings AS you read down the list, and the button that
    // acts on the ticks is waiting where you finish, not back where you started.
    `<section class="actions" id="findings-actions">` +
    `<div class="buttons">` +
    `<button type="button" class="pv-btn" data-mode="fix-selected">${escapeHtml(t(L, "btn.fixSelected"))}</button>` +
    `<button type="button" class="pv-btn" data-mode="fix-all">${escapeHtml(t(L, "btn.fixAll"))}</button>` +
    `<button type="button" class="pv-btn" data-mode="compare">${escapeHtml(t(L, "btn.recompare"))}</button>` +
    `</div><div class="dispatch-result" role="status" aria-live="polite"></div></section>`;

  return layout({
    title: t(L, "findings.title"),
    project,
    body,
    activeNav: "/findings",
    extraClass: "page-findings",
    lang: L, proseLang,
  });
}

// ---------------------------------------------------------------- files

export function renderFileToFlows(fileIndex, { project = null, flows = [], lang = DEFAULT_LANG } = {}) {
  const L = normaliseLang(lang);
  const titleOf = (id) => pickText(flows.find((f) => f.flowId === id)?.title, L) || id;
  const files = Object.keys(fileIndex).sort();
  const rows = files
    .map((file) => {
      const links = fileIndex[file]
        .map(
          (e) =>
            `<a href="/flow/${encodeURIComponent(e.flowId)}/state/0">${escapeHtml(
              truncate(titleOf(e.flowId), 44)
            )}</a>` +
            `<span class="stepn">${escapeHtml(
              t(L, e.stepIds.length === 1 ? "files.step" : "files.steps", { n: e.stepIds.length })
            )}</span>`
        )
        .join("");
      return (
        `<tr data-file="${escapeHtml(file)}">` +
        `<td><a href="/files/${encodeURI(file)}"><code>${escapeHtml(file)}</code></a></td>` +
        `<td class="flow-links">${links}</td>` +
        `</tr>`
      );
    })
    .join("");

  const body =
    `<h1>${escapeHtml(t(L, "files.title"))}</h1>` +
    `<p class="lede">${escapeHtml(t(L, "files.lede"))}</p>` +
    (rows
      ? `<div class="table-wrap"><table class="files"><thead><tr><th>${escapeHtml(t(L, "files.col.file"))}</th>` +
        `<th>${escapeHtml(t(L, "files.col.flows"))}</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="empty">${escapeHtml(t(L, "files.empty"))}</p>`);

  return layout({ title: t(L, "files.title"), project, body, activeNav: "/files", extraClass: "page-files", lang: L });
}

export function renderFileDetail(file, entries, { project = null, flows = [], lang = DEFAULT_LANG } = {}) {
  const L = normaliseLang(lang);
  const titleOf = (id) => pickText(flows.find((f) => f.flowId === id)?.title, L) || id;
  const list = entries.length
    ? `<ul class="flow-list">` +
      entries
        .map(
          (e) =>
            `<li class="flow-card"><a href="/flow/${encodeURIComponent(e.flowId)}/state/0">` +
            `<span class="ft">${escapeHtml(titleOf(e.flowId))}</span></a>` +
            `<span class="meta">${escapeHtml(t(L, "file.steps", { list: e.stepIds.join(", ") }))}</span></li>`
        )
        .join("") +
      `</ul>`
    : `<p class="empty">${escapeHtml(t(L, "file.empty"))}</p>`;

  const body = `<h1><code>${escapeHtml(file)}</code></h1><p class="lede">${escapeHtml(
    t(L, "file.lede")
  )}</p>${list}`;
  return layout({ title: file, project, body, activeNav: "/files", extraClass: "page-file", lang: L });
}

// ---------------------------------------------------------------- uncommitted

export function renderUncommitted(
  entries,
  { project = null, flows = [], patches = [], lang = DEFAULT_LANG } = {}
) {
  const L = normaliseLang(lang);
  const titleOf = (id) => pickText(flows.find((f) => f.flowId === id)?.title, L) || id;
  const rows = entries
    .map((e) => {
      const links = e.flows.length
        ? e.flows
            .map(
              (f) =>
                `<a href="/flow/${encodeURIComponent(f.flowId)}/state/0">${escapeHtml(
                  truncate(titleOf(f.flowId), 40)
                )}</a>`
            )
            .join(", ")
        : `<span class="muted">${escapeHtml(t(L, "unc.noFlow"))}</span>`;
      return (
        `<tr data-file="${escapeHtml(e.file)}" class="${e.flows.length ? "" : "unmapped"}">` +
        `<td><span class="gs gs-${escapeHtml(e.status)}">${escapeHtml(e.status)}</span></td>` +
        `<td><code>${escapeHtml(e.file)}</code></td>` +
        `<td>${links}</td></tr>`
      );
    })
    .join("");

  const diffs = patches
    .map((p) => renderFilePatch(p.patch, { file: p.file, status: p.status, emptyLabel: t(L, "diff.noChanges") }))
    .join("");

  const body =
    `<h1>${escapeHtml(t(L, "unc.title"))}</h1>` +
    `<p class="lede">${escapeHtml(t(L, "unc.lede"))}</p>` +
    (rows
      ? `<div class="table-wrap"><table class="uncommitted"><thead><tr><th>${escapeHtml(t(L, "unc.col.status"))}</th>` +
        `<th>${escapeHtml(t(L, "unc.col.file"))}</th><th>${escapeHtml(
          t(L, "unc.col.flows")
        )}</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="empty">${escapeHtml(t(L, "unc.empty"))}</p>`) +
    (diffs ? `<section class="diffs"><h2>${escapeHtml(t(L, "unc.diff"))}</h2>${diffs}</section>` : "") +
    (rows
      ? `<section class="actions"><div class="buttons">` +
        `<button type="button" class="pv-btn" data-mode="update">${escapeHtml(
          t(L, "btn.updateFromChanges")
        )}</button>` +
        // The same narration a commit gets, before the commit exists: mode
        // walkthrough with no sha means the working tree. Update refreshes flows
        // the change TOUCHED; this narrates the change ITSELF as a flow.
        `<button type="button" class="pv-btn" data-mode="walkthrough" title="${escapeHtml(
          t(L, "btn.narrateUncommitted.why")
        )}">${escapeHtml(t(L, "btn.narrateUncommitted"))}</button>` +
        `</div><div class="dispatch-result" role="status" aria-live="polite"></div></section>`
      : "");

  return layout({
    title: t(L, "unc.title"),
    project,
    body,
    activeNav: "/uncommitted",
    extraClass: "page-uncommitted",
    lang: L,
  });
}

// ---------------------------------------------------------------- commits

export function renderCommitList(commits, { project = null, flows = [], lang = DEFAULT_LANG } = {}) {
  const L = normaliseLang(lang);
  const rows = commits
    .map((c) => {
      const flow = flows.find((f) => f.source === "commit" && f.provenance?.commitSha === c.sha);
      return (
        `<tr>` +
        `<td><code>${escapeHtml(c.shortSha)}</code></td>` +
        `<td>${escapeHtml(c.subject)}</td>` +
        `<td class="muted">${escapeHtml((c.committedAt ?? "").slice(0, 10))}</td>` +
        `<td>` +
        (flow
          ? `<a href="/flow/${encodeURIComponent(flow.flowId)}/state/0">${escapeHtml(
              t(L, "commits.walkthrough")
            )}</a>`
          : `<a href="/commit/${encodeURIComponent(c.sha)}">${escapeHtml(t(L, "commits.rawDiff"))}</a>`) +
        `</td></tr>`
      );
    })
    .join("");

  const body =
    `<h1>${escapeHtml(t(L, "commits.title"))}</h1>` +
    `<p class="lede">${escapeHtml(t(L, "commits.lede"))}</p>` +
    `<div class="table-wrap"><table class="commits"><thead><tr><th>${escapeHtml(t(L, "commits.col.sha"))}</th>` +
    `<th>${escapeHtml(t(L, "commits.col.subject"))}</th><th>${escapeHtml(
      t(L, "commits.col.date")
    )}</th><th></th></tr></thead>` +
    `<tbody>${rows}</tbody></table></div>`;

  return layout({
    title: t(L, "commits.title"),
    project,
    body,
    activeNav: "/commits",
    extraClass: "page-commits",
    lang: L,
  });
}

export function renderCommitDiff(meta, patches, { project = null, lang = DEFAULT_LANG } = {}) {
  const L = normaliseLang(lang);
  const files = patches
    .map((p) => renderFilePatch(p.patch, { file: p.file, status: p.status, emptyLabel: t(L, "diff.noChanges") }))
    .join("");
  const title = t(L, "commit.title", { sha: meta.shortSha ?? "" });
  const body =
    `<h1>${escapeHtml(title)}</h1>` +
    `<p class="commit-subject">${escapeHtml(meta.subject ?? "")}</p>` +
    `<p class="provenance">${escapeHtml(meta.author ?? "")} · ${escapeHtml(
      (meta.committedAt ?? "").slice(0, 10)
    )}</p>` +
    (meta.body ? `<div class="commit-body">${prose(meta.body, L)}</div>` : "") +
    `<section class="diffs">${files}</section>` +
    // Actions close the page, after the diff they act on — the fitting-wide rule.
    // Narrating a commit is a verdict on what you just read, and every other
    // content page (flow states, uncommitted, the compare report) already ends
    // this way; this page opening with the button was the inconsistency.
    `<section class="actions"><div class="buttons">` +
    `<button type="button" class="pv-btn" data-mode="walkthrough" data-sha="${escapeHtml(
      meta.sha ?? ""
    )}">${escapeHtml(t(L, "btn.narrate"))}</button>` +
    `</div><div class="dispatch-result" role="status" aria-live="polite"></div></section>`;
  return layout({ title, project, body, activeNav: "/commits", extraClass: "page-commit", lang: L });
}

// ---------------------------------------------------------------- docs

export function renderDocsIndex(docs, { project = null, lang = DEFAULT_LANG } = {}) {
  const L = normaliseLang(lang);
  const items = docs
    .map(
      (d) =>
        `<li><a href="/docs/${encodeURIComponent(d.docId)}">${line(d.title, L)}</a>` +
        (d.originalPath ? `<code class="orig">${escapeHtml(d.originalPath)}</code>` : "") +
        (d.summary ? `<p class="fs">${escapeHtml(truncate(pickText(d.summary, L), 160))}</p>` : "") +
        `</li>`
    )
    .join("");
  const body =
    `<h1>${escapeHtml(t(L, "docs.title"))}</h1>` +
    `<p class="lede">${escapeHtml(t(L, "docs.lede"))}</p>` +
    (items ? `<ul class="docs-list">${items}</ul>` : `<p class="empty">${escapeHtml(t(L, "docs.empty"))}</p>`);
  return layout({ title: t(L, "docs.title"), project, body, activeNav: "/docs", extraClass: "page-docs", lang: L });
}

export function renderDoc(doc, text, { project = null, lang = DEFAULT_LANG } = {}) {
  const L = normaliseLang(lang);
  const body =
    `<h1>${line(doc.title, L)}</h1>` +
    (doc.originalPath
      ? `<p class="provenance">${escapeHtml(t(L, "docs.from"))} <code>${escapeHtml(doc.originalPath)}</code></p>`
      : "") +
    `<pre class="doc-body">${escapeHtml(text ?? "")}</pre>`;
  return layout({
    title: pickText(doc.title, L),
    project,
    body,
    activeNav: "/docs",
    extraClass: "page-doc",
    lang: L,
  });
}

// ---------------------------------------------------------------- compare

export function renderCompare(report, { project = null, lang = DEFAULT_LANG } = {}) {
  const L = normaliseLang(lang);
  if (!report) {
    const body =
      `<h1>${escapeHtml(t(L, "compare.title"))}</h1>` +
      `<p class="lede">${escapeHtml(t(L, "compare.lede"))}</p>` +
      `<section class="actions"><div class="buttons">` +
      `<button type="button" class="pv-btn" data-mode="compare">${escapeHtml(t(L, "btn.runCompare"))}</button>` +
      `</div><div class="dispatch-result" role="status" aria-live="polite"></div></section>` +
      `<p class="empty">${escapeHtml(t(L, "compare.empty"))}</p>`;
    return layout({
      title: t(L, "compare.title"),
      project,
      body,
      activeNav: "/compare",
      extraClass: "page-compare",
      lang: L,
    });
  }

  const group = (key, headingKey) => {
    const items = report[key] ?? [];
    if (!items.length) return "";
    return (
      `<section class="cmp-group"><h2>${escapeHtml(t(L, headingKey))} <span class="n">${items.length}</span></h2>` +
      `<p class="blurb">${escapeHtml(t(L, `${headingKey}.why`))}</p><ul class="cmp-list">` +
      items
        .map(
          (i) =>
            `<li><code>${escapeHtml(i.file ?? "")}${i.line ? `:${i.line}` : ""}</code> ` +
            `${escapeHtml(i.symbol ?? "")} <span class="why">${escapeHtml(i.note ?? "")}</span></li>`
        )
        .join("") +
      `</ul></section>`
    );
  };

  const body =
    `<h1>${escapeHtml(t(L, "compare.title"))}</h1>` +
    `<p class="provenance">${escapeHtml(
      t(L, "compare.ranAt", { at: report.generatedAt ?? "", sha: String(report.sha ?? "").slice(0, 8) })
    )}</p>` +
    group("deadCode", "compare.dead") +
    group("unexercised", "compare.unexercised") +
    group("inconsistencies", "compare.inconsistencies") +
    `<section class="copy-block"><h2>${escapeHtml(t(L, "compare.copyable"))}</h2>` +
    `<pre class="copyme">${escapeHtml(report.markdown ?? "")}</pre>` +
    `<button type="button" class="pv-btn" data-copy="1">${escapeHtml(t(L, "btn.copy"))}</button></section>` +
    `<section class="actions"><div class="buttons">` +
    `<button type="button" class="pv-btn" data-mode="fix-all">${escapeHtml(t(L, "btn.fixAll"))}</button>` +
    `<button type="button" class="pv-btn" data-mode="compare">${escapeHtml(t(L, "btn.rerun"))}</button>` +
    `</div><div class="dispatch-result" role="status" aria-live="polite"></div></section>`;

  return layout({
    title: t(L, "compare.title"),
    project,
    body,
    activeNav: "/compare",
    extraClass: "page-compare",
    lang: L,
  });
}

// ---------------------------------------------------------------- misc

export function renderError(status, message, { project = null, lang = DEFAULT_LANG } = {}) {
  const L = normaliseLang(lang);
  const body =
    `<h1>${status}</h1><p class="lede">${escapeHtml(message)}</p>` +
    `<p><a href="/">${escapeHtml(t(L, "error.back"))}</a></p>`;
  return layout({ title: String(status), project, body, extraClass: "page-error", lang: L });
}

function truncate(text, n) {
  const s = String(text ?? "");
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
