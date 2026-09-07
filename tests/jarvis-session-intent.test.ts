import { describe, it, expect } from "vitest";
import { parseSessionIntent } from "../fittings/seed/jarvis-os/ui/session-intent";

describe("parseSessionIntent — switch", () => {
  it("recognises PT switch phrasings and returns the index query", () => {
    expect(parseSessionIntent("muda para a sessão 2")).toEqual({ kind: "switch", query: "2" });
    expect(parseSessionIntent("vai para a sessão 3")).toEqual({ kind: "switch", query: "3" });
    expect(parseSessionIntent("foca na sessão 1")).toEqual({ kind: "switch", query: "1" });
    expect(parseSessionIntent("troca de sessão para a 4")).toEqual({ kind: "switch", query: "4" });
  });

  it("maps spoken ordinals to an index", () => {
    expect(parseSessionIntent("muda para a segunda sessão")).toEqual({ kind: "switch", query: "2" });
    expect(parseSessionIntent("vai para a primeira sessão")).toEqual({ kind: "switch", query: "1" });
  });

  it("recognises a bare 'sessão N' address", () => {
    expect(parseSessionIntent("sessão 2")).toEqual({ kind: "switch", query: "2" });
    expect(parseSessionIntent("sessão dois")).toEqual({ kind: "switch", query: "2" });
  });

  it("keeps a name fragment as the query when it isn't an index", () => {
    expect(parseSessionIntent("muda para a sessão do projeto login")).toEqual({ kind: "switch", query: "login" });
    expect(parseSessionIntent("vai para a sessão agent-garrison")).toEqual({ kind: "switch", query: "agent-garrison" });
  });

  it("recognises EN switch phrasings", () => {
    expect(parseSessionIntent("switch to session 2")).toEqual({ kind: "switch", query: "2" });
    expect(parseSessionIntent("go to the session login")).toEqual({ kind: "switch", query: "login" });
  });
});

describe("parseSessionIntent — create", () => {
  it("recognises PT create phrasings (no project = current workspace)", () => {
    expect(parseSessionIntent("cria uma sessão nova")).toEqual({ kind: "create", project: "" });
    expect(parseSessionIntent("abre uma sessão")).toEqual({ kind: "create", project: "" });
    expect(parseSessionIntent("nova sessão")).toEqual({ kind: "create", project: "" });
  });

  it("extracts a project fragment when named", () => {
    expect(parseSessionIntent("cria uma sessão para o projeto garrison")).toEqual({ kind: "create", project: "garrison" });
    expect(parseSessionIntent("abre uma sessão nova no login")).toEqual({ kind: "create", project: "login" });
  });

  it("recognises EN create phrasings", () => {
    expect(parseSessionIntent("new session")).toEqual({ kind: "create", project: "" });
    expect(parseSessionIntent("create a session for the docs")).toEqual({ kind: "create", project: "docs" });
  });
});

describe("parseSessionIntent — switch-off", () => {
  it("recognises 'back to the orchestrator' phrasings", () => {
    expect(parseSessionIntent("volta ao orquestrador")).toEqual({ kind: "switch-off" });
    expect(parseSessionIntent("sai da sessão")).toEqual({ kind: "switch-off" });
    expect(parseSessionIntent("fala com o jarvis")).toEqual({ kind: "switch-off" });
    expect(parseSessionIntent("back to orchestrator")).toEqual({ kind: "switch-off" });
  });
});

describe("parseSessionIntent — passthrough", () => {
  it("returns null for ordinary chat (falls through to dispatch)", () => {
    expect(parseSessionIntent("corre os testes")).toBeNull();
    expect(parseSessionIntent("o que achas da sessão de código que tivemos ontem")).not.toEqual({ kind: "create", project: "" });
    expect(parseSessionIntent("")).toBeNull();
    expect(parseSessionIntent("olá jarvis")).toBeNull();
  });
});
