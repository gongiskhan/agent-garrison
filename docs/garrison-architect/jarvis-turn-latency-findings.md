# Jarvis — turn latency findings

Data: 2026-06-18. Setup medido: composição `compositions/jarvis/`, channel
`jarvis-os` (:7092), voz `local-voice` (:7090), gateway `http-gateway`
(:4777, engine PTY interativo). Modelo de arranque do operative:
`GARRISON_MODEL=sonnet`. Profile de routing ativo: `balanced`.

Todas as medições foram feitas contra o endpoint `POST /chat/stream` do
gateway (timestamps no cliente) cruzadas com os eventos internos do gateway
(`route-resolved`, `route-switch`, `routed-turn`) em `/tmp/gateway.log`, e com
turnos diretos à `OperativePtySession` (sem gateway) para isolar o piso.

---

## Tarefa 1 — o que foi corrigido, e é durável?

### Não foi "subir o Claude Code"

Subir para **Claude Code 2.1.181 foi a CAUSA da regressão**, não o fix. O fix
foram **duas alterações de código** feitas nesta máquina (branch
`feat/local-voice-jarvis`, sem commit):

1. **`fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs`** — nova
   helper `injectSlash()` (substitui o antigo `writeKeys(inj+"\r")` +
   `sleep(250)` em `applySwitch`). Em 2.1.181 o `/model <x>` deixou de mudar o
   modelo diretamente quando há conversa em cache: abre um modal
   `Switch model? ❯ 1.Yes / 2.No` que engole o stdin. `injectSlash()` deteta
   esse modal e confirma com `1`+Enter, depois espera o prompt `❯` ficar idle
   antes de seguir (Escape como fallback para um picker desconhecido).

2. **`fittings/seed/http-gateway/scripts/gateway-pty.mjs`** — auto-heal em
   `spawnOperative`. O gateway arranca o operative com `--continue` quando
   existe o marker `.garrison/operative-session-id`. Em 2.1.181, se a conversa
   referida já não existe, o TUI imprime **"No conversation found to continue"**
   e fica **vivo mas a rejeitar todo o input** — daí o
   `OperativePtySession: message never registered`. O fix deteta essa string no
   ecrã (`screenHasNoConversation`), faz dispose, apaga o marker órfão e
   re-arranca fresh com `--session-id` novo.

   > Esta (2) era a **causa principal** do hang: o input nunca era aceite, e o
   > turno só falhava ao fim do timeout (`message never registered`).

(Existe ainda, de uma sessão anterior, o fix do modal "Bypass Permissions mode"
em `packages/claude-pty/src/session.mjs` `#submitAndConfirm`, que também é
screen-scraping.)

### É durável? Não — é frágil.

Ambos os fixes são **screen-scraping**: dependem de detetar literais de texto e
a estrutura do TUI do Claude Code:

- `/Switch model\?/`, `/Yes, I accept/`, `/No conversation found to continue/`,
  o gliph do prompt `❯`, o marcador de spinner `(esc to interrupt)`.

Qualquer atualização do Claude Code que mude esses textos, o layout do TUI, ou o
fluxo dos modais **volta a partir** — foi exatamente o que aconteceu de 2.1.179
→ 2.1.181. A solução durável (eliminar o screen-scraping) é migrar para uma
interface programática (`--output-format stream-json` / SDK), que é uma mudança
grande — ver Opção E no fim.

---

## Tarefa 2 — repartição do turno (~10–12s warm)

### Modelo + effort do turno conversacional, e onde está configurado

O operative **arranca em `sonnet`** (`GARRISON_MODEL=sonnet`, passado no comando
de arranque do gateway). Mas o modelo **efetivo por turno** é decidido pelo
router a cada mensagem:

- Config: `fittings/seed/model-router/config/routing.seed.json` (não há
  `routing.json` scoped na composição, por isso usa o seed). Profile `balanced`,
  `roleMap`: `fast → cc-haiku-low`, `standard → cc-sonnet-med`,
  `expert → cc-opus-high`. Matrix: `other`/`T0-trivial → fast`.
