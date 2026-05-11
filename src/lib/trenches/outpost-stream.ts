import WebSocket from "ws";

export type OutpostPtyShim = {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (info: { exitCode: number | null; signal: string | null }) => void): void;
  onBridgeStatus(cb: (status: "offline" | "online") => void): void;
  ready: Promise<{ handle: string }>;
};

export function openOutpostPty(opts: {
  outpostHostUrl: string;
  outpostName: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols: number;
  rows: number;
}): OutpostPtyShim {
  const { outpostHostUrl, outpostName, command, args, cwd, env, cols, rows } = opts;
  const url = `${outpostHostUrl}/outposts/${encodeURIComponent(outpostName)}/io`;

  const ws = new WebSocket(url);

  const dataCbs: Array<(data: string) => void> = [];
  const exitCbs: Array<(info: { exitCode: number | null; signal: string | null }) => void> = [];
  const statusCbs: Array<(status: "offline" | "online") => void> = [];

  let readyResolve!: (v: { handle: string }) => void;
  let readyReject!: (err: Error) => void;
  const ready = new Promise<{ handle: string }>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });

  let spawned = false;

  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        type: "spawn",
        command,
        args: args ?? [],
        cwd: cwd ?? undefined,
        env: env ?? {},
        cols,
        rows,
      })
    );
  });

  ws.on("message", (data: Buffer | string, isBinary: boolean) => {
    if (!spawned) {
      let msg: { type: string; handle?: string; code?: string; message?: string };
      try {
        msg = JSON.parse(data.toString("utf8")) as typeof msg;
      } catch {
        readyReject(new Error("invalid spawn response from outpost-host"));
        ws.close();
        return;
      }

      if (msg.type === "spawn_ok" && msg.handle) {
        spawned = true;
        readyResolve({ handle: msg.handle });
      } else if (msg.type === "spawn_error") {
        readyReject(new Error(`${msg.code ?? "operation_failed"}: ${msg.message ?? "spawn failed"}`));
        ws.close();
      } else {
        readyReject(new Error(`unexpected frame before spawn_ok: ${msg.type}`));
        ws.close();
      }
      return;
    }

    // Post-spawn frames are JSON control frames from the broker
    let frame: { type: string; payload?: Record<string, unknown> };
    try {
      frame = JSON.parse((isBinary ? (data as Buffer) : data).toString("utf8")) as typeof frame;
    } catch {
      return;
    }

    if (frame.type === "process.output" && frame.payload) {
      const b64 = frame.payload.data as string;
      if (b64) {
        const str = Buffer.from(b64, "base64").toString("utf8");
        for (const cb of dataCbs) cb(str);
      }
    } else if (frame.type === "process.exit") {
      const exitCode = (frame.payload?.exit_code ?? null) as number | null;
      const signal = (frame.payload?.signal ?? null) as string | null;
      for (const cb of exitCbs) cb({ exitCode, signal });
      ws.close();
    } else if (frame.type === "bridge_disconnected") {
      for (const cb of statusCbs) cb("offline");
    } else if (frame.type === "bridge_reconnected") {
      for (const cb of statusCbs) cb("online");
    }
  });

  ws.on("close", (_code: number, reason: Buffer) => {
    if (!spawned) {
      readyReject(new Error(`outpost-host closed before spawn_ok: ${reason.toString()}`));
    }
  });

  ws.on("error", (err: Error) => {
    if (!spawned) readyReject(err);
  });

  return {
    ready,
    write(data: string) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(Buffer.from(data, "utf8"));
      }
    },
    resize(c: number, r: number) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: c, rows: r }));
      }
    },
    kill(_signal?: string) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "kill" }));
        ws.close();
      }
    },
    onData(cb) {
      dataCbs.push(cb);
    },
    onExit(cb) {
      exitCbs.push(cb);
    },
    onBridgeStatus(cb) {
      statusCbs.push(cb);
    },
  };
}
