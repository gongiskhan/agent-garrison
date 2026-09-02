import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { freePort, scratchHome, startTalkApp, type TalkApp } from "./fixtures/talk-app";

// M8 full-stack parity gate for the generated Web thread: the REAL Conversations
// engine mounted in the REAL Garrison shell (/talk, /api/*), the REAL browser
// bundle, and a fake gateway that speaks the canonical session-event protocol
// from fixtures. Everything a terminal session shows must survive the whole path
// (browser -> durable admission -> gateway -> canonical events -> durable thread
// -> render), so these specs assert on BOTH ends: what the page renders and what
// the gateway actually received.
//
// The component-level Chromium suites (tests/claude-chat-session-events-browser)
// cover the renderer in isolation; this one covers the wiring between the real
// processes, including a genuine restart of the process hosting the engine.
//
// One shell process per spec file: a `next dev` boot plus the /talk compile is
// too slow to pay per test, so the tests share the process and the scratch home
// and isolate on the thread each one creates. The fake gateway IS per test - the
// shell reads GARRISON_GATEWAY_URL once at boot, so every gateway binds the same
// port.
//
// Two lanes, deliberately. A thread whose id is a conversation id (every id the
// engine mints, see conversationIdFor in packages/talk/src/threads.mjs) sends
// through the conversation door: POST /api/conversation/<id>/message, forwarded
// to the gateway's /conversation/message, and the gateway is what records and
// answers it. The chat lane - durable admission, /chat/stream session events,
// permission prompts, interrupts, queued inputs, restart recovery - is what the
// parity tests below exercise, and the engine only puts a thread on it when its
// id is NOT a conversation id (a leading underscore). So the harness mints such
// an id for those tests, and the fresh-conversation test covers the door a
// /talk?new=1 thread actually uses.

// A v2 spawn signature is what makes a durable SDK journal resumable across a
// process restart (packages/talk/src/router.mjs: agentSdkResumeFromThread). Anything less is a
// legacy shape that deliberately forces a clean session.
const SPAWN_SIGNATURE = {
  version: 2,
  target: "opus-web",
  runtime: "agent-sdk",
  provider: "anthropic",
  model: "claude-opus-5",
  account: null,
  accountSource: null,
  projectPath: null,
  assembly: `a1:${"ab".repeat(32)}`,
};

// 1x1 transparent PNG - a tool result image small enough to inline in a fixture.
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

interface GatewayTurn {
  body: any;
  res: http.ServerResponse;
  generationId: string;
  sessionId: string;
  index: number;
}

interface PermissionAnswer {
  threadId: string;
  generationId: string;
  requestId: string;
  decision: string;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => resolve(raw));
  });
}

