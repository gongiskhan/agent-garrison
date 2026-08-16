import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

// Offline SpawnedProcess fixture for the pinned Agent SDK wrapper. It speaks the
// SDK/CLI newline-delimited control protocol without launching Claude or touching
// the network: normal turn, interrupted turn, then a reusable later turn whose
// permission request is answered by the SDK callback.
export class FakeAgentSdkStandingProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.killed = false;
    this.exitCode = null;
    this.inputEnded = false;
    this.framesFromSdk = [];
    this.userMessages = [];
    this.controlSubtypes = [];
    this.permissionResponse = null;
    this._buffer = "";
    this._turn = 0;
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        try {
          this._ingest(String(chunk));
          callback();
        } catch (error) {
          callback(error);
        }
      }
    });
    this.stdin.once("finish", () => {
      this.inputEnded = true;
    });
  }

  kill(signal = "SIGTERM") {
    if (this.killed || this.exitCode !== null) return false;
    this.killed = true;
    this.exitCode = 0;
    this.stdout.end();
    queueMicrotask(() => this.emit("exit", 0, signal));
    return true;
  }

  _ingest(chunk) {
    this._buffer += chunk;
    for (;;) {
      const newline = this._buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this._buffer.slice(0, newline).trim();
      this._buffer = this._buffer.slice(newline + 1);
      if (!line) continue;
      this._handle(JSON.parse(line));
    }
  }

  _emit(frame) {
    this.stdout.write(`${JSON.stringify(frame)}\n`);
  }

  _success(requestId, response = {}) {
    this._emit({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response }
    });
  }

  _handle(frame) {
    this.framesFromSdk.push(frame);
    if (frame?.type === "control_request") {
      const subtype = frame.request?.subtype;
      this.controlSubtypes.push(subtype);
      if (subtype === "initialize") {
        this._success(frame.request_id, {
          commands: [],
          agents: [],
          output_style: "default",
          available_output_styles: [],
          models: [],
          account: {}
        });
      } else if (subtype === "interrupt") {
        this._success(frame.request_id);
        this._emitTurn(2, { result: "partial two", interrupted: true, includeRunning: false });
      }
      return;
    }
    if (frame?.type === "control_response" && frame.response?.request_id === "permission-control-3") {
      this.permissionResponse = frame.response;
      this._emitTurn(3, { result: "done three", includeRunning: false });
      return;
    }
    if (frame?.type !== "user") return;

    this.userMessages.push(frame);
    this._turn += 1;
    if (this._turn === 1) {
      this._emitTurn(1, { result: "done one" });
    } else if (this._turn === 2) {
      // Leave the turn running until Query.interrupt() crosses the real wrapper's
      // control channel. The resulting Query remains open for turn three.
      this._emit({
        type: "system",
        subtype: "session_state_changed",
        state: "running",
        uuid: "state-running-2",
        session_id: "fixture-session"
      });
    } else if (this._turn === 3) {
      this._emit({
        type: "system",
        subtype: "session_state_changed",
        state: "running",
        uuid: "state-running-3",
        session_id: "fixture-session"
      });
      this._emit({
        type: "control_request",
        request_id: "permission-control-3",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "pwd" },
          permission_suggestions: [{ type: "addRules", destination: "session", rules: ["Bash(pwd)"] }],
          tool_use_id: "tool-3",
          title: "Run pwd?"
        }
      });
    } else {
      throw new Error(`unexpected fixture turn ${this._turn}`);
    }
  }

  _emitTurn(turn, { result, interrupted = false, includeRunning = true }) {
    if (includeRunning) {
      this._emit({
        type: "system",
        subtype: "session_state_changed",
        state: "running",
        uuid: `state-running-${turn}`,
        session_id: "fixture-session"
      });
    }
    this._emit({
      type: "assistant",
      uuid: `assistant-${turn}`,
      session_id: "fixture-session",
      message: { id: `message-${turn}`, role: "assistant", content: [{ type: "text", text: result }] }
    });
    this._emit({
      type: "result",
      subtype: "success",
      uuid: `result-${turn}`,
      session_id: "fixture-session",
      is_error: false,
      result,
      stop_reason: interrupted ? "interrupt" : "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 }
    });
    // The pinned types explicitly permit this after result. It must still arrive
    // before idle is treated as the turn boundary by the adapter.
    this._emit({
      type: "prompt_suggestion",
      uuid: `suggestion-${turn}`,
      session_id: "fixture-session",
      suggestion: `suggestion ${turn}`
    });
    this._emit({
      type: "system",
      subtype: "session_state_changed",
      state: "idle",
      uuid: `state-idle-${turn}`,
      session_id: "fixture-session"
    });
  }
}