- Uma mensagem conversacional trivial ("2+2") classifica quase sempre como
  `other`/`T0-trivial → fast → cc-haiku-low` (**Haiku 4.5, effort low**).
  Ocasionalmente o classificador marca-a como `research → standard →
  cc-sonnet-med` (Sonnet medium) — a classificação é **não-determinística**.

> **O turno conversacional NÃO está em Opus high.** Já corre no modelo/effort
> mais baixos (Haiku low) na maioria dos turnos.

### Sinal de fim de turno: cai sempre no Sinal C (espera por idle)

- **Sinal B** (`turn_duration` / `stop_hook_summary` lidos do JSONL, em
  `detection.mjs`/`jsonl.mjs`) **NÃO dispara**: não existe diretório/ficheiro
  JSONL para esta composição (`~/.claude/projects/*jarvis*` está vazio — o
  Claude 2.1.x não persiste a conversa de forma legível neste cwd).
- O `runTurn` (`session.mjs`) usa `waitForTurnComplete` de **`screen.mjs`**, que
  é o **Sinal C**: espera `!busy && prompt ❯ vazio && screen estável` durante
  `settleMs = 1400ms` (poll de 350ms). É isto que termina **todos** os turnos.
- Custo observado do Sinal C no fim de cada turno: **~2.1s** (1.4s de settle +
  poll/estabilização).

### Repartição (turno warm, ~9.6–10.3s, rota haiku-low)

Cruzando o cliente com os logs internos:

| Fase | Tempo | Notas |
|------|-------|-------|
| **Classificação (`preRoute` → classifier Haiku)** | **~5.2s** | **maior pedaço** — sessão classifier separada decide taskType+tier |
| slash-inject (`/model`,`/effort`) | 0–0.3s | `noop` quando o operative já está no target |
| Geração até 1º token | ~2.3s | Haiku |
| Geração restante + settle Sinal C (1400ms) | ~2.1s | fim de turno |
| **Total warm** | **~9.6–10.3s** | |

Cold start (primeiro turno após arranque): **~21s** (o classifier e o operative
aquecem). Medições baseline (operative fresh, 3 turnos "2+2"): **21.0s / 10.3s /
9.6s**.

**Maior pedaço: a classificação (~5.2s ≈ metade do turno).** Não a geração, nem
o modelo.

### ⚠️ Achado crítico: o hang de ~6min NÃO está totalmente resolvido

Durante a medição observei **dois timeouts de 300s** (`OperativePtySession turn
timed out after 300055ms` / `300120ms`) — o turno gerava o 1º token (~6.8s) mas
o Sinal C **nunca detetava o idle**, esperando o `DEFAULT_TIMEOUT_MS` (5 min) de
`session.mjs`.

- Aconteceu no operative que estava **vivo há horas** (alto uptime).
- Um operative **fresh** (rearrancado): **3/3 turnos OK, zero timeouts**.
- **Não é o contexto:** o "ctx: 85%" da statusline é
  `context_window.remaining_percentage` — 85% **livre** (só 15% usado). A
  statusline custom (`~/.claude/statusline-command.sh`) é estática durante um
  turno parado.

Ou seja: o que foi corrigido foi o **input** (`message never registered`). A
**deteção de fim de turno (Sinal C)** ainda falha intermitentemente em
operatives de uptime longo, e quando falha cai no timeout de 5 min. A causa
exata da instabilidade do screen nesses casos não ficou isolada — ver Opção D.

---

## Tarefa 3 — teste de modelo/effort

### A premissa "Opus high" não se aplica

O turno conversacional já corre em **Haiku low** (ver Tarefa 2). **Não há modelo
mais baixo para onde encaminhar**, por isso uma troca de modelo/effort não tem
ganho a obter.

Verifiquei também se desligar a classificação por config era possível:
**`preRoute: "off"` no `routing.seed.json` NÃO desliga a classificação** — o
`gateway-pty.mjs` chama `router.preRoute()` (→ `classify()`)
**incondicionalmente**; o valor `preRoute` só altera texto no prompt do
operative. Logo a maior alavanca (a classificação) **não é desligável por
config** — exige código.

### Teste feito: piso de latência sem routing (reversível, não-permanente)

Como não há troca de modelo útil, medi o **piso**: turno **direto** à
`OperativePtySession` em **Haiku**, sem gateway/classificador no caminho. Isto
não altera nenhuma config persistente — é um processo de teste à parte; "reverter"
= simplesmente não o correr.

