// Viewer interactivity. Vanilla, no build step, no framework.
//
// There is deliberately very little here. The pages are server-rendered
// documents, so the only client-side jobs are: dispatching a prompt button,
// triaging a finding, keyboard navigation between states, and copying the
// compare report. Anything more would be a reason to reach for a framework, and
// then the fitting would need a build pipeline in the seed tree — which is the
// one thing the setup-cwd bug makes fragile.

(function () {
  "use strict";

  var busy = false;

  // The server stamps the reader's language onto <body data-lang>, so the few
  // strings this file produces follow the same choice as the rendered page. Kept
  // as a tiny local table rather than fetched: four messages are not worth a
  // round trip, and a failed fetch would leave the UI mute.
  var LANG = (document.body && document.body.getAttribute("data-lang")) === "pt" ? "pt" : "en";
  var COPY = {
    en: {
      dispatching: "Dispatching…",
      composing: "Composing the prompt and handing it to the operative…",
      failed: "Dispatch failed.",
      failedWith: "Dispatch failed: ",
      pickOne: "Select at least one finding first.",
      answer: "Answer:",
      noReply: "(no reply)",
      cardMade: "Card {id} is on the board, in Backlog. Advance it there to start the work.",
      cardMadeNoId: "Card is on the board, in Backlog. Advance it there to start the work.",
      cardExists: "This job is already queued as card {id}. Nothing new was created — advance that one instead.",
      copied: "Copied",
      copy: "Copy",
      "err.noKanban":
        "No kanban board is running in this instance ({instance}), so the card has nowhere to go. The prompt is below — hand it to the operative yourself, or start the kanban-loop fitting.",
      "err.noGateway":
        "This composition has no gateway configured, so a short question cannot be answered here. The prompt is below.",
      "err.treeClean":
        "The working tree is clean — everything is committed, so there is nothing to narrate. Narrate the commit itself from the Commits page.",
    },
    pt: {
      dispatching: "A despachar…",
      composing: "A compor o prompt e a entregá-lo ao operativo…",
      failed: "O despacho falhou.",
      failedWith: "O despacho falhou: ",
      pickOne: "Seleciona ao menos um achado primeiro.",
      answer: "Resposta:",
      noReply: "(sem resposta)",
      cardMade: "O cartão {id} está no quadro, no Backlog. Avança-o lá para o trabalho começar.",
      cardMadeNoId: "O cartão está no quadro, no Backlog. Avança-o lá para o trabalho começar.",
      cardExists: "Este trabalho já está em fila no cartão {id}. Não criei nada de novo — avança esse.",
      copied: "Copiado",
      copy: "Copiar",
      "err.noKanban":
        "Não há quadro kanban a correr nesta instância ({instance}), por isso o cartão não tem para onde ir. O prompt está abaixo — entrega-o tu ao operativo, ou arranca o fitting kanban-loop.",
      "err.noGateway":
        "Esta composição não tem gateway configurado, por isso uma pergunta curta não pode ser respondida aqui. O prompt está abaixo.",
      "err.treeClean":
        "A árvore de trabalho está limpa — está tudo commitado, portanto não há nada para narrar. Narra o próprio commit a partir da página Commits.",
    },
  };

  function s(key, vars) {
    var out = (COPY[LANG] && COPY[LANG][key]) || COPY.en[key] || key;
    if (vars) {
      for (var name in vars) {
        if (Object.prototype.hasOwnProperty.call(vars, name)) {
          out = out.split("{" + name + "}").join(String(vars[name]));
        }
      }
    }
    return out;
  }

  function resultBox(from) {
    var section = from.closest(".actions") || document;
    return section.querySelector(".dispatch-result") || document.querySelector(".dispatch-result");
  }

  function show(box, kind, message, extra) {
    if (!box) return;
    box.className = "dispatch-result " + (kind === "ok" ? "is-ok" : "is-err");
    box.textContent = message;
    if (extra) {
      var pre = document.createElement("pre");
      pre.textContent = extra;
      box.appendChild(pre);
    }
  }

  function post(url, payload) {
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload || {}),
    }).then(function (res) {
      return res.json().then(function (body) {
        return { ok: res.ok, status: res.status, body: body };
      });
    });
  }

  function currentFlowId() {
    var el = document.querySelector("[data-flow]");
    return el ? el.getAttribute("data-flow") : null;
  }

  function selectedFindings() {
    return Array.prototype.slice
      .call(document.querySelectorAll(".f-pick:checked"))
      .map(function (i) { return i.value; });
  }

  // ---------------------------------------------------------------- buttons

  document.addEventListener("click", function (event) {
    var btn = event.target.closest(".pv-btn");
    if (btn && btn.hasAttribute("data-copy")) {
      var pre = document.querySelector("pre.copyme");
      if (pre && navigator.clipboard) {
        navigator.clipboard.writeText(pre.textContent).then(function () {
          btn.textContent = s("copied");
          setTimeout(function () { btn.textContent = s("copy"); }, 1600);
        });
      }
      return;
    }

    if (btn && btn.getAttribute("data-mode")) {
      event.preventDefault();
      if (busy) return;
      dispatch(btn);
      return;
    }

    var set = event.target.closest(".f-set");
    if (set) {
      event.preventDefault();
      triage(set);
    }
  });

  function dispatch(btn) {
    var mode = btn.getAttribute("data-mode");
    var box = resultBox(btn);
    var payload = {};
    var endpoint = mode;

    if (mode === "fix-selected" || mode === "fix-all") {
      endpoint = "fix-findings";
      if (mode === "fix-all") {
        payload.all = true;
      } else {
        payload.findingIds = selectedFindings();
        if (!payload.findingIds.length) {
          show(box, "err", s("pickOne"));
          return;
        }
      }
    } else if (mode === "walkthrough") {
      // A commit page's button carries its sha; the uncommitted page's carries
      // none, and the absence IS the payload: no sha means the working tree.
      var sha = btn.getAttribute("data-sha");
      if (sha) payload.sha = sha;
    } else {
      var flowId = currentFlowId();
      if (flowId) payload.flowId = flowId;
    }

    busy = true;
    btn.disabled = true;
    var label = btn.textContent;
    btn.textContent = s("dispatching");
    show(box, "ok", s("composing"));

    post("/api/prompt/" + endpoint, payload)
      .then(function (res) {
        if (!res.ok) {
          // Prefer a translated message keyed by the server's `code`. Falling
          // straight through to `error` handed a Portuguese page an English
          // sentence, which a screenshot caught before any test did.
          var body = res.body || {};
          var text = body.code && COPY[LANG]["err." + body.code]
            ? s("err." + body.code, { instance: body.instance || "?" })
            : body.error || s("failed");
          show(box, "err", text, body.prompt);
          return;
        }
        if (res.body.duplicate) {
          // Not an error and not a new card: the work is already queued. Saying
          // "card created" here would invite pressing again.
          show(box, "ok", s("cardExists", { id: res.body.cardId || "?" }), res.body.prompt);
          return;
        }
        if (res.body.transport === "chat") {
          show(box, "ok", s("answer"), res.body.reply || s("noReply"));
        } else {
          show(
            box,
            "ok",
            res.body.cardId ? s("cardMade", { id: res.body.cardId }) : s("cardMadeNoId"),
            res.body.prompt
          );
        }
      })
      .catch(function (err) {
        show(box, "err", s("failedWith") + err.message);
      })
      .then(function () {
        busy = false;
        btn.disabled = false;
        btn.textContent = label;
      });
  }

  function triage(btn) {
    var id = btn.getAttribute("data-id");
    var status = btn.getAttribute("data-status");
    var row = btn.closest("tr");
    btn.disabled = true;
    fetch("/api/findings/" + encodeURIComponent(id), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: status }),
    })
      .then(function (res) { return res.json(); })
      .then(function (body) {
        btn.disabled = false;
        if (!body || body.error) return;
        if (row) {
          row.className = row.className.replace(/st-[a-z]+/, "st-" + status);
          var cell = row.querySelector(".f-status .st");
          if (cell) cell.textContent = status;
        }
      })
      .catch(function () { btn.disabled = false; });
  }

  // ---------------------------------------------------------------- keyboard

  // Stepping through states one by one is the primary reading motion, so it gets
  // arrow keys. Ignored while typing so it never fights a text field.
  document.addEventListener("keydown", function (event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    var tag = (event.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || event.target.isContentEditable) return;

    if (event.key === "ArrowRight" || event.key === "j") {
      var next = document.querySelector(".statenav a.next");
      if (next) { window.location.href = next.href; }
    } else if (event.key === "ArrowLeft" || event.key === "k") {
      var prev = document.querySelector(".statenav a.prev");
      if (prev) { window.location.href = prev.href; }
    } else if (event.key === "e") {
      // Expand every collapsed step at once — the "show me everything" escape
      // hatch, so a folded step is never a dead end for a human either.
      Array.prototype.forEach.call(document.querySelectorAll("details.step-fold"), function (d) {
        d.open = true;
      });
    }
  });
})();