async function waitFor<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, label: string, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last: T = await read();
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)?.slice(0, 400)})`);
}

/**
 * A gateway that speaks the post-M7 contract: one opaque generation per streamed
 * turn, canonical `session_event` frames, an exact-tuple permission answer seam,
 * exact-generation interrupt, and the restart-recovery lookup pair.
 */
class FakeGateway {
  readonly turns: GatewayTurn[] = [];
  readonly interrupts: any[] = [];
  readonly permissionAnswers: PermissionAnswer[] = [];
  /** Bodies admitted through the conversation door (POST /conversation/message). */
  readonly conversationMessages: any[] = [];
  /** Per-test script run right after `open`+`route` are written for a turn. */
  onTurn: ((turn: GatewayTurn) => void | Promise<void>) | null = null;
  /** Per-test script run when a permission decision arrives. */
  onPermission: ((answer: PermissionAnswer) => void | Promise<void>) | null = null;
  server!: http.Server;
  port = 0;

  async listen(port: number): Promise<void> {
    this.server = http.createServer(async (req, res) => {
      const url = req.url ?? "/";
      if (url === "/chat/stream" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const index = this.turns.length;
        const turn: GatewayTurn = {
          body,
          res,
          index,
          generationId: `generation-${index + 1}`,
          // The whole point of resume is that the id can be refined by the
          // provider; keep one id per logical conversation here so the durable
          // chain stays assertable.
          sessionId: typeof body?.agentSdkResume?.sessionId === "string" && body.agentSdkResume.sessionId
            ? body.agentSdkResume.sessionId
            : `sdk-session-${index + 1}`,
        };
        this.turns.push(turn);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(sse("open", { generationId: turn.generationId, ts: Date.now() }));
        res.write(sse("route", {
          route: SPAWN_SIGNATURE.target,
          runtime: SPAWN_SIGNATURE.runtime,
          provider: SPAWN_SIGNATURE.provider,
          model: SPAWN_SIGNATURE.model,
          account: null,
          accountSource: null,
          projectPath: null,
          session_id: turn.sessionId,
          sessionDisposition: body?.agentSdkResume ? "resumed" : "new",
          sessionBoundaryReason: body?.agentSdkResume ? null : "initial",
          sessionEpoch: 1,
          spawnSignature: SPAWN_SIGNATURE,
        }));
        await this.onTurn?.(turn);
        return;
      }
      if (url === "/chat/interrupt" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        this.interrupts.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, generationId: body.generationId }));
        return;
      }
      if (url === "/chat/permission" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        this.permissionAnswers.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        await this.onPermission?.(body);
        return;
      }
      // Restart recovery: an authoritative 404 tells the new Web process the old
      // process's runtime ownership is gone, releasing the queued tail.
      if (url === "/chat/generation" && req.method === "POST") {
        await readBody(req);
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "input_generation_unavailable" }));
        return;
      }
      if (url === "/chat/recover" && req.method === "POST") {
        await readBody(req);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      // The conversation door. The real gateway records the user message in the
      // conversation store and runs a responder stretch; the engine's router
      // writes nothing once the gateway has accepted (recorded: true), so what
      // this fake proves is admission and addressing, not a reply.
      if (url === "/conversation/message" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        this.conversationMessages.push(body);
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ accepted: true, seq: this.conversationMessages.length, pickedUpBy: "responder" }));
        return;
      }
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => resolve());
    });
    this.port = (this.server.address() as net.AddressInfo).port;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  write(turn: GatewayTurn, event: string, data: unknown): void {
    turn.res.write(sse(event, data));
  }

  /** Canonical assistant event carrying the turn/generation coordinates. */
  event(turn: GatewayTurn, id: string, blocks: unknown[], opts: { order?: number; revision?: number; role?: "user" | "assistant" } = {}): void {
    this.write(turn, "session_event", {
      id,
      role: opts.role ?? "assistant",
      ts: Date.now(),
      order: opts.order ?? 0,
      revision: opts.revision ?? 0,
      turnId: turn.body?.inputId ?? null,
      generationId: turn.generationId,
      sessionId: turn.sessionId,
      blocks,
    });
  }

  finish(turn: GatewayTurn, frame: Record<string, unknown>): void {
    this.write(turn, "done", frame);
    turn.res.end();
  }

  async close(): Promise<void> {
    for (const turn of this.turns) {
      try { turn.res.end(); } catch { /* already gone */ }
    }
    // The shell keeps idle keep-alive sockets to us; they must go too or the
    // next test's gateway cannot bind this port.
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

interface Harness {
  gateway: FakeGateway;
  app: TalkApp;
  threadId: string;
  restartApp(): Promise<void>;
  thread(): Promise<any>;
}

let app: TalkApp | null = null;
let gatewayPort = 0;
let harness: Harness | null = null;

test.beforeAll(async () => {
  gatewayPort = await freePort();
  // Scratch GARRISON_HOME: no spec may touch the real ~/.garrison or ~/.claude.
  app = await startTalkApp({
    home: scratchHome("wc-parity-"),
    gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
    port: await freePort(),
  });
});

test.afterAll(async () => {
  if (!app) return;
  await app.stop();
  fs.rmSync(app.home, { recursive: true, force: true });
  app = null;
});

test.beforeEach(async () => {
  const gateway = new FakeGateway();
  await gateway.listen(gatewayPort);
  const base = app!.base;
  // A leading underscore keeps the thread OFF the conversation lane (see the
  // header): these tests drive the chat lane's session-event pipeline.
  const created = await fetch(`${base}/api/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: `_parity-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, title: "Parity", source: "e2e" }),
  }).then((r) => r.json());
  harness = {
    gateway,
    app: app!,
    threadId: created.thread.id,
    async restartApp() {
      await app!.restart();
    },
    async thread() {
      return fetch(`${base}/api/threads/${encodeURIComponent(created.thread.id)}`).then((r) => r.json());
    },
  };
});

test.afterEach(async () => {
  if (!harness) return;
  await harness.gateway.close();
  harness = null;
});

// The shell's deep link to one conversation (the shape notifications and
// Discuss links carry).
function threadUrl(h: Harness): string {
  return `${h.app.base}/talk/${encodeURIComponent(h.threadId)}`;
}

async function sendMessage(page: Page, text: string): Promise<void> {
  await page.locator(".cc-input").fill(text);
  await page.locator(".cc-send").click();
}

test.describe("web channel session parity", () => {
  test("the shell's fresh-conversation entry point mints one thread and settles on a clean address", async ({ page }) => {
    const h = harness!;
    const listIds = async (): Promise<string[]> =>
      (await fetch(`${h.app.base}/api/threads`).then((r) => r.json())).threads.map((t: any) => t.id);
    const before = await listIds();

    // /talk?new=1 is what the shell's "+ New" menu and a peer node's picker open.
    await page.goto(`${h.app.base}/talk?new=1`);
    await expect(page.locator(".cc-input")).toBeVisible();
    // The parameter is consumed on load and dropped from the address bar, so a
    // reload reopens the conversation instead of minting another.
    await expect.poll(() => new URL(page.url()).searchParams.get("new")).toBeNull();
    expect(new URL(page.url()).pathname).toBe("/talk");
    const after = await waitFor(listIds, (ids) => ids.length === before.length + 1, "one fresh thread");
    const [freshId] = after.filter((id) => !before.includes(id));

    await page.reload();
    await expect(page.locator(".cc-input")).toBeVisible();
    expect((await listIds()).length).toBe(before.length + 1);

    // The fresh conversation is live: its first message goes through the
    // conversation door and reaches the gateway addressed to ITS id, and the
    // composer reports admission, not a failure.
    await sendMessage(page, "hello from a fresh conversation");
    await waitFor(() => h.gateway.conversationMessages.length, (n) => n === 1, "message at the conversation door");
    expect(h.gateway.conversationMessages[0]).toMatchObject({ conversationId: freshId, message: "hello from a fresh conversation" });
    expect(h.gateway.turns).toHaveLength(0);
    await expect(page.getByText(/Message failed/)).toHaveCount(0);
  });

  test("streams text, thinking, and a tool call whose result attaches after later text", async ({ page }) => {
    const h = harness!;
    h.gateway.onTurn = async (turn) => {
      const gw = h.gateway;
      gw.event(turn, "evt-thinking", [{ type: "thinking", text: "Checking the fixture file first." }], { order: 0 });
      // Streamed text arrives as revisions of ONE stable event, exactly like the
      // SDK's partial-message deltas.
      gw.event(turn, "evt-text", [{ type: "text", text: "Reading" }], { order: 1, revision: 0 });
      gw.event(turn, "evt-text", [{ type: "text", text: "Reading the fixture" }], { order: 1, revision: 1 });
      gw.event(turn, "evt-tool", [{
        type: "tool_use",
        toolUseId: "toolu_read_1",
        name: "Read",
        input: JSON.stringify({ file_path: "/tmp/fixture.txt" }),
      }], { order: 2 });
      // Later text streams BEFORE the tool result lands: the result must still
      // attach to its own call rather than reordering the transcript.
      gw.event(turn, "evt-text", [{ type: "text", text: "Reading the fixture, then summarising." }], { order: 1, revision: 2 });
      gw.event(turn, "evt-tool-result", [{
        type: "tool_result",
        toolUseId: "toolu_read_1",
        isError: false,
        text: "fixture line one\nfixture line two",
        images: [{ mediaType: "image/png", data: PNG_1PX }],
      }], { order: 3, role: "user" });
      gw.finish(turn, { reply: "The fixture has two lines.", session_id: turn.sessionId });
    };

    await page.goto(threadUrl(h));
    await expect(page.locator(".cc-input")).toBeVisible();
    await sendMessage(page, "Read the fixture file and summarise it.");

    // Thinking is visible (collapsible), not swallowed into an ephemeral hint.
    await expect(page.locator("details.cc-session-thinking, .cc-session-thinking").first())
      .toContainText("Checking the fixture file first.", { timeout: 20_000 });

    // Streamed text landed in its final revision, ONCE - three revisions of one
    // stable event must not become three paragraphs.
    await expect(page.getByText("Reading the fixture, then summarising.", { exact: true })).toHaveCount(1);
    await expect(page.getByText("Reading the fixture", { exact: true })).toHaveCount(0);

    // The tool call renders with its name; the result is inside the disclosure.
    const tool = page.locator("details.cc-session-tool").first();
    await expect(tool).toBeVisible();
    await expect(tool.locator(".cc-session-tool-name")).toHaveText("Read");
    await tool.locator("summary").click();
    await expect(tool.locator(".cc-session-result")).toContainText("fixture line one");
    await expect(tool.locator(".cc-session-pre").first()).toContainText("/tmp/fixture.txt");

    // The base64 image result is offered inline.
    await expect(tool.getByRole("button", { name: /Read result image 1/ })).toBeVisible();

    // The terminal reply is the durable outcome.
    await expect(page.locator(".cc-scroll")).toContainText("The fixture has two lines.");
    const stored = await waitFor(
      () => h.thread(),
      (t: any) => (t?.thread?.messages ?? []).some((m: any) => m.role === "assistant" && m.text.includes("two lines")),
      "durable assistant reply",
    );
    expect((stored.thread.sessionEvents ?? []).map((e: any) => e.id)).toEqual(
      expect.arrayContaining(["evt-thinking", "evt-text", "evt-tool", "evt-tool-result"]),
    );
  });

  test("renders an inline permission prompt, answers it, and delivers the exact decision", async ({ page }) => {
    const h = harness!;
    let pending: GatewayTurn | null = null;
    h.gateway.onTurn = async (turn) => {
      pending = turn;
      h.gateway.event(turn, "evt-text", [{ type: "text", text: "This needs a file write." }], { order: 0 });
      h.gateway.event(turn, `permission:${JSON.stringify([turn.generationId, "req-1"])}`, [{
        type: "permission_request",
        requestId: "req-1",
        generationId: turn.generationId,
        name: "Write",
        displayName: "Write",
        title: "Allow Write?",
        description: "Claude wants to write /tmp/fixture.txt",
        status: "pending",
        input: { file_path: "/tmp/fixture.txt", content: "hello" },
        inputComplete: true,
        suggestions: [{ type: "addRules", behavior: "allow", destination: "projectSettings", rules: [{ toolName: "Write" }] }],
        suggestionsComplete: true,
      }], { order: 1 });
    };
    h.gateway.onPermission = async (answer) => {
      const turn = pending!;
      h.gateway.event(turn, `permission:${JSON.stringify([turn.generationId, "req-1"])}`, [{
        type: "permission_request",
        requestId: "req-1",
        generationId: turn.generationId,
        name: "Write",
        displayName: "Write",
        title: "Allow Write?",
        description: "Claude wants to write /tmp/fixture.txt",
        status: "resolved",
        decision: answer.decision,
        input: { file_path: "/tmp/fixture.txt", content: "hello" },
        inputComplete: true,
        suggestions: [{ type: "addRules", behavior: "allow", destination: "projectSettings", rules: [{ toolName: "Write" }] }],
        suggestionsComplete: true,
      }], { order: 1, revision: 1 });
      h.gateway.finish(turn, { reply: "Wrote the file.", session_id: turn.sessionId });
    };

    await page.goto(threadUrl(h));
    await sendMessage(page, "Write hello into the fixture file.");

    const card = page.locator(".cc-session-permission");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.locator(".cc-session-permission-status")).toHaveText("Awaiting your decision");
    // The exact proposed input is disclosed before approval is offered.
    await expect(card.locator(".cc-session-permission-input")).toContainText("/tmp/fixture.txt");
    await expect(card.getByRole("button", { name: "Allow once" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Always allow" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Deny" })).toBeVisible();

    await card.getByRole("button", { name: "Allow once" }).click();

    // The gateway received the exact tuple, never a browser-supplied input.
    await waitFor(() => h.gateway.permissionAnswers.length, (n) => n === 1, "permission answer at the gateway");
    expect(h.gateway.permissionAnswers[0]).toMatchObject({
      threadId: h.threadId,
      requestId: "req-1",
      decision: "allow_once",
    });
    expect(h.gateway.permissionAnswers[0].generationId).toBe(h.gateway.turns[0].generationId);

    await expect(card.locator(".cc-session-permission-status")).toHaveText("Allowed once");
    await expect(page.locator(".cc-scroll")).toContainText("Wrote the file.");
  });

  test("a pending permission prompt survives a page reload and is still answerable", async ({ page }) => {
    const h = harness!;
    let pending: GatewayTurn | null = null;
    const promptBlock = (turn: GatewayTurn, status: string, decision?: string) => ({
      type: "permission_request",
      requestId: "req-reload",
      generationId: turn.generationId,
      name: "Bash",
      displayName: "Bash",
      title: "Allow Bash?",
      status,
      ...(decision ? { decision } : {}),
      input: { command: "ls /tmp" },
      inputComplete: true,
      suggestions: [],
      suggestionsComplete: false,
    });
    h.gateway.onTurn = async (turn) => {
      pending = turn;
      h.gateway.event(turn, `permission:${JSON.stringify([turn.generationId, "req-reload"])}`, [promptBlock(turn, "pending")], { order: 0 });
    };
    h.gateway.onPermission = async (answer) => {
      const turn = pending!;
      h.gateway.event(turn, `permission:${JSON.stringify([turn.generationId, "req-reload"])}`, [promptBlock(turn, "resolved", answer.decision)], { order: 0, revision: 1 });
      h.gateway.finish(turn, { reply: "Denied, so I stopped.", session_id: turn.sessionId });
    };

    await page.goto(threadUrl(h));
    await sendMessage(page, "List /tmp");
    await expect(page.locator(".cc-session-permission")).toBeVisible({ timeout: 20_000 });

    // Reload: the prompt is durable thread state, not a live-stream artifact.
    await page.reload();
    const card = page.locator(".cc-session-permission");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.locator(".cc-session-permission-status")).toHaveText("Awaiting your decision");
    // Always-allow stays unavailable while the persistent change set is incomplete.
    await expect(card.getByRole("button", { name: "Always allow" })).toHaveCount(0);
    await expect(card.locator(".cc-session-permission-warning")).toContainText("Always allow is unavailable");

    await card.getByRole("button", { name: "Deny" }).click();
    await waitFor(() => h.gateway.permissionAnswers.length, (n) => n === 1, "permission answer after reload");
    expect(h.gateway.permissionAnswers[0]).toMatchObject({ requestId: "req-reload", decision: "deny" });
    await expect(card.locator(".cc-session-permission-status")).toHaveText("Denied");
  });

  test("Stop interrupts the running turn and the thread keeps working afterwards", async ({ page }) => {
    const h = harness!;
    h.gateway.onTurn = async (turn) => {
      if (turn.index === 0) {
        h.gateway.event(turn, "evt-slow", [{ type: "text", text: "Starting a long job…" }], { order: 0 });
        return; // hold the stream open until the interrupt arrives
      }
      h.gateway.event(turn, "evt-second", [{ type: "text", text: "Picking up where we left off." }], { order: 0 });
      h.gateway.finish(turn, { reply: "Picking up where we left off.", session_id: turn.sessionId });
    };

    await page.goto(threadUrl(h));
    await sendMessage(page, "Run the long job.");
    await expect(page.locator(".cc-scroll")).toContainText("Starting a long job", { timeout: 20_000 });

    const stop = page.locator(".cc-stop").first();
    await expect(stop).toBeEnabled({ timeout: 20_000 });
    await stop.click();

    await waitFor(() => h.gateway.interrupts.length, (n) => n === 1, "interrupt at the gateway");
    expect(h.gateway.interrupts[0]).toMatchObject({
      threadId: h.threadId,
      generationId: h.gateway.turns[0].generationId,
    });
    // A real interrupt ends THIS generation; the session/thread is untouched.
    h.gateway.finish(h.gateway.turns[0], { reply: "", stopped_by_user: true, session_id: h.gateway.turns[0].sessionId });

    await waitFor(
      () => h.thread(),
      (t: any) => (t?.pendingInputs ?? t?.thread?.pendingInputs ?? []).length === 0,
      "stopped turn settled",
    );

    // The thread still accepts work: the next message opens a NEW generation.
    await sendMessage(page, "Continue please.");
    await waitFor(() => h.gateway.turns.length, (n) => n === 2, "second generation");
    await expect(page.locator(".cc-scroll")).toContainText("Picking up where we left off.", { timeout: 20_000 });
    expect(h.gateway.turns[1].body.message).toBe("Continue please.");
  });

  test("a message sent mid-turn is queued, shown as queued, and delivered in order", async ({ page }) => {
    const h = harness!;
    h.gateway.onTurn = async (turn) => {
      h.gateway.event(turn, `evt-${turn.index}`, [{ type: "text", text: `answer ${turn.index + 1}` }], { order: 0 });
      if (turn.index > 0) h.gateway.finish(turn, { reply: `answer ${turn.index + 1}`, session_id: turn.sessionId });
    };

    await page.goto(threadUrl(h));
    await sendMessage(page, "first question");
    await expect(page.locator(".cc-scroll")).toContainText("answer 1", { timeout: 20_000 });

    // While the first turn is still open the send control becomes an explicit
    // Queue: the input is admitted durably, never dropped, never overlapped.
    // The control is an arrow icon, so its accessible name carries the meaning.
    await expect(page.locator(".cc-send")).toHaveAttribute("aria-label", "Queue");
    await sendMessage(page, "second question");
    await expect(page.locator(".cc-lifecycle-label").filter({ hasText: "Queued" }).first()).toBeVisible();
    expect(h.gateway.turns.length).toBe(1);

    // The queued input is only dispatched once its predecessor settles.
    h.gateway.finish(h.gateway.turns[0], { reply: "answer 1", session_id: h.gateway.turns[0].sessionId });
    await waitFor(() => h.gateway.turns.length, (n) => n === 2, "queued input dispatched");
    expect(h.gateway.turns[1].body.message).toBe("second question");
    await expect(page.locator(".cc-scroll")).toContainText("answer 2", { timeout: 20_000 });

    const stored = await waitFor(
      () => h.thread(),
      (t: any) => (t?.thread?.messages ?? []).length === 4,
      "both exchanges persisted",
    );
    expect(stored.thread.messages.map((m: any) => [m.role, m.text])).toEqual([
      ["user", "first question"],
      ["assistant", "answer 1"],
      ["user", "second question"],
      ["assistant", "answer 2"],
    ]);
  });

  test("a shell restart backfills the full history and resumes the session chain", async ({ page }) => {
    const h = harness!;
    h.gateway.onTurn = async (turn) => {
      h.gateway.event(turn, `evt-text-${turn.index}`, [{ type: "text", text: `reply ${turn.index + 1}` }], { order: 0 });
      h.gateway.event(turn, `evt-tool-${turn.index}`, [{
        type: "tool_use",
        toolUseId: `toolu_${turn.index}`,
        name: "Grep",
        input: JSON.stringify({ pattern: "parity" }),
      }], { order: 1 });
      h.gateway.finish(turn, { reply: `reply ${turn.index + 1}`, session_id: turn.sessionId });
    };

    await page.goto(threadUrl(h));
    await sendMessage(page, "before the restart");
    await expect(page.locator(".cc-scroll")).toContainText("reply 1", { timeout: 20_000 });
    await waitFor(
      () => h.thread(),
      (t: any) => (t?.thread?.messages ?? []).length === 2,
      "first exchange persisted",
    );

    // Kill the process the way a redeploy does, then bring it back on the same
    // home + port. Nothing may be orphaned.
    await h.restartApp();

    await page.goto(threadUrl(h));
    // Full backfill: the user turn, the assistant text, and the canonical tool
    // call all come back from durable state - not from the live SSE tail, which
    // died with the old process.
    await expect(page.locator(".cc-scroll")).toContainText("before the restart", { timeout: 20_000 });
    await expect(page.locator(".cc-scroll")).toContainText("reply 1");
    await expect(page.locator("details.cc-session-tool").first().locator(".cc-session-tool-name")).toHaveText("Grep");

    // The next prompt continues the SAME conversation: the server offers the
    // stored SDK session id for native resume instead of starting cold.
    await sendMessage(page, "after the restart");
    await waitFor(() => h.gateway.turns.length, (n) => n === 2, "post-restart turn");
    expect(h.gateway.turns[1].body.agentSdkResume).toMatchObject({
      sessionId: h.gateway.turns[0].sessionId,
      runtime: "agent-sdk",
      route: SPAWN_SIGNATURE.target,
    });
    await expect(page.locator(".cc-scroll")).toContainText("reply 2", { timeout: 20_000 });

    const stored = await waitFor(
      () => h.thread(),
      (t: any) => (t?.thread?.messages ?? []).length === 4,
      "both exchanges after restart",
    );
    expect(stored.thread.sessionIds).toContain(h.gateway.turns[0].sessionId);
  });

  test("the composer stays hittable at every viewport, even with a push notice up", async ({ page }) => {
    const h = harness!;
    await page.goto(threadUrl(h));
    await expect(page.locator(".cc-input")).toBeVisible();
    // Headless Chromium reports notifications as denied, so the "Notifications
    // blocked" pill is up for real here - the same pill that, pinned to the raw
    // viewport bottom, covered the whole composer at phone width.
    await expect(page.locator(".wc-push-notice")).toBeVisible({ timeout: 20_000 });

    // What the user's finger would actually hit at the centre of each control.
    const hits = await page.evaluate(() => {
      const at = (selector: string) => {
        const el = document.querySelector(selector);
        if (!el) return "missing";
        const box = el.getBoundingClientRect();
        const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return el.contains(top) || top === el ? "self" : (top?.className ?? top?.tagName ?? "unknown");
      };
      return { send: at(".cc-send"), input: at(".cc-input") };
    });
    expect(hits).toEqual({ send: "self", input: "self" });

    // And it really is clickable end to end.
    h.gateway.onTurn = async (turn) => {
      h.gateway.event(turn, "evt-notice", [{ type: "text", text: "composer reachable" }], { order: 0 });
      h.gateway.finish(turn, { reply: "composer reachable", session_id: turn.sessionId });
    };
    await sendMessage(page, "hello from a phone");
    await expect(page.locator(".cc-scroll")).toContainText("composer reachable", { timeout: 20_000 });
  });

  test("a rate limit and a runtime failure are surfaced as distinct, actionable events", async ({ page }) => {
    const h = harness!;
    h.gateway.onTurn = async (turn) => {
      h.gateway.event(turn, "evt-limit", [{
        type: "rate_limit",
        status: "allowed_warning",
        rateLimitType: "unified_5h",
        resetsAt: Math.floor(Date.now() / 1000) + 3_600,
        utilization: 92,
      }], { order: 0 });
      h.gateway.event(turn, "evt-error", [{
        type: "error",
        kind: "runtime",
        code: "runtime_crashed",
        source: "runtime",
        text: "The runtime exited before finishing the turn.",
        retryable: true,
      }], { order: 1 });
      h.gateway.finish(turn, { reply: "", error: "runtime crashed", session_id: turn.sessionId });
    };

    await page.goto(threadUrl(h));
    await sendMessage(page, "trigger the limit");

    // Two distinct, separately-labelled notices - not one generic error blob.
    const notices = page.locator(".cc-session-notice-label");
    await expect(notices.filter({ hasText: "Rate limit warning" })).toHaveCount(1, { timeout: 20_000 });
    await expect(page.locator(".cc-session-notice-warning")).toContainText("unified 5h");
    // The limit carries an actionable reset time rather than a bare status. A
    // warning is a one-line trace the reader drills into (only errors open on
    // arrival), so the reset time is attached but folded until the head is
    // clicked.
    const limitNotice = page.locator(".cc-session-notice-warning").filter({ hasText: "Rate limit warning" }).first();
    const resetTime = limitNotice.locator(".cc-session-notice-reset time");
    await expect(resetTime).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/);
    await expect(resetTime).toBeHidden();
    await limitNotice.locator("summary").click();
    await expect(resetTime).toBeVisible();
    await expect(notices.filter({ hasText: "Runtime error" })).toHaveCount(1);
    await expect(page.locator(".cc-session-notice-meta").first()).toContainText("runtime_crashed");
    await expect(page.locator(".cc-scroll")).toContainText("The runtime exited before finishing the turn.");
    // Never a spinner that hangs: the composer is usable again once it settles.
    await expect(page.locator(".cc-send")).toHaveAttribute("aria-label", "Send", { timeout: 20_000 });
  });
});