| Cenário | Cold | Warm | Warm #2 |
|---------|------|------|---------|
| **Gateway (com classificação)** — baseline | 21.0s | 10.3s | 9.6s |
| **Direto Haiku (sem classificação)** — piso | 15.9s | **5.5s** | **5.5s** |

**Ganho: ~4–5s por turno**, exatamente o custo da classificação medido na
Tarefa 2. O piso de ~5.5s warm reparte-se em geração Haiku (~4s) + settle do
Sinal C (~1.4s fixo).

**Conclusão da Tarefa 3:** baixar modelo/effort **não dá ganho** (já está no
fundo). O ganho real (~5s, metade do turno) está em **eliminar/contornar a
classificação**, que é código, não config.

---

## ✅ Opção A — IMPLEMENTADA (2026-06-18)

Implementada a Opção A: o gateway passou a **respeitar `preRoute: "off"`**,
saltando a classificação por turno e fixando o turno no target `fast` do profile
(`cc-haiku-low`).

### O que mudou

1. **Código** — `fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs`,
   método `preRoute()`: quando o profile ativo tem `preRoute: "off"`, **salta
   `classify()`** (a chamada ao classifier, ~5s) e constrói uma rota fixa para
   `roleMap.fast`. O `applySwitch` continua a correr — faz o slash-inject uma vez
   (sonnet de arranque → haiku-low) e depois é `noop`. Quando `preRoute: "on"`
   (default), o comportamento é idêntico ao anterior.
2. **Config (scoped, não toca no seed)** —
   `compositions/jarvis/.garrison/routing.json`: cópia de `routing.seed.json`
   com `profiles.balanced.preRoute: "off"`. O `loadRoutingConfig` prefere o
   scoped ao seed.

### Resultado medido (turnos "2+2")

| Turno | preRoute on (baseline) | **preRoute off (Opção A)** |
|-------|------------------------|----------------------------|
| cold  | 21.0s                  | 17.8s                      |
| warm  | 10.3s / 9.6s           | **5.5s / 5.5s / 6.9s**     |

**Ganho: ~4s por turno (~40% mais rápido) no warm.** Logs confirmam
`via: "preroute-off"` (sem classificação) e `route-switch: noop` (sem
slash-inject após o 1º turno); zero timeouts na bateria. O warm de ~5.5s iguala
o piso teórico (geração Haiku ~4s + settle Sinal C ~1.4s).

### Trade-off

Sem classificação, **todos** os turnos do Jarvis vão para `cc-haiku-low`,
incluindo um eventual pedido complexo (não há mais escalonamento para
Sonnet/Opus). Para um assistente de voz conversacional é o comportamento
desejado. Se precisares de routing inteligente de volta, reverte (abaixo).

### Como reverter

```bash
# 1. remover a config scoped → volta ao seed (preRoute: "on")
rm /Users/mrm/agent-garrison/agent-garrison/compositions/jarvis/.garrison/routing.json
# 2. reiniciar o gateway (mesmo comando de arranque de sempre)
```

A alteração de código em `gateway-routing.mjs` pode ficar — é inócua com
`preRoute: "on"` (caminho idêntico ao anterior). Para a reverter também, repõe o
método `preRoute()` à versão sem o branch `preRouteOff`.

---

## Opções que sobram (para decidires)

Ordenadas por relação ganho/risco:

- ~~**A. Contornar a classificação no turno conversacional (~−5s).**~~
  **FEITO** — ver secção acima (~40% mais rápido).

- ~~**D. Resolver os timeouts de 300s.**~~ **RESOLVIDO** — ver secção abaixo.
  A causa NÃO era uptime nem o Sinal C: era o **modelo Sonnet**. Mantendo o
  Jarvis em Haiku (o que a Opção A já faz), os timeouts desaparecem.

- **C. Reduzir o settle do Sinal C (1400ms → ~600ms) (~−0.8s).** Uma linha
  (`settleMs` no `runTurn`), mas é código e tem risco de cortar o fim de
  respostas mais longas. Ganho pequeno.

