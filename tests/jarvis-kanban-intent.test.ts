import { describe, it, expect } from "vitest";
import { parseKanbanIntent } from "../fittings/seed/jarvis-os/ui/kanban-intent";

describe("parseKanbanIntent — create", () => {
  it("recognises PT create phrasings and extracts the card text", () => {
    expect(parseKanbanIntent("cria um card para arranjar o login")).toEqual({
      kind: "create",
      text: "arranjar o login"
    });
    expect(parseKanbanIntent("nova tarefa: rever o parser de rotas")).toEqual({
      kind: "create",
      text: "rever o parser de rotas"
    });
    expect(parseKanbanIntent("adiciona uma tarefa arranjar o deep-link")).toEqual({
      kind: "create",
      text: "arranjar o deep-link"
    });
    expect(parseKanbanIntent("novo card sobre o bug do orb")).toEqual({
      kind: "create",
      text: "o bug do orb"
    });
  });

  it("recognises EN create phrasings", () => {
    expect(parseKanbanIntent("create a task fix the tailscale mapping")).toEqual({
      kind: "create",
      text: "fix the tailscale mapping"
    });
    expect(parseKanbanIntent("add a card to update the docs")).toEqual({
      kind: "create",
      text: "update the docs"
    });
    expect(parseKanbanIntent("new todo wire the panel")).toEqual({
      kind: "create",
      text: "wire the panel"
    });
  });

  it("strips trailing punctuation from the card text", () => {
    expect(parseKanbanIntent("cria uma tarefa arranjar o login.")).toEqual({
      kind: "create",
      text: "arranjar o login"
    });
  });

  it("handles clitic pronouns and leading filler", () => {
    expect(parseKanbanIntent("cria-me um card para testar o login")).toEqual({
      kind: "create",
      text: "testar o login"
    });
    expect(parseKanbanIntent("por favor cria uma tarefa arranjar o build")).toEqual({
      kind: "create",
      text: "arranjar o build"
    });
  });

  it("falls through (null) when a create verb has no card body", () => {
    expect(parseKanbanIntent("cria uma tarefa")).toBeNull();
    expect(parseKanbanIntent("novo card")).toBeNull();
  });
});

describe("parseKanbanIntent — advance", () => {
  it("recognises advance/start phrasings and extracts the title fragment", () => {
    expect(parseKanbanIntent("avança o card do login")).toEqual({ kind: "advance", query: "login" });
    expect(parseKanbanIntent("começa a tarefa arranjar o build")).toEqual({ kind: "advance", query: "arranjar o build" });
    expect(parseKanbanIntent("start the card deep-link")).toEqual({ kind: "advance", query: "deep-link" });
  });
  it("falls through when no title is given", () => {
    expect(parseKanbanIntent("avança o card")).toBeNull();
  });
  it("does not collide with create", () => {
    expect(parseKanbanIntent("cria um card para o login")?.kind).toBe("create");
  });
});

describe("parseKanbanIntent — summary", () => {
  it("recognises board-status queries (PT + EN)", () => {
    expect(parseKanbanIntent("qual é o estado das tarefas?")).toEqual({ kind: "summary" });
    expect(parseKanbanIntent("o que está o sistema a fazer")).toEqual({ kind: "summary" });
    expect(parseKanbanIntent("que tarefas estão a correr")).toEqual({ kind: "summary" });
    expect(parseKanbanIntent("what's running right now")).toEqual({ kind: "summary" });
    expect(parseKanbanIntent("resumo das tarefas")).toEqual({ kind: "summary" });
  });
});

describe("parseKanbanIntent — fall-through", () => {
  it("returns null for ordinary chat that must reach the orchestrator", () => {
    expect(parseKanbanIntent("o que achas do sistema de login?")).toBeNull();
    expect(parseKanbanIntent("corre o typecheck e diz-me se está limpo")).toBeNull();
    expect(parseKanbanIntent("olá jarvis, que horas são?")).toBeNull();
    expect(parseKanbanIntent("")).toBeNull();
  });

  it("does not hijack ordinary chat that merely mentions a task", () => {
    // Bare "que tarefa…" without a status keyword must fall through, not be read
    // as a board-summary command.
    expect(parseKanbanIntent("não sei que tarefa me deram no trabalho")).toBeNull();
    expect(parseKanbanIntent("explica-me que tarefa faz esta função")).toBeNull();
  });
});
