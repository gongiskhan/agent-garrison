# G1 evidence - local transport, runtime catalog, claude-sessions lift

Captured 2026-09-03 on dev-madrid, live prod (port 8777), after npm run node:redeploy.

## vitest
```
[remote-shell] transport "x" has no ssh block — skipped

stdout | tests/remote-shell-runtime.test.ts > live local-ssh attach > attaches, injects input, and settles a turn from the events file
[remote-shell] lifecycle hook updated on localtest

stdout | tests/remote-shell-runtime.test.ts > RemoteShellAdapter against a live server > delegates a turn end to end
[remote-shell] listening on 127.0.0.1:19163 (2 transport(s))

stdout | tests/remote-shell-runtime.test.ts > RemoteShellAdapter against a live server > delegates a turn end to end
[remote-shell] lifecycle hook updated on adp

 ✓ |unit| tests/remote-shell-runtime.test.ts (7 tests) 9907ms
   ✓ live local-ssh attach > attaches, injects input, and settles a turn from the events file 2709ms
   ✓ RemoteShellAdapter against a live server > delegates a turn end to end 7107ms

 Test Files  4 passed (4)
      Tests  40 passed (40)
   Start at  18:51:45
   Duration  11.17s (transform 251ms, setup 76ms, collect 1.34s, tests 10.13s, environment 1ms, prepare 466ms)

```

## typecheck + lint
```
npx tsc --noEmit: clean (no output)
npm run lint: No ESLint warnings or errors
```

## fitting probe
```
ok
exit=0
```

## live prod after redeploy
```
GET /api/mesh/self (head/ahead/behind, composition):
{
    "node": {
        "id": "dev-madrid",
        "name": "dev-madrid",
        "accent": "moss",
        "accentHex": "#4a7d5f",
        "accentInk": "#ffffff",
        "tailnetHost": "dev-madrid.tail31efa.ts.net",
        "createdAt": "2026-08-24T17:25:00Z",
        "source": "file"
    },
    "schemaVersion": {
        "min": 1,
        "max": 2
    },
    "clientVersion": "garrison-node/1",
    "platform": "linux",
    "at": "2026-09-03T17:51:57.132Z",
    "uptimeMs": 133963,
    "composition": {

GET http://127.0.0.1:8098/health
{
    "ok": true,
    "port": 8098,
    "pid": 1108076,
    "transports": [
        "csg",
        "local"
    ],
    "tunnels": {
        "peaceful-ocean-zcx3mqx.eun1": {
            "carrying": false,
            "state": "refused",
            "lastOkAt": null,
            "lastProbeAt": "2026-09-03T17:51:20.208Z",
            "probeReason": "connect ECONNREFUSED 127.0.0.1:2222",
            "misses": 0,
            "service": {
                "ok": true,
                "hostConnections": 0,
                "ports": [
                    2222
                ]
            },
            "parked": {
                "reason": "unhosted",
                "since": "2026-09-03T17:51:22.316Z",
                "message": "nothing is hosting devtunnel peaceful-ocean-zcx3mqx.eun1: the tunnel exists and this box is logged in, but no machine is running `devtunnel host` for it. Start it ON THE REMOTE - `devtunnel host peaceful-ocean-zcx3mqx.eun1` - then retry. Logging in again here changes nothing."
            },
            "repairing": false,
            "backoffUntil": null,
            "child": null,
            "lastError": null
        }
    },
    "sessions": 6,
    "local": {
        "enabled": true,
        "tmux": true
    }
}

GET http://127.0.0.1:8098/transports
{
    "transports": [
        {
            "name": "csg",
            "label": "CSG work",
            "kind": "devtunnel",
            "via": "devtunnel",
            "tunnel": "peaceful-ocean-zcx3mqx.eun1",
            "tmuxSession": "csg",
            "cwd": "~/dev/pnmui-monorepo",
            "projectsRoot": "~/dev",
            "agentCommand": "cursor-agent",
            "routingTarget": "csg-work",
            "forwards": []
        },
        {
            "name": "local",
            "label": "dev-madrid",
            "kind": "local",
            "via": "local",
            "tunnel": null,
            "tmuxSession": "local",
            "cwd": "~",
            "projectsRoot": "~/dev",
            "agentCommand": null,
            "routingTarget": null,
            "forwards": []
        }
    ]
}

GET http://127.0.0.1:8098/runtimes?transport=local
{
    "runtimes": [
        {
            "id": "claude",
            "label": "Claude Code",
            "bin": "claude",
            "available": true,
            "path": "/home/ggomes/.local/bin/claude",
            "resumable": true,
            "attachable": true,
            "checkedAt": "2026-09-03T17:51:57.576Z"
        },
        {
            "id": "codex",
            "label": "Codex",
            "bin": "codex",
            "available": true,
            "path": "/home/ggomes/.local/bin/codex",
            "resumable": true,
            "attachable": false,
            "checkedAt": "2026-09-03T17:51:57.576Z"
        },
        {
            "id": "cursor",
            "label": "Cursor",
            "bin": "cursor-agent",
            "available": false,
            "path": null,
            "resumable": true,
            "attachable": false,
            "checkedAt": "2026-09-03T17:51:57.576Z"
        },
        {
            "id": "gemini",
            "label": "Gemini CLI",
            "bin": "gemini",
            "available": true,
            "path": "/home/ggomes/.nvm/versions/node/v20.19.4/bin/gemini",
            "resumable": true,
            "attachable": false,
            "checkedAt": "2026-09-03T17:51:57.576Z"
        }
    ]
}
```
