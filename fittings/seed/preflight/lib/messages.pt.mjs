// Portuguese (pt-PT) diagnostics. English is authored inline at each mk() call
// in lib/preflight-core.mjs and lib/report.mjs; this is its translation, keyed
// by `<check>.<situation>` with `.fix` and `.command` siblings, so a key is
// greppable from anything on screen. `.one` / `.other` pairs are picked by
// `vars.n`.
//
// Authoring rule: a {placeholder} is always a VALUE — a fitting id, a port, a
// path, a pid, a shell command — never a word. The noun lives inside the
// sentence, so gender and number agreement is written by hand, correctly,
// and there is nothing for the code to get wrong. Identifiers, file names and
// commands stay in English inside the sentence: they are what the operator
// types, not prose.

export const MESSAGES_PT = {
  "finding.demoted": "{detail} ({reason})",
  "state.present": "presente",
  "state.missing": "em falta",

  // ── check 2 · registo na library ────────────────────────────────────────
  "library-crosscheck.unregistered": "fittings/seed/{id} não tem entrada em data/library.json — o resolver descarta-o em silêncio e culpa quem consumiu a capacidade dele.",
  "library-crosscheck.unregistered.fix": "Adiciona {\"id\": \"{id}\", \"name\": ..., \"repo\": \"local:fittings/seed/{id}\", \"localPath\": \"fittings/seed/{id}\", \"summary\": ..., \"platforms\": [\"claude-code\"]} ao data/library.json.",
  "library-crosscheck.unregistered.command": "acrescentar uma entrada mínima para {id} ao data/library.json (resumo tirado do manifesto; fica por commitar — revê e depois commita)",
  "library-crosscheck.dangling": "A entrada \"{id}\" do data/library.json aponta para {path}, que não existe em disco.",
  "library-crosscheck.dangling.fix": "Remove a entrada ou repõe {path}.",
  "library-crosscheck.dangling.command": "remover a entrada \"{id}\" do data/library.json (fica por commitar — se devia existir, repõe {path} em vez disso)",
  "library-crosscheck.ok": "{seeds} fittings no seed e {entries} entradas na library concordam nos dois sentidos.",

  // ── check 3 · portas ────────────────────────────────────────────────────
  "port-collisions.canonical": "A porta {port} é reclamada por {names} ({sources}).",
  "port-collisions.canonical.fix": "Move um dos reclamantes para uma porta base livre (8070-8075 estavam livres quando isto foi escrito); lembra-te de que a porta canónica conta também os defaults do config_schema.",
  "port-collisions.pinnedAway": "A porta {port} é declarada por {names}, mas {pinned} está fixado (pin) noutra porta em todas as composições que o estacionam, por isso hoje nada liga {port} duas vezes.",
  "port-collisions.pinnedAway.fix": "Nada a fazer enquanto esses pins existirem. Remover ou alterar o pin em {compositions} volta a tornar isto uma colisão real.",
  "port-collisions.serve": "As portas canónicas {desc} derivam ambas a porta serve {sp} (8400 + porta % 1000). O publicador NÃO falha — empurra a segunda para lá de {sp} — e o dano é esse: a mesh assume que o URL de uma view num peer se calcula como 8400 + porta % 1000 sem perguntar ao peer, por isso um mapeamento empurrado fica inacessível no endereço que os outros nós calculam.",
  "port-collisions.serve.fix": "Escolhe uma porta canónica cuja derivação serve também esteja livre, para que não seja preciso empurrar nada (scripts/tailnet-serve-views.mjs:50-57; o invariante está fixado por tests/mesh-serve-ports.test.ts).",
  "port-collisions.serveReserved": "A porta serve {sp}, derivada de {desc}, está reservada pelo próprio tailscale serve.",
  "port-collisions.serveReserved.fix": "Escolhe uma porta canónica cujo 8400 + porta % 1000 evite 8443-8445.",
  "port-collisions.livePidMismatch": "A porta {port} está ocupada pelo pid {pid} ({command}), mas o ficheiro de estado de {fittingId} regista o pid {recordedPid}.",
  "port-collisions.livePidMismatch.fix": "Vê se {fittingId} crashou e outra coisa ficou com a porta dele, ou se o ficheiro de estado está desatualizado.",
  "port-collisions.squatter": "A porta {port} é reclamada por {claimants} mas já está ocupada pelo pid {pid} ({command}), que não registou nenhum ficheiro de estado — o reclamante não a consegue ligar.",
  "port-collisions.squatter.fix": "Identifica o ocupante com `{cmd}`, depois pára-o ou move o reclamante para uma porta livre (nos dois eixos).",
  "port-collisions.ok": "{n} reclamações de porta, sem colisões em nenhum dos eixos.",
  "port-collisions.sandbox": "A porta {port} é a porta base {base} de {owner} deslocada pelo perfil {profile} (+{offset}) — a sandbox {profile} está a correr, o que é esperado e não é um conflito.",

  // ── check 1 · resultados do verify ──────────────────────────────────────
  "verify-results.label.attempt": "na última tentativa (estado do runner: {status})",
  "verify-results.label.lastUp": "no último up ({at})",
  "verify-results.noRecord": "{cid} não tem registo de verify — nem .garrison/last-up.json nem estado vivo no runner (nunca foi levantada, ou a app reiniciou entretanto).",
  "verify-results.noRecord.fix": "Corre a varredura de verify para teres uma primeira imagem completa sem tentar um up() inteiro.",
  "verify-results.noRecord.command": "correr o verify de TODOS os fittings de {cid} pelo endpoint de verify da própria app (pesado: muda o estado do runner, pode correr apm install, corre os hooks de setup)",
  "verify-results.failed": "{fittingId} falhou o verify {label}: exit {exitCode}, esperava-se \"{expect}\" de `{command}`.",
  "verify-results.failed.fix": "Corrige o verify de {fittingId} e volta a correr a varredura — ou desestaciona-o para o up() poder avançar sem ele (um fitting a falhar bloqueia a composição inteira). Ao contrário do erro do up(), que só nomeia o primeiro, esta lista é completa.",
  "verify-results.failed.command": "DESESTACIONAR {fittingId} de {cid} (pelo escritor de manifestos do Garrison) — a composição corre sem este fitting até o voltares a adicionar pelo Muster",
  "verify-results.ok": "{n} fittings verificados com sucesso {label}.",
  "verify-results.none": "Não foram encontradas composições.",
  "demote.notActive": "{cid} não é a composição ativa — nada a avaliar até ser levantada",

  // ── check 1b · varredura ao vivo ────────────────────────────────────────
  "verify-sweep.ok": "{fittingId} ok em {ms}ms.",
  "verify-sweep.failed": "{fittingId} falhou: exit {exitCode}, esperava-se \"{expect}\" de `{command}`.",
  "verify-sweep.failed.fix": "Corrige o verify de {fittingId} — ou desestaciona-o para o up() poder avançar. Esta varredura correu TODOS os fittings; nada ficou escondido atrás da primeira falha.",
  "verify-sweep.failed.command": "DESESTACIONAR {fittingId} de {cid} (pelo escritor de manifestos do Garrison) — a composição corre sem este fitting até o voltares a adicionar pelo Muster",

  // ── check 4 · cobertura do tailscale serve ──────────────────────────────
  "serve-coverage.unmapped": "{fittingId} (porta {port}) não tem mapeamento no tailscale serve — quem vê à distância recebe tailnetUrl null, a UI cai para o 127.0.0.1 de QUEM VÊ, e a view abre em branco.",
  "serve-coverage.unmapped.fix": "Corre scripts/tailnet-serve-views.mjs (ou tailnet-publish) para a mapear; porta serve esperada {servePort}.",
  "serve-coverage.unmapped.command": "publicar os mapeamentos de views em falta com o publicador suportado deste nó, scripts/tailnet-serve-views.mjs (só no perfil node)",
  "serve-coverage.unhealthy": "{fittingId} está mapeado em {url} mas a sonda /health falhou.",
  "serve-coverage.unhealthy.fix": "Vê ~/.garrison/ui-fittings/{fittingId}.log.",
  "serve-coverage.okViews": "{n} views own-port, todas mapeadas e saudáveis.",
  "serve-coverage.unmappedDegraded": "{fittingId} (porta {port}) não tem mapeamento no tailscale serve (verificado diretamente; app em baixo).",
  "serve-coverage.unmappedDegraded.fix": "Corre scripts/tailnet-serve-views.mjs; porta serve esperada {servePort}.",
  "serve-coverage.unmappedDegraded.command": "publicar os mapeamentos de views em falta com o publicador suportado deste nó, scripts/tailnet-serve-views.mjs (só no perfil node)",
  "serve-coverage.okStatus": "{n} fittings own-port a correr, todos mapeados no serve.",
  "serve-coverage.orphanMappings.one": "1 mapeamento do tailscale serve aponta para uma porta local sem nada à escuta: {list}. É um URL da tailnet alcançável que não mostra nada.",
  "serve-coverage.orphanMappings.other": "{n} mapeamentos do tailscale serve apontam para portas locais sem nada à escuta: {list}. Cada um é um URL da tailnet alcançável que não mostra nada.",
  "serve-coverage.orphanMappings.fix": "Remove os mapeamentos obsoletos com `tailscale serve --https=<portaServe> off`, ou arranca o que devia estar atrás deles. O Preflight nunca edita a tailnet.",
  "serve-coverage.tailscaleMissing": "Binário tailscale não encontrado ou `serve status --json` falhou — a cobertura do serve não pôde ser verificada, por isso as views sem mapeamento são desconhecidas, não partidas.",
  "serve-coverage.tailscaleMissing.fix": "Instala o tailscale, ou ignora este check num nó deliberadamente fora da tailnet.",

  // ── check 8 · cwd dos hooks ─────────────────────────────────────────────
  "hook-cwd.guarded": "O {name} de {id} resolve para sítios diferentes no setup e no verify, mas o script confirma para onde resolveu antes de confiar nele.",
  "hook-cwd.decisive": "{id} deriva {name} como {expr}, que EXISTE para um hook e não para o outro: o setup vê {setupPath} ({setupState}), o verify vê {verifyPath} ({verifyState}). O setup corre a partir do diretório do seed e o verify a partir do diretório da composição, por isso qualquer ramo sobre {name} toma caminhos opostos nos dois hooks.",
  "hook-cwd.decisive.fix": "Protege o ramo como o basic-memory protege o bloco da skill — testa `basename \"${name}\"` (ou equivalente) antes de tratar o caminho como autoritativo — ou deriva o caminho de uma variável de ambiente que o runner projete, em vez da localização do próprio script.",
  "hook-cwd.agree": "{id} deriva {name} como {expr}, que resolve para sítios diferentes no setup ({setupPath}) e no verify ({verifyPath}). Ambos estão hoje {state}, por isso nada diverge por agora.",
  "hook-cwd.agree.fix": "Vale a pena saber antes de qualquer das raízes mudar; sem ação necessária enquanto concordarem.",
  "hook-cwd.ok": "{n} fittings com ambos os hooks não derivam nenhum caminho que difira entre a raiz do seed e a da composição.",
  "demote.hooksAgree": "hoje os dois hooks concordam sobre este caminho",

  // ── check 9 · projeção da config ────────────────────────────────────────
  "config-projection.mangled": "{id} lê {name}, mas o runner projeta a config \"{key}\" como {correct} — o id é passado a maiúsculas com os separadores REMOVIDOS, não com underscores, por isso {name} nunca é definido.",
  "config-projection.mangled.fix": "Lê {correct} (runtime) ou {setupName} (hooks de setup/verify); hoje o default declarado ganha em silêncio.",
  "config-projection.mangledFallback": "{id} lê {name}, mas o runner projeta a config \"{key}\" como {correct} — o id é passado a maiúsculas com os separadores REMOVIDOS, não com underscores, por isso {name} nunca é definido.",
  "config-projection.mangledFallback.fix": "Inofensivo hoje porque {id} também lê um nome correto, mas o fallback morto convida o próximo leitor a copiá-lo. Apaga-o.",
  "demote.stillArrives": "também é lido um nome correto, por isso o valor chega na mesma",
  "config-projection.nonScalar": "{id} declara \"{key}\" como {type}, e nenhuma das projeções transporta valores não escalares — nunca chegará ao processo.",
  "config-projection.nonScalar.fix": "Achata-o em chaves escalares, ou lê-o de um ficheiro que o hook de setup escreva.",
  "config-projection.ok": "{n} fittings leem a config pelos nomes que o runner realmente projeta.",

  // ── check 5 · processos órfãos ──────────────────────────────────────────
  "orphans.staleStatus": "O ficheiro de estado ~/.garrison/ui-fittings/{fittingId}.json regista o pid {pid}, que está morto — a linha da view está desatualizada.",
  "orphans.staleStatus.fix": "O fitting saiu sem limpar (crash ou SIGKILL); o próximo up() reescreve-o. Vê o .log dele para perceber porque morreu.",
  "orphans.running": "O registo de spawn regista {fittingId} com o pid {pid} AINDA A CORRER sem ficheiro de estado — um processo órfão (a classe de fuga do server.py do local-voice).",
  "orphans.running.fix": "Inspeciona com `ps -p {pid}`; o reconciliador do runner apanha-o no próximo up(), ou mata-o à mão. O Preflight nunca mata.",
  "orphans.ok": "{statusFiles} ficheiros de estado e {spawnRecords} registos de spawn, todos coerentes com os processos vivos.",

  // ── check 6 · drift da composição ───────────────────────────────────────
  "drift.stale": "{cid} mudou desde o último up verificado ({at}): {files} mais recente(s) do que o registo do último up — o caminho rápido NÃO se aplica e vai correr um install/setup/verify completo.",
  "drift.stale.fix": "Esperado depois de edições; corre a varredura de verify antes do up() para veres o que as alterações partiram.",
  "demote.notActiveSlowUp": "{cid} não é a composição ativa, por isso um próximo up() lento não custa nada hoje",
  "drift.restation": "{id} foi removido das seleções de {cid} mas NÃO está em `unfitted` — a próxima leitura volta a adicioná-lo e desfaz a remoção em silêncio.",
  "drift.restation.fix": "Faz PUT da composição sem {id} nas seleções para que fique em `unfitted`, ou aceita que ele vai voltar.",
  "drift.restation.command": "PUT de {cid} sem {id} nas seleções (regista a exclusão), persistido pelo escritor de manifestos do Garrison",
  "drift.uncommitted": "{cid}/apm.yml difere do git HEAD. O runner reescreve este ficheiro, por isso uma diferença aqui pode ser uma edição deliberada ou uma reescrita indesejada.",
  "drift.uncommittedAdds": "{cid}/apm.yml difere do git HEAD — acrescenta {added}. O runner reescreve este ficheiro, por isso uma diferença aqui pode ser uma edição deliberada ou uma reescrita indesejada.",
  "drift.uncommitted.fix": "Revê o diff; commita as alterações deliberadas, repõe as indesejadas.",
  "drift.uncommittedAdds.fix": "Revê o diff; commita as alterações deliberadas, repõe as indesejadas.",
  "demote.gitCannotTell": "só pelo histórico do git não se distingue uma edição deliberada de uma reescrita",
  "drift.okLastUp": "{cid} coincide com o último up verificado e com o git HEAD.",
  "drift.okNoRecord": "{cid} coincide com o git HEAD (não tem registo de último up; o check de resultados do verify reporta isso).",

  // ── check 7 · kinds de capacidade ───────────────────────────────────────
  "kind-vocabulary.retired": "{id} declara o kind de capacidade \"{kind}\", que não está no vocabulário atual — registar um kind desconhecido faz o /api/compositions responder 500 e deita abaixo a UI do Muster inteira.",
  "kind-vocabulary.retired.fix": "\"{kind}\" foi retirado no pivot dos Quarters; substitui-o pelo kind atual para esta forma.",
  "kind-vocabulary.unknown": "{id} declara o kind de capacidade \"{kind}\", que não está no vocabulário atual — registar um kind desconhecido faz o /api/compositions responder 500 e deita abaixo a UI do Muster inteira.",
  "kind-vocabulary.unknown.fix": "Substitui \"{kind}\" por um kind listado em capabilityKinds (src/lib/types.ts).",
  "kind-vocabulary.okVocab": "{n} manifestos, todos os kinds declarados estão no vocabulário atual ({kinds} kinds).",
  "kind-vocabulary.okRetired": "{n} manifestos, nenhum kind retirado ({retired}) — o vocabulário atual não pôde ser lido, por isso recorreu-se à lista de retirados.",

  // ── assemblagem (lib/report.mjs) ────────────────────────────────────────
  "repo-root.missing": "Não foi possível localizar a raiz do repositório Garrison subindo a partir de {startDir} (precisa de data/library.json + fittings/seed/).",
  "repo-root.missing.fix": "Define a chave de config repo_root (GARRISON_PREFLIGHT_REPO_ROOT) para o checkout do repositório.",
  "app-reachable.down": "App Garrison inacessível em {url} — a correr em modo degradado (varredura de verify indisponível; cobertura do serve verificada diretamente no tailscale).",
  "app-reachable.down.fix": "Arranca a app (npm run dev / o agente launchd) para os checks enriquecidos. Tudo o que está abaixo correu na mesma a partir do sistema de ficheiros.",
  "manifest-parse.failed": "fittings/seed/{id}/apm.yml não pôde ser lido ({error}) — as reclamações de porta e os kinds de capacidade dele são invisíveis para todos os checks abaixo.",
  "manifest-parse.failed.fix": "Repara ou remove o manifesto; um seed que ninguém consegue ler é um seed que o resolver também não consegue estacionar.",
  "ledger.unusable": "O histórico de findings não pôde ser usado ({error}) — \"novo desde a última execução\" não está disponível nesta execução.",
  "ledger.unusable.fix": "Inspeciona ou apaga o ficheiro do histórico; o Preflight começa um novo na próxima execução."
};
