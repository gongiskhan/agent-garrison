// UI strings, in English and Portuguese.
//
// Two separate things are translated here, and keeping them separate is the
// whole design:
//
//  1. CHROME — nav labels, table headers, badges, button text. Static strings,
//     so having both languages costs nothing and the reader can flip at will.
//
//  2. PROSE — flow summaries, step descriptions, findings text. This is authored
//     content living in the manifest, and translating it means the model writes
//     every description twice, which doubles the one expensive part of the whole
//     product. So prose is written in ONE language, chosen at intake, and
//     `pickText` below reads it whether it was stored as a plain string or as a
//     per-language map. That way a project can opt into bilingual prose later
//     without a schema migration or a re-analysis.
//
// Pure. `t()` is a total function: an unknown key returns the key itself rather
// than throwing, because a missing label should look wrong, not take down a page.

export const LANGS = ["en", "pt"];
export const DEFAULT_LANG = "en";

/** Coerce anything into a supported language tag. Accepts "pt-BR", "PT", etc. */
export function normaliseLang(value, fallback = DEFAULT_LANG) {
  const raw = String(value ?? "").toLowerCase().trim();
  if (!raw) return fallback;
  const base = raw.split(/[-_]/)[0];
  return LANGS.includes(base) ? base : fallback;
}

/**
 * Read a prose field that may be a plain string (single-language, the norm) or a
 * per-language map (opt-in bilingual). Falls back across languages rather than
 * rendering an empty pane: showing the other language beats showing nothing.
 */
export function pickText(value, lang = DEFAULT_LANG) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return String(value);
  if (typeof value[lang] === "string" && value[lang].trim()) return value[lang];
  for (const alt of LANGS) {
    if (typeof value[alt] === "string" && value[alt].trim()) return value[alt];
  }
  return "";
}