- **B. Classificação mais rápida.** O classifier já é Haiku low; só acelera
  mudando de abordagem (ex.: heurística/regex local para triviais, em vez de uma
  chamada LLM). Sobrepõe-se à Opção A.

- **E. Eliminar o screen-scraping: migrar para `--output-format stream-json` /
  SDK.** Resolve de raiz a fragilidade da Tarefa 1 **e** os timeouts da Tarefa 2
  (fim de turno passa a ser um evento explícito, não "espera por idle"). É a
  mudança grande — deixada para tua decisão, como pediste.

## ✅ Opção D — RESOLVIDA (2026-06-18): o timeout de 300s era o modelo Sonnet

Investigação (scripts isolados que conduzem `runTurn` e dumpam `session.screen()`):

- **A causa NÃO é uptime nem contexto.** Reproduz-se logo no 2º–3º turno de um
  operative fresh.
- **No estado congelado**, o ecrã mostra a resposta do turno anterior já dada
  (`⏺ 4`), mas o input box (`❯`) fica com texto **não submetido** → `promptReady`
  nunca fica true → `waitForTurnComplete` espera o `DEFAULT_TIMEOUT_MS` (5 min).
- **A causa raiz é o modelo.** Bateria de turnos conversacionais, operative
  fresh, código de produção:
  | Modelo | Resultado |
  |--------|-----------|
  | **Sonnet** | ~4/10 OK (6 timeouts de 300s) |
  | **Haiku** | **8/8 OK, 8/8 OK — 0 timeouts** |

  O screen-scraping (`#submitAndConfirm` + `waitForTurnComplete`) tem uma race
  com o comportamento do TUI do **Sonnet** (render/“reasoning” diferente do
  Haiku): a submissão e a deteção de fim dessincronizam, deixando texto preso no
  input. Com **Haiku** o TUI é simples e estável e a race não ocorre.

### O que mudou (e o que NÃO mudou)

- **NÃO mexi na deteção.** Cheguei a tentar reescrever o `#submitAndConfirm`
  (confirmar submit por input-vazio / ancorado no texto), mas não resolveu o
  Sonnet (a race é mais funda) e é exatamente o tipo de "reescrever a deteção"
  a evitar — por isso **revertido**. `session.mjs` está como estava.
- **Solução = manter o Jarvis em Haiku.** A **Opção A já garante isto** (todo o
  turno → `cc-haiku-low`). Reforcei o arranque do gateway com
  **`GARRISON_MODEL=haiku`** (antes `sonnet`), para que nem o 1º turno toque em
  Sonnet.

### Validação (gateway real, Haiku + Opção A)

Bateria de 8 turnos conversacionais variados via `POST /chat/stream`:
**8/8 OK, 0 timeouts**, warm ~4.5–5.2s (cold 9.3s). `grep "timed out"` no log
do gateway: 0.

### Trade-off e limite

O Jarvis fica preso em Haiku — não escala para Sonnet/Opus. Para um assistente
de voz conversacional é adequado. **Se quiseres usar Sonnet/Opus de forma
fiável no caminho PTY, é preciso a Opção E** (`stream-json`/SDK): elimina o
screen-scraping e a race modelo-dependente de raiz. Continua reservada para ti.

### Nota de estado

O gateway corre agora **com a Opção A ativa** (`preRoute: "off"` via
`compositions/jarvis/.garrison/routing.json`) **e `GARRISON_MODEL=haiku`** no
arranque (Opção D). Os três serviços de pé: `jarvis-os` :7092, `local-voice`
:7090, `http-gateway` :4777 (bind `127.0.0.1`). Turno conversacional warm:
**~4.5–5.2s** (era ~10s), **0 timeouts**.

Comando de arranque do gateway (atualizado — `GARRISON_MODEL=haiku`):
```bash
GARRISON_GATEWAY_PORT=4777 \
GARRISON_COMPOSITION_DIR=$(pwd)/compositions/jarvis \
GARRISON_SYSTEM_PROMPT_PATH=$(pwd)/compositions/jarvis/jarvis-prompt.md \
GARRISON_MODEL=haiku \
GARRISON_PERMISSION_MODE=bypassPermissions \
node fittings/seed/http-gateway/scripts/gateway.mjs
```
