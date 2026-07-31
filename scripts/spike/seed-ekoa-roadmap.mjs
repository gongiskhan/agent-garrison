#!/usr/bin/env node
// One-shot seed: writes the Ekoa roadmap (production + contest) to
// <repo>/roadmap.json from the brief of 2026-07-31. Kept in the repo rather
// than run inline so the seed content is reviewable and the write is
// reproducible; re-running it refuses to clobber an existing file.
//
//   node scripts/spike/seed-ekoa-roadmap.mjs ~/dev/ekoa-code

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const target = process.argv[2] ?? path.join(os.homedir(), "dev", "ekoa-code");
const file = path.join(target, "roadmap.json");
if (existsSync(file)) {
  process.stderr.write(`${file} already exists - refusing to overwrite it\n`);
  process.exit(1);
}

const cat = (id, title, noteRef, items) => ({
  id,
  title,
  noteRef,
  items: items.map(([itemId, text, itemNote = null]) => ({
    id: itemId,
    text,
    done: false,
    sentToKanban: null,
    noteRef: itemNote
  }))
});

const roadmap = {
  title: "Roadmap Ekoa: produção + concurso",
  intro:
    "Regra de ouro: tudo o que está neste roadmap é feito no ekoa-code (versão nova). " +
    "Nada é feito no ekoa dev (versão antiga). Zero novas features, zero correções na antiga, " +
    "exceto emergência de cliente. Cada coisa feita na antiga cria nova divergência, invalida " +
    "testes já feitos no novo e adia a produção.",
  updatedAt: null,
  categories: [
    cat("f0", "Fase 0: ekoa-code em produção (prioridade absoluta)", "n-f0", [
      ["f0.1", "Correr a bateria de testes automatizados completa no ekoa-code (pode ser hoje)."],
      [
        "f0.2",
        "Correr um drill completo (Garrison) sobre o ekoa-code. Se o resultado do drill não satisfizer, registar as falhas e avançar na mesma: o drill não é gate desta fase."
      ],
      [
        "f0.3",
        "Novo apanhado de divergências antigo→novo, para apanhar as alterações mais recentes feitas na versão antiga (correções de inserção de ficheiros, etc.). O apanhado anterior já migrou quase tudo; este é incremental."
      ],
      [
        "f0.4",
        "Importar o artefacto do ERP Brasil Salomão do Ekoa de produção atual para o ekoa-code. Corrigir os problemas de importação que aparecerem."
      ],
      [
        "f0.5",
        "Correr a bateria de testes existente do artefacto BSM (o projeto mais importante e único em produção) no ekoa-code. Corrigir até verde."
      ],
      ["f0.6", "Pôr o agente a testar o ERP exaustivamente no novo."],
      [
        "f0.7",
        "Testar à mão o fluxo crítico: assinatura + SharePoint. Passar as integrações SharePoint e Outlook para o ekoa-code. (Nota de transcrição: \"do ouro\" interpretado como Outlook; confirmar.)"
      ],
      [
        "f0.8",
        "Passar pelas últimas demandas: relatório do Nicolas (tudo o que fez), email com as últimas demandas de coisas que não funcionavam, e pedidos anteriores. Dar ao agente a lista completa e verificar item a item que na versão nova está tudo a funcionar."
      ],
      [
        "f0.9",
        "Produzir a checklist de go-live a partir de f0.1 a f0.8 e trabalhar sobre ela (formato checklist é o que funciona)."
      ],
      ["f0.10", "Go-live: ekoa-code em produção. A partir daqui, só se trabalha no novo."]
    ]),
    cat("f1", "Fase 1: Integrações Citius e notariado", "n-f1", [
      [
        "f1.1",
        "Levantamento do que é tecnicamente possível: Citius (acesso de advogado com certificado; provavelmente automação de browser, sem API pública) e plataformas do notariado. Definir âmbito da v1: que atos, que consultas. (Nota de transcrição: \"sítios\" interpretado como Citius.)"
      ],
      ["f1.2", "Implementar a integração Citius v1."],
      ["f1.3", "Implementar a integração notariado v1."]
    ]),
    cat("f2", "Fase 2: SMS OTP no Cortex", null, [
      [
        "f2.1",
        "Mecanismo genérico de códigos por SMS no Cortex: emissão, validação, expiração, rate limiting (por número, por IP), registo. Pensado como serviço reutilizável: logins, recuperação de password, verificação na webapp do concurso, futuro."
      ],
      [
        "f2.2",
        "Primeiro caso de uso: Forgot Password no Ekoa com código SMS. Serve de validação do mecanismo em produção antes do concurso depender dele."
      ],
      [
        "f2.3",
        "Escolher fornecedor (Twilio ou equivalente), configurar sender ID, custos.",
        "n-votacao"
      ]
    ]),
    cat("f3", "Fase 3: Tarefas como funcionalidade core do Ekoa", null, [
      [
        "f3.1",
        "App de tarefas no Ekoa: um Kanban simples, ao estilo do que já existe no Garrison (portar o conceito, não reinventar)."
      ],
      [
        "f3.2",
        "Tarefas delegáveis a agentes: uma tarefa pode ser entregue ao agente para execução, não só gerida por humanos. É isto que torna \"tarefas\" core no Ekoa e não mais uma app de listas."
      ]
    ]),
    cat("f4", "Fase 4: Integração Omi", "n-f4", [
      [
        "f4.1",
        "App Ekoa para o Omi (dispositivo wearable de IA): captura de gravações (reuniões presenciais, chamadas) e envio para o Ekoa."
      ],
      [
        "f4.2",
        "Pipeline no Ekoa: transcrição → memórias, tarefas/ações (to-dos), tudo estruturado no sítio certo. O trabalho equivalente está em curso no Garrison; portar depois é fácil."
      ],
      [
        "f4.3",
        "Instruções de utilizador: como adicionar a app Ekoa ao Omi, o que acontece a seguir. Página curta com link para o site do Omi a explicar o dispositivo."
      ]
    ]),
    cat("f5", "Fase 5: Bundles (venda de pacotes de aplicações)", "n-f5", [
      [
        "f5.1",
        "Área de bundles dentro da aplicação Ekoa: escolher aplicações, ver demos, adicionar um bundle à conta."
      ],
      [
        "f5.2",
        "Página de bundles no site do Ekoa. Regra de preços: nunca mostrar o preço do bundle sozinho. Mostrar sempre dois valores: preço do bundle para quem já é cliente Ekoa, e preço bundle + subscrição (subscrição corrente à data + valor do bundle)."
      ],
      [
        "f5.3",
        "Página de detalhe do bundle: é a mesma página com ou sem link de parceiro (reutilizar tudo). Sem link/código, não há atribuição de referral."
      ],
      [
        "f5.4",
        "Link de parceiro com código → aterra direto no detalhe do bundle. A venda por esse link fica registada com atribuição ao parceiro."
      ],
      [
        "f5.5",
        "Notificação de venda: numa fase inicial, o pagamento ao parceiro é manual; basta o Gonçalo ser notificado (email ou equivalente) de cada venda com atribuição, para pagar. Pagamentos automatizados ficam para mais tarde."
      ],
      [
        "f5.6",
        "Definir a mecânica exata do código de referral (em aberto): quando é atribuído, se se pede código no checkout sem link, se o código só nasce depois da primeira venda."
      ]
    ]),
    cat("f6", "Fase 6: Webapp do concurso", null, [
      [
        "f6.1",
        "Landing do concurso: o que é, prémios, regulamento, como participar. Instruções muito fáceis, passo a passo."
      ],
      [
        "f6.2",
        "Criação de contas gratuitas únicas: a pessoa escreve a descrição da app que quer, carrega em \"criar aplicação\", verifica o número por SMS (mecanismo da Fase 2), e recebe uma conta Ekoa gerada (username aleatório + password aleatória), de preferência com link que entra já autenticado. Limite de utilização por tokens.",
        "n-contas"
      ],
      [
        "f6.3",
        "Fluxo de criação da app via API do Cortex: descrição → app gerada → ajustes iterativos, dentro dos limites (prompts e tokens), sem custo para a pessoa."
      ],
      [
        "f6.4",
        "Submissão a votação: descrição da aplicação + link para a app a correr no Ekoa + preço pretendido de venda (não final, sujeito a aprovação do Ekoa). Instruções claras de como copiar o link da app e submeter."
      ],
      ["f6.5", "Sistema de votação: um voto por número de telefone verificado por SMS.", "n-votacao"],
      ["f6.6", "Galeria pública das submissões com votação."],
      [
        "f6.7",
        "Backoffice mínimo: moderação de submissões (barra mínima de validade), monitorização de votos e de consumo de tokens, exportação de contactos."
      ]
    ]),
    cat("f7", "Fase 7: Lançamento do concurso", "n-concurso-decisoes", [
      ["f7.1", "Validar regulamento com advogado e contabilista.", "n-legal"],
      [
        "f7.2",
        "Pré-comprometer 12 a 15 participantes antes de qualquer anúncio público (rede: Marília, Alexandra, BSM, Nicolas, Nicholas)."
      ],
      [
        "f7.3",
        "Anúncio e abertura. Fóruns e comunidades de advogados como canal principal: o desenho é comunidade a descobrir, criar, experimentar as apps uns dos outros e votar."
      ],
      [
        "f7.4",
        "Acompanhamento: consumo de tokens, fraude de votos, qualidade das submissões.",
        "n-custos"
      ],
      [
        "f7.5",
        "Encerramento, apuramento, entrega de prémios, imprensa, casos de estudo.",
        "n-premios"
      ]
    ])
  ],
  notes: [
    {
      id: "n-f0",
      title: "Fase 0: decisões",
      body: [
        "Gate de saída: tudo o que a Brasil Salomão possa querer fazer é suportado no novo. A BSM é o único cliente; quando o ERP funciona a 100% no novo, vai para produção. Decidir com muita segurança, mas decidir.",
        "",
        "- Decisão: não envolver a Luciana nos testes pré-produção. Regressões novas podiam assustar e reabrir o ciclo de testes do lado deles. Fazemos tudo internamente; se escapar algum problema para produção, corrige-se e paciência. A decisão de ir para produção é nossa e tem de ser tomada com muita segurança.",
        "- O drill (Garrison) é desejável para automatizar todos os testes do Ekoa no futuro, mas não é gate desta fase. Não deixar o perfecionismo do drill adiar a produção. (Acabar o drill \"perfeito\" é projeto do Garrison, não bloqueador do Ekoa.)",
        "- Racional do gate: a BSM é o único cliente. \"Suporta tudo o que a BSM quer fazer\" é a definição operacional de \"pronto\"."
      ].join("\n")
    },
    {
      id: "n-f1",
      title: "Citius / notariado",
      body: [
        "- Muito importante para advogados; parte do moat do vertical (com o Registo/audit trail). Deve existir, mesmo em v1 modesta, antes do anúncio do concurso, porque é argumento de adoção para o público-alvo.",
        "- Citius: sem API pública conhecida; caminho provável é automação de browser com o certificado do advogado. Liga-se ao trabalho de automação já em curso no Garrison (campanha de testes de automação). Investigar antes de prometer âmbito."
      ].join("\n")
    },
    {
      id: "n-f4",
      title: "Fase 4: dependência do prémio",
      body: "O prémio do 1.º lugar do concurso inclui um Omi com a integração a funcionar. Esta fase tem de estar pronta antes do anúncio dos prémios."
    },
    {
      id: "n-f5",
      title: "Bundles",
      body: [
        "Contexto: o programa de parceiros existe como documento e página, mas o Ekoa ainda não tem a funcionalidade de vender bundles. É pré-requisito do prémio de revenue share do concurso.",
        "",
        "- Em aberto: mecânica exata do código de referral. Hipóteses faladas: pedir código no detalhe quando não há link; atribuir código ao parceiro apenas depois da primeira venda. Decidir quando se desenhar o checkout.",
        "- Preços: a regra \"nunca mostrar o preço do bundle sozinho\" existe para o bundle nunca parecer um produto independente da subscrição."
      ].join("\n")
    },
    {
      id: "n-contas",
      title: "Contas gratuitas do concurso",
      body: [
        "- Unicidade garantida por SMS OTP: um número de telefone = uma conta gratuita. O mesmo mecanismo da votação.",
        "- Limites falados: máximo ~50 prompts e teto de tokens. Números mencionados: 2M a 5M para a criação da app; 5M a 10M por conta na versão \"experimentar o Ekoa\". Decisão pendente do valor final. Recomendação: começar em 2M a 3M com possibilidade de top-up mediante pedido; um pedido de top-up é um sinal fortíssimo de lead interessada e uma oportunidade de conversa.",
        "- O teto de tokens é o guardrail de custo real do concurso (ver n-custos).",
        "- Auto-login por link: token de primeira sessão com expiração; mostrar também as credenciais para acesso posterior.",
        "- Nota estratégica: isto é simultaneamente o funil de aquisição. Cada conta criada é uma pessoa com telefone verificado a experimentar o Ekoa de graça com limites. Não é preciso mexer quase nada no Cortex/Ekoa para além do SMS e da criação programática de contas."
      ].join("\n")
    },
    {
      id: "n-votacao",
      title: "Desenho anti-fraude da votação",
      body: [
        "- Identidade de voto = número de telemóvel verificado por SMS. Um número, um voto. Este é o mecanismo principal; tudo o resto são camadas.",
        "- Aceitar apenas números móveis portugueses (+351 9x). Bloquear números fixos e manter uma lista atualizável de prefixos/intervalos típicos de números virtuais (Twilio e afins). Aceita-se perder um ou dois votos legítimos com números estrangeiros: paciência.",
        "- Racional de risco: o público (advogados) não é uma comunidade com perfil de ataque técnico; o custo de comprar números virtuais PT para escalar fraude é real e o ganho é pequeno.",
        "- Correção técnica importante ao desenho inicial: \"um voto por IP\" não funciona em Portugal. As operadoras móveis usam CGNAT: centenas de utilizadores legítimos partilham o mesmo IP público. Um advogado a votar do telemóvel seria bloqueado pelo voto de outro. O IP e o fingerprint do browser não são identidade: são sinais e rate limiting. Concretamente: limitar pedidos de SMS por IP (ex.: 3 a 5 por hora, não 1 absoluto), limitar por número (reenvio com cooldown), captcha bom antes de qualquer envio de SMS, fingerprint como sinal soft para flagging.",
        "- Email: pedir email único e filtrar domínios descartáveis é camada adicional válida para a conta/submissão, mas a unicidade do voto vem do telefone.",
        "- Custos de SMS: ordem de grandeza 0,04 a 0,08 € por SMS em PT. Mesmo com 1.000 a 2.000 envios (votos + contas + reenvios), fica em dezenas de euros. O rate limiting é mais anti-abuso do que controlo de custo.",
        "- Desempate: nunca por sorteio (arrasta o evento para o regime licenciado). Critério determinístico escrito no regulamento (ex.: em empate, decide a data/hora da submissão mais antiga, ou decisão fundamentada da organização)."
      ].join("\n")
    },
    {
      id: "n-premios",
      title: "Prémios decididos",
      body: [
        "- 1.º lugar: conta Ekoa gratuita 3 anos + 20 horas de desenvolvimento para ajudar a desenvolver a própria aplicação (integrações, ligações a outros sistemas, partes complexas) + Omi com integração Ekoa a funcionar + entrada no programa de parceiros com link de venda.",
        "- 2.º lugar: conta gratuita 2 anos + 10 horas de desenvolvimento + programa de parceiros com link.",
        "- 3.º lugar: conta gratuita 1 ano + 5 horas de desenvolvimento + programa de parceiros com link.",
        "- Revenue share igual para os três: 20% em vendas a clientes que já sejam Ekoa, através do link do vencedor; nas restantes vendas, aplicam-se as condições da página de parceiros. Os três ficam automaticamente inscritos no programa e recebem os links.",
        "- O preço pretendido de venda da app é indicado pelo participante na submissão; não é final e está sujeito a aprovação do Ekoa.",
        "- As horas de desenvolvimento são para a app premiada, com âmbito fechado por escrito antes de começar, agendadas em janela definida (proteção do tempo, que é o recurso mais escasso).",
        "- Comunicação da conta gratuita: definir com precisão (nominativa, individual, não transmissível, limites de tokens do plano de referência). \"Explicar bem, sem letra pequena escondida.\"",
        "- Pendente: Omi só para o 1.º ou para os três primeiros. Recomendação: só o 1.º na primeira edição. Mantém o 1.º lugar distintivo (único prémio físico, boa fotografia de vencedor), controla custo e triplicar o suporte de integração na edição 1 é risco desnecessário. A escada já é generosa nos três lugares."
      ].join("\n")
    },
    {
      id: "n-legal",
      title: "Validações externas antes do anúncio",
      body: [
        "- A mudança de júri para votação comunitária mantém o concurso no campo do mérito (as pessoas votam na melhor aplicação; não há sorte em nenhum passo). A exclusão do regime das modalidades afins refere as operações que dependem exclusivamente da perícia ou mérito, dando o júri como exemplo (\"nomeadamente... avaliados por um júri\"). Votação pública por mérito é defensável, mas confirmar com o advogado que a exclusão se mantém sem júri, e manter a regra absoluta: nenhum elemento aleatório em nenhum ponto (nem desempates, nem brindes sorteados entre votantes).",
        "- Imposto do Selo: o entendimento da AT afasta a sujeição quando não há fator sorte na avaliação. Confirmar com o contabilista que a votação comunitária preserva esse enquadramento, e o tratamento fiscal dos prémios em espécie (Omi) e das horas de desenvolvimento.",
        "- Deontologia: comunicação centrada na solução construída, nunca na captação de clientes do premiado. Dados fictícios obrigatórios nas submissões, declaração assinada.",
        "- Regulamento com RGPD (telefones e emails recolhidos), propriedade intelectual (participante mantém a app; licença de divulgação ao Ekoa), direitos de imagem, moderação/barra mínima de validade das submissões."
      ].join("\n")
    },
    {
      id: "n-custos",
      title: "Orçamento real do concurso",
      body: [
        "- A maior linha de custo não são os prémios: são os tokens das contas gratuitas. Conta rápida: 150 contas × teto 5M × consumo médio 40% ≈ 300M tokens; ao custo efetivo de agente de código, isto é entre várias centenas e poucos milhares de euros, conforme modelo e caching. Com teto de 10M e boa adesão, multiplica.",
        "- Alavancas: teto inicial baixo (2M a 3M) com top-up a pedido; prompt caching agressivo (a proteção de margem de maior alavancagem, já identificada como subutilizada); modelo mais económico para estas contas se a qualidade aguentar.",
        "- SMS: dezenas de euros. Omi: ~90 a 150 € por unidade. Troféu/selo se se mantiver: ~100 €."
      ].join("\n")
    },
    {
      id: "n-concurso-decisoes",
      title: "Registo de decisões do concurso (substitui secções do brief-premio-ekoa-advogados.md v0.1)",
      body: [
        "1. Júri eliminado. Motivos: difícil recrutar jurados com incentivo real; carga de avaliar muitas aplicações; e sobretudo o desenho pretendido é comunidade: pessoas descobrem num fórum, acham giro, criam a sua app, instalam e experimentam as apps das outras, e votam. O prémio principal é decidido por votação comunitária verificada (ver n-votacao). A \"categoria do público separada\" do brief anterior deixa de fazer sentido: o público é o mecanismo.",
        "2. Prémios revistos conforme n-premios (3/2/1 anos, 20/10/5 horas, Omi, revenue share 20% + programa de parceiros). Cai a \"subscrição vitalícia\": passa a prazo definido. Cai o pacote imprensa/troféu como prémio central (pode manter-se como reconhecimento, decisão posterior).",
        "3. Hardware decidido: Omi, condicionado à integração Ekoa pronta (Fase 4). MacBook e iPhone confirmados como fora.",
        "4. Submissão simplificada: descrição + link da app no Ekoa + preço pretendido. O vídeo de 3 minutos do brief anterior cai (reduzir fricção); reavaliar se fizer falta para a galeria.",
        "5. Calendário: deixa de ser fixo; passa a depender do roadmap (Fases 0 a 6 antes do anúncio). O princípio \"anúncio só depois das férias judiciais e com 12 a 15 pré-comprometidos\" mantém-se.",
        "6. Mantém-se válido do brief anterior: todo o levantamento legal e fiscal (§5), a lógica de dados fictícios e sigilo (§5.4), o conteúdo mínimo do regulamento (§5.5) e o risco número um: o prémio vazio."
      ].join("\n")
    },
    {
      id: "n-pausado",
      title: "Fora de âmbito enquanto este roadmap corre",
      body: [
        "- Decisão consciente de foco: enquanto este roadmap não chega ao fim, ficam pausados o Ekoa OS Run 1, a campanha de testes de automação (exceto o que alimentar diretamente Citius/Omi) e o site Visita v2. Não é abandono, é sequência. Registado aqui para ser uma escolha e não uma deriva.",
        "- Motivação escrita pelo próprio: \"estou sempre a ter ideias e nunca mais estou pronto para ter utilizadores a sério. Tenho de terminar isto, pôr a versão nova em produção e começar a ter utilizadores reais.\""
      ].join("\n")
    }
  ]
};

roadmap.updatedAt = new Date().toISOString();
writeFileSync(file, JSON.stringify(roadmap, null, 2) + "\n", "utf8");
process.stdout.write(`${file}\n`);