const STRINGS = {
  en: {
    "brand": "Project Viewer",
    "skip.toContent": "Skip to content",
    "step.notNarrated": "Not yet narrated",
    "step.notNarrated.why": "This step was generated mechanically from the diff. The explanation is a separate pass that has not run yet — it is missing, not short.",
    "flow.allVerified": "all {n} steps verified at this commit",
    "flow.needsWork": "{stale} of {n} steps need re-narration",
    "step.position": "step {i} of {n}",
    "index.stat.verified": "Verified",
    "nav.landmark": "Sections",
    "code.landmark": "Code sample",
    "desc.landmark": "Explanation",

    "outline.title": "Outline",
    "outline.lede": "The whole flow at a glance. Jump straight to any state, or step through from the start.",
    "outline.start": "Step through from the start",
    "outline.openState": "Open this state",
    "outline.total": "{states} states · {steps} steps",
    "outline.folded": "folded",
    "outline.notNarrated": "not narrated",
    "outline.stateSteps": "{n} steps",
    "outline.stateStep": "{n} step",
    "nav.outline": "Outline",
    "nav.flows": "Flows",
    "nav.findings": "Findings",
    "nav.uncommitted": "Uncommitted",
    "nav.commits": "Commits",
    "nav.files": "Files",
    "nav.docs": "Docs",
    "nav.compare": "Compare",
    "lang.switch": "Português",
    "lang.title": "Read the interface in Portuguese",
    "lang.code": "EN",
    "prose.otherLang": "Descriptions in this project were written in {lang}. The interface follows your choice; the prose does not, because translating it means writing every description twice.",
    "prose.lang.en": "English",
    "prose.lang.pt": "Portuguese",
    "lang.landmark": "Interface language",
    "lang.to.en": "Read the interface in English",
    "lang.to.pt": "Read the interface in Portuguese",

    "fold.expand": "expand",
    "fold.collapse": "collapse",

    "badge.fresh": "fresh",
    "badge.stale": "stale",
    "badge.invalidated": "invalidated",
    "badge.fresh.why": "Re-extracted and hash-verified at this commit.",
    "badge.stale.why": "A commit touched this span, so the description may no longer match. Re-narration is queued.",
    "badge.invalidated.why": "The anchor could not be resolved — the file or the span is gone.",
    "badge.uncommitted": "uncommitted",
    "badge.uncommitted.why": "Samples were taken from the working tree, not a commit.",
    "badge.unreadable": "unreadable",
    "badge.hasStale": "has stale steps",
    "badge.open": "{n} open",

    "source.ui.why": "Discovered by driving the live UI (vision fallback).",
    "source.e2e.why": "Spine came from executing an end-to-end test.",
    "source.drillbook.why": "Authored in the drillbook — a flow the team marked as important.",
    "source.commit.why": "A commit walkthrough: the spine is the diff hunks.",

    "kind.code": "code",
    "kind.db": "db",
    "kind.filewrite": "filewrite",
    "kind.dep": "dep",
    "kind.glue": "glue",
    "pane.db": "Table contents",
    "pane.filewrite": "File written",
    "pane.lines": "lines {from}–{to}",
    "step.noDescription": "No description.",
    "step.noSample": "No code sample for this step.",
    "step.findings": "Findings",

    "integrity.title": "Sample integrity check failed.",
    "integrity.body": "This step is not rendered because the analysis no longer matches the repository at its anchor. Re-run the analysis in {mode} mode to re-extract it.",
    "integrity.default": "the extracted text no longer matches its recorded hash",
    "integrity.recorded": "recorded",
    "integrity.found": "found",

    "flow.states": "Flow states",
    "flow.prev": "← previous state",
    "flow.next": "next state →",
    "flow.act": "Act on this flow",
    "flow.hint": "Long work is dispatched as a kanban card, because a chat turn caps out well before an analysis finishes.",
    "btn.update": "Update analysis",
    "btn.update.why": "Re-extract this flow at HEAD and re-narrate only the steps a commit touched.",
    "btn.generateTests": "Generate tests",
    "btn.generateTests.why": "Write end-to-end tests for the steps of this flow that have no coverage.",
    "btn.compare": "Compare with runtime",
    "btn.compare.why": "Check the static reading of this flow against what actually executed.",
    "btn.fixSelected": "Fix selected",
    "btn.fixAll": "Fix all accepted",
    "btn.recompare": "Re-run analysis vs runtime",
    "btn.narrate": "Narrate this commit as a flow",
    "btn.narrateUncommitted": "Narrate these changes as a flow",
    "btn.narrateUncommitted.why":
      "The same walkthrough a commit gets, before the commit exists. The flow is anchored dirty and superseded by the real commit walkthrough once these changes land.",
    "btn.updateFromChanges": "Update analysis with these changes",
    "btn.runCompare": "Run the comparison",
    "btn.rerun": "Re-run",
    "btn.copy": "Copy",

    "index.title": "Flows",
    "index.lede": "This project explained as end-to-end journeys, not as a file tree. Every code sample is extracted from the repository at a named commit and hash-checked before it is shown.",
    "index.empty": "No flows yet. Run the garrison-project-viewer skill to analyse this project.",
    "index.first.title": "Nothing has been analysed yet",
    "index.first.body":
      "This viewer explains a project as end-to-end journeys. It has not looked at this one yet, so there is nothing to read. Starting the analysis opens a short conversation first — it needs your answers before it spends anything.",
    "index.first.step1": "It asks how deep to go, which flows you care about, and whether to consolidate the documentation.",
    "index.first.step2": "It runs your end-to-end tests and reads the drillbook to learn what actually executes, in order.",
    "index.first.step3": "It writes one flow per journey, with the real code from a named commit and a description beside it.",
    "index.first.cost":
      "The first run is the expensive one and it is paid once. Every later run only revisits the steps a commit actually touched.",
    "btn.analyse": "Analyse this project",
    "btn.analyse.why": "Opens the intake questions, then produces the flows. Long work, so it goes to a kanban card rather than a chat turn.",
    "index.group.drillbook": "From the drillbook",
    "index.group.drillbook.why": "Flows the team marked as important. On duplication with a test, the drillbook wins.",
    "index.group.e2e": "From end-to-end tests",
    "index.group.e2e.why": "Spine taken from execution, not from reading code.",
    "index.group.ui": "From the live UI",
    "index.group.ui.why": "Discovered by driving the running pages. A flow with no test is itself a finding.",
    "index.group.commit": "Commit walkthroughs",
    "index.group.commit.why": "The spine is the diff the commit introduced.",
    "index.stat.flows": "Flows",
    "index.stat.openFindings": "Open findings",
    "index.stat.staleSteps": "Stale steps",
    "index.stat.head": "HEAD",
    "index.stat.lastRefresh": "Last refresh",
    "index.card.meta": "{states} states · {steps} steps",

    "findings.title": "Findings",
    "findings.lede": "Problems noticed while building the flows, each tied to the flow and the code span it concerns. Select some and press Fix to hand them to the operative as one card.",
    "findings.empty": "No findings recorded.",
    "findings.col.sev": "sev",
    "findings.col.kind": "kind",
    "findings.col.finding": "finding",
    "findings.col.flow": "flow",
    "findings.col.span": "span",
    "findings.col.evidence": "evidence",
    "findings.col.status": "status",
    "findings.dismiss": "dismiss",
    "findings.accept": "accept",
    "findings.pick": "select finding",

    "files.title": "Files",
    "files.lede": "Every file the analysis touches and the flows it takes part in — whether a flow starts there or merely passes through. This is a file's responsibility across the project.",
    "files.empty": "No files indexed yet.",
    "files.col.file": "file",
    "files.col.flows": "flows",
    "files.steps": "{n} steps",
    "files.step": "{n} step",
    "file.lede": "Flows this file participates in.",
    "file.empty": "No flow covers this file yet. That is itself worth knowing.",
    "file.steps": "steps: {list}",

    "unc.title": "Uncommitted changes",
    "unc.lede": "What is different in the working tree right now. Click a file to read the flow the change sits in, so the change can be understood by looking rather than by reading code.",
    "unc.empty": "The working tree is clean.",
    "unc.col.status": "status",
    "unc.col.file": "file",
    "unc.col.flows": "flows",
    "unc.noFlow": "no flow covers this file",
    "unc.diff": "The diff",

    "commits.title": "Commits",
    "commits.lede": "Recent history. A commit walkthrough is a flow whose spine is the diff hunks, narrated in the same format as everything else.",
    "commits.col.sha": "sha",
    "commits.col.subject": "subject",
    "commits.col.date": "date",
    "commits.walkthrough": "walkthrough",
    "commits.rawDiff": "raw diff",
    "commit.title": "Commit {sha}",

    "docs.title": "Docs",
    "docs.lede": "The project's decisions, rules and architecture, consolidated into one small readable area for humans and agents alike.",
    "docs.empty": "No documentation has been consolidated yet.",
    "docs.from": "consolidated from",
    "docs.missing": "(the consolidated copy is missing)",

    "compare.title": "Analysis vs runtime",
    "compare.lede": "Compares what the code says statically against what was observed executing, to surface dead code and places where the same thing is done differently.",
    "compare.empty": "No comparison has been run yet.",
    "compare.ranAt": "run at {at} against {sha}",
    "compare.dead": "Dead code candidates",
    "compare.dead.why": "Exported but referenced nowhere. Candidates — verify before deleting.",
    "compare.unexercised": "Never observed running",
    "compare.unexercised.why": "Reachable statically but absent from every runtime capture.",
    "compare.inconsistencies": "Done differently in different places",
    "compare.inconsistencies.why": "The same job, solved more than one way.",
    "compare.copyable": "Copy-pasteable",

    "view.landmark": "Flow view",
    "view.logic": "Logic",
    "view.logic.why": "The whole flow as a functional map — what happens and why, no code",
    "view.code": "Code",
    "view.code.why": "The walkthrough with real code samples, state by state",
    "logic.lede":
      "What this flow does, functionally, top to bottom. Every stage links into the code view when you want the how.",
    "logic.openState": "Open this stage in the code view",
    "logic.notNarrated": "The functional narration for this stage has not been written yet.",
    "logic.notNarrated.why": "What follows is the mechanical spine — the steps in order, without the why.",

    "projects.switch.why": "Change which project this viewer is showing",
    "projects.title": "Projects",
    "projects.lede":
      "Which repository this viewer is reading. The choice is per browser, so switching here changes nothing for anyone else.",
    "projects.state.flows": "{n} flows",
    "projects.state.flow": "{n} flow",
    "projects.state.unanalysed": "Not analysed yet",
    "projects.state.notRepo": "Not a git repository",
    "projects.tag.default": "configured",
    "projects.tag.current": "showing",
    "projects.open": "Show this one",
    "projects.forget": "Forget",
    "projects.forget.why": "Removes it from this list. The repository itself is not touched.",
    "projects.add.title": "Add a project",
    "projects.add.body":
      "Any git repository on this machine. Adding one only records the path — nothing is read until you open it, and nothing is analysed until you ask.",
    "projects.add.label": "Path to the repository",
    "projects.add.placeholder": "~/dev/my-project",
    "projects.add.submit": "Add and show",
    "projects.add.hint":
      "A repository with no analysis opens on the first-run screen, where you can start one.",
    "projects.error.empty": "Type a path first.",
    "projects.error.notAbsolute": "That path is not absolute.",
    "projects.error.missing": "There is nothing at that path on this machine.",
    "projects.error.notDirectory": "That path is a file, not a directory.",
    "projects.error.notRepo":
      "That directory is not a git repository. Every code sample is anchored to a commit, so a repository is not optional.",
    "projects.error.unknown": "No such project.",
    "projects.error.isDefault": "The project configured in the composition cannot be removed.",

    "error.back": "Back to flows",
    "diff.noChanges": "No textual changes.",
  },

  pt: {
    "brand": "Project Viewer",
    "skip.toContent": "Ir para o conteúdo",
    "step.notNarrated": "Ainda não narrado",
    "step.notNarrated.why": "Este passo foi gerado mecanicamente a partir do diff. A explicação é uma passagem à parte que ainda não correu — está em falta, não está curta.",
    "flow.allVerified": "os {n} passos verificados neste commit",
    "flow.needsWork": "{stale} de {n} passos precisam de re-narração",
    "step.position": "passo {i} de {n}",
    "index.stat.verified": "Verificados",
    "nav.landmark": "Secções",
    "code.landmark": "Amostra de código",
    "desc.landmark": "Explicação",

    "outline.title": "Vista geral",
    "outline.lede": "O fluxo inteiro de uma vez. Salta directamente para qualquer estado, ou percorre desde o início.",
    "outline.start": "Percorrer desde o início",
    "outline.openState": "Abrir este estado",
    "outline.total": "{states} estados · {steps} passos",
    "outline.folded": "dobrado",
    "outline.notNarrated": "sem narração",
    "outline.stateSteps": "{n} passos",
    "outline.stateStep": "{n} passo",
    "nav.outline": "Vista geral",
    "nav.flows": "Fluxos",
    "nav.findings": "Achados",
    "nav.uncommitted": "Não commitado",
    "nav.commits": "Commits",
    "nav.files": "Ficheiros",
    "nav.docs": "Documentação",
    "nav.compare": "Comparação",
    "lang.switch": "English",
    "lang.title": "Ler a interface em inglês",
    "lang.code": "PT",
    "prose.otherLang": "As descrições deste projeto foram escritas em {lang}. A interface segue a tua escolha; a prosa não, porque traduzi-la significa escrever cada descrição duas vezes.",
    "prose.lang.en": "inglês",
    "prose.lang.pt": "português",
    "lang.landmark": "Língua da interface",
    "lang.to.en": "Ler a interface em inglês",
    "lang.to.pt": "Ler a interface em português",

    "fold.expand": "expandir",
    "fold.collapse": "recolher",

    "badge.fresh": "verificado",
    "badge.stale": "desatualizado",
    "badge.invalidated": "invalidado",
    "badge.fresh.why": "Re-extraído e verificado por hash neste commit.",
    "badge.stale.why": "Um commit alterou este trecho, portanto a descrição pode já não corresponder. A re-narração está em fila.",
    "badge.invalidated.why": "Não foi possível resolver a âncora — o ficheiro ou o trecho já não existe.",
    "badge.uncommitted": "não commitado",
    "badge.uncommitted.why": "As amostras foram lidas da working tree, não de um commit.",
    "badge.unreadable": "ilegível",
    "badge.hasStale": "tem passos desatualizados",
    "badge.open": "{n} abertos",

    "source.ui.why": "Descoberto conduzindo a interface em execução (recurso de visão).",
    "source.e2e.why": "A espinha veio da execução de um teste ponta-a-ponta.",
    "source.drillbook.why": "Escrito no drillbook — um fluxo que a equipa marcou como importante.",
    "source.commit.why": "Percurso de um commit: a espinha são os hunks do diff.",

    "kind.code": "código",
    "kind.db": "base de dados",
    "kind.filewrite": "escrita",
    "kind.dep": "dependência",
    "kind.glue": "ligação",
    "pane.db": "Conteúdo da tabela",
    "pane.filewrite": "Ficheiro escrito",
    "pane.lines": "linhas {from}–{to}",
    "step.noDescription": "Sem descrição.",
    "step.noSample": "Este passo não tem amostra de código.",
    "step.findings": "Achados",

    "integrity.title": "A verificação de integridade da amostra falhou.",
    "integrity.body": "Este passo não é renderizado porque a análise já não corresponde ao repositório na sua âncora. Corre a análise em modo {mode} para a re-extrair.",
    "integrity.default": "o texto extraído já não corresponde ao hash registado",
    "integrity.recorded": "registado",
    "integrity.found": "encontrado",

    "flow.states": "Estados do fluxo",
    "flow.prev": "← estado anterior",
    "flow.next": "estado seguinte →",
    "flow.act": "Agir sobre este fluxo",
    "flow.hint": "Trabalho longo é despachado como cartão no kanban, porque um turno de chat esgota muito antes de uma análise terminar.",
    "btn.update": "Atualizar análise",
    "btn.update.why": "Re-extrair este fluxo no HEAD e re-narrar apenas os passos que um commit alterou.",
    "btn.generateTests": "Gerar testes",
    "btn.generateTests.why": "Escrever testes ponta-a-ponta para os passos deste fluxo que não têm cobertura.",
    "btn.compare": "Comparar com o runtime",
    "btn.compare.why": "Confrontar a leitura estática deste fluxo com o que executou de facto.",
    "btn.fixSelected": "Corrigir selecionados",
    "btn.fixAll": "Corrigir todos os aceites",
    "btn.recompare": "Repetir análise vs runtime",
    "btn.narrate": "Narrar este commit como fluxo",
    "btn.narrateUncommitted": "Narrar estas alterações como fluxo",
    "btn.narrateUncommitted.why":
      "O mesmo percurso que um commit recebe, antes de o commit existir. O fluxo fica ancorado como dirty e é substituído pelo percurso do commit real quando estas alterações aterrarem.",
    "btn.updateFromChanges": "Atualizar a análise com estas alterações",
    "btn.runCompare": "Correr a comparação",
    "btn.rerun": "Repetir",
    "btn.copy": "Copiar",

    "index.title": "Fluxos",
    "index.lede": "Este projeto explicado como percursos ponta-a-ponta, não como uma árvore de ficheiros. Cada amostra de código é extraída do repositório num commit identificado e verificada por hash antes de ser mostrada.",
    "index.empty": "Ainda não há fluxos. Corre a skill garrison-project-viewer para analisar este projeto.",
    "index.first.title": "Ainda não foi analisado nada",
    "index.first.body":
      "Este navegador explica um projeto como percursos ponta-a-ponta. Ainda não olhou para este, por isso não há nada para ler. Arrancar a análise abre primeiro uma conversa curta — precisa das tuas respostas antes de gastar o que for.",
    "index.first.step1": "Pergunta que profundidade queres, que fluxos te interessam, e se deve consolidar a documentação.",
    "index.first.step2": "Corre os teus testes ponta-a-ponta e lê o drillbook para saber o que executa de facto, e em que ordem.",
    "index.first.step3": "Escreve um fluxo por percurso, com o código real de um commit identificado e uma descrição ao lado.",
    "index.first.cost":
      "A primeira corrida é a caríssima e paga-se uma vez. As seguintes só voltam aos passos que um commit mexeu mesmo.",
    "btn.analyse": "Analisar este projeto",
    "btn.analyse.why": "Abre as perguntas de intake e depois produz os fluxos. É trabalho longo, por isso vai para um cartão do kanban e não para um turno de chat.",
    "index.group.drillbook": "Do drillbook",
    "index.group.drillbook.why": "Fluxos que a equipa marcou como importantes. Em duplicação com um teste, o drillbook ganha.",
    "index.group.e2e": "Dos testes ponta-a-ponta",
    "index.group.e2e.why": "Espinha tirada da execução, não da leitura do código.",
    "index.group.ui": "Da interface em execução",
    "index.group.ui.why": "Descoberto conduzindo as páginas a correr. Um fluxo sem teste é, por si só, um achado.",
    "index.group.commit": "Percursos de commits",
    "index.group.commit.why": "A espinha é o diff que o commit introduziu.",
    "index.stat.flows": "Fluxos",
    "index.stat.openFindings": "Achados abertos",
    "index.stat.staleSteps": "Passos desatualizados",
    "index.stat.head": "HEAD",
    "index.stat.lastRefresh": "Última atualização",
    "index.card.meta": "{states} estados · {steps} passos",

    "findings.title": "Achados",
    "findings.lede": "Problemas notados ao construir os fluxos, cada um ligado ao fluxo e ao trecho de código a que diz respeito. Seleciona alguns e prime Corrigir para os entregar ao operativo num único cartão.",
    "findings.empty": "Nenhum achado registado.",
    "findings.col.sev": "sev",
    "findings.col.kind": "tipo",
    "findings.col.finding": "achado",
    "findings.col.flow": "fluxo",
    "findings.col.span": "trecho",
    "findings.col.evidence": "evidência",
    "findings.col.status": "estado",
    "findings.dismiss": "descartar",
    "findings.accept": "aceitar",
    "findings.pick": "selecionar achado",

    "files.title": "Ficheiros",
    "files.lede": "Todos os ficheiros que a análise toca e os fluxos em que participam — quer o fluxo comece ali, quer apenas passe por lá. Isto é a responsabilidade de um ficheiro ao longo do projeto.",
    "files.empty": "Ainda não há ficheiros indexados.",
    "files.col.file": "ficheiro",
    "files.col.flows": "fluxos",
    "files.steps": "{n} passos",
    "files.step": "{n} passo",
    "file.lede": "Fluxos em que este ficheiro participa.",
    "file.empty": "Nenhum fluxo cobre este ficheiro. Isso, por si só, vale saber.",
    "file.steps": "passos: {list}",

    "unc.title": "Alterações não commitadas",
    "unc.lede": "O que está diferente na working tree agora. Clica num ficheiro para ler o fluxo onde a alteração se insere, para que a alteração se entenda a olhar, e não a ler código.",
    "unc.empty": "A working tree está limpa.",
    "unc.col.status": "estado",
    "unc.col.file": "ficheiro",
    "unc.col.flows": "fluxos",
    "unc.noFlow": "nenhum fluxo cobre este ficheiro",
    "unc.diff": "O diff",

    "commits.title": "Commits",
    "commits.lede": "Histórico recente. Um percurso de commit é um fluxo cuja espinha são os hunks do diff, narrado no mesmo formato que todo o resto.",
    "commits.col.sha": "sha",
    "commits.col.subject": "assunto",
    "commits.col.date": "data",
    "commits.walkthrough": "percurso",
    "commits.rawDiff": "diff cru",
    "commit.title": "Commit {sha}",

    "docs.title": "Documentação",
    "docs.lede": "As decisões, regras e arquitetura do projeto, consolidadas numa única área pequena e legível, tanto para pessoas como para agentes.",
    "docs.empty": "Ainda não foi consolidada documentação.",
    "docs.from": "consolidado a partir de",
    "docs.missing": "(falta a cópia consolidada)",

    "compare.title": "Análise vs runtime",
    "compare.lede": "Compara o que o código diz estaticamente com o que se observou a executar, para expor código morto e sítios onde a mesma coisa é feita de formas diferentes.",
    "compare.empty": "Ainda não foi corrida nenhuma comparação.",
    "compare.ranAt": "corrida em {at} contra {sha}",
    "compare.dead": "Candidatos a código morto",
    "compare.dead.why": "Exportado mas referenciado em nenhum sítio. Candidatos — confirma antes de apagar.",
    "compare.unexercised": "Nunca observado a executar",
    "compare.unexercised.why": "Alcançável estaticamente, mas ausente de todas as capturas de runtime.",
    "compare.inconsistencies": "Feito de formas diferentes em sítios diferentes",
    "compare.inconsistencies.why": "O mesmo trabalho, resolvido de mais do que uma maneira.",
    "compare.copyable": "Pronto a copiar",

    "view.landmark": "Vista do fluxo",
    "view.logic": "Lógica",
    "view.logic.why": "O fluxo inteiro como mapa funcional — o que acontece e porquê, sem código",
    "view.code": "Código",
    "view.code.why": "O percurso com amostras de código reais, estado a estado",
    "logic.lede":
      "O que este fluxo faz, funcionalmente, de cima a baixo. Cada etapa liga à vista de código quando quiseres o como.",
    "logic.openState": "Abrir esta etapa na vista de código",
    "logic.notNarrated": "A narração funcional desta etapa ainda não foi escrita.",
    "logic.notNarrated.why": "O que se segue é a espinha mecânica — os passos por ordem, sem o porquê.",

    "projects.switch.why": "Mudar o projeto que este visualizador está a mostrar",
    "projects.title": "Projetos",
    "projects.lede":
      "Que repositório este visualizador está a ler. A escolha é por navegador, portanto mudar aqui não altera nada para mais ninguém.",
    "projects.state.flows": "{n} fluxos",
    "projects.state.flow": "{n} fluxo",
    "projects.state.unanalysed": "Ainda não analisado",
    "projects.state.notRepo": "Não é um repositório git",
    "projects.tag.default": "configurado",
    "projects.tag.current": "a mostrar",
    "projects.open": "Mostrar este",
    "projects.forget": "Esquecer",
    "projects.forget.why": "Remove-o desta lista. O repositório em si não é tocado.",
    "projects.add.title": "Adicionar um projeto",
    "projects.add.body":
      "Qualquer repositório git nesta máquina. Adicionar apenas regista o caminho — nada é lido até o abrires, e nada é analisado até pedires.",
    "projects.add.label": "Caminho para o repositório",
    "projects.add.placeholder": "~/dev/o-meu-projeto",
    "projects.add.submit": "Adicionar e mostrar",
    "projects.add.hint":
      "Um repositório sem análise abre no ecrã de primeira execução, onde podes começar uma.",
    "projects.error.empty": "Escreve um caminho primeiro.",
    "projects.error.notAbsolute": "Esse caminho não é absoluto.",
    "projects.error.missing": "Não há nada nesse caminho nesta máquina.",
    "projects.error.notDirectory": "Esse caminho é um ficheiro, não uma pasta.",
    "projects.error.notRepo":
      "Essa pasta não é um repositório git. Cada amostra de código está ancorada a um commit, portanto um repositório não é opcional.",
    "projects.error.unknown": "Esse projeto não existe.",
    "projects.error.isDefault": "O projeto configurado na composição não pode ser removido.",

    "error.back": "Voltar aos fluxos",
    "diff.noChanges": "Sem alterações textuais.",
  },
};

/**
 * Look up a chrome string. `vars` fills {placeholders}. An unknown key returns
 * the key, so a gap is visible in the page instead of crashing the render.
 */
export function t(lang, key, vars) {
  const table = STRINGS[normaliseLang(lang)] ?? STRINGS[DEFAULT_LANG];
  let out = table[key] ?? STRINGS[DEFAULT_LANG][key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      out = out.split(`{${name}}`).join(String(value));
    }
  }
  return out;
}

/** The other language, for the toggle. Two languages, so this is a flip. */
export function otherLang(lang) {
  return normaliseLang(lang) === "pt" ? "en" : "pt";
}

/** Exposed for the test suite, which asserts both tables carry the same keys. */
export function keysFor(lang) {
  return Object.keys(STRINGS[normaliseLang(lang)]).sort();
}
