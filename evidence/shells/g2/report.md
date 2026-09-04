# G2 evidence - listers, hook install, index publish, origin guard, manifest

Captured 2026-09-03 on dev-madrid, live prod (port 8777), after two redeploys (the second fixing F-002).

## vitest (full shells + dev-env + guard family)
```
   ✓ host-tunnel supervisor > replaces a host that is alive but hosting nothing 7007ms
   ✓ host-tunnel supervisor > leaves a working host alone 7012ms
   ✓ host-tunnel supervisor > stops replacing the host once the credential under it lapses 8007ms
   ✓ host-tunnel supervisor > refuses to loop forever on the one prerequisite it cannot fix 3504ms

 Test Files  25 passed (25)
      Tests  214 passed (214)
   Start at  19:23:13
   Duration  31.23s (transform 2.17s, setup 782ms, collect 7.23s, tests 97.74s, environment 8ms, prepare 2.67s)

```

## typecheck + lint: clean

## fitting probe
```
ok
exit=0
```

## live prod
```
GET /health
{
    "ok": true,
    "port": 8098,
    "pid": 1199921,
    "transports": [
        "csg",
        "local"
    ],
    "tunnels": {
        "peaceful-ocean-zcx3mqx.eun1": {
            "carrying": false,
            "state": "refused",
            "lastOkAt": null,
            "lastProbeAt": "2026-09-03T18:23:28.772Z",
            "probeReason": "connect ECONNREFUSED 127.0.0.1:2222",
            "misses": 1,
            "service": {
                "ok": true,
                "hostConnections": 0,
                "ports": [
                    2222
                ]
            },
            "parked": {
                "reason": "unhosted",
                "since": "2026-09-03T18:22:10.090Z",
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

GET /index (row count + first 8)
node: dev-madrid
shellOrigin: {'loopback': 'http://127.0.0.1:8098', 'public': 'https://dev-madrid.tail31efa.ts.net:8498'}
rows: 50
  working registry claude cli garrison
  idle registry claude cli pnmui-mon
  idle registry claude cli ekoa-code
  idle registry claude cli ekoa-dev
  idle registry claude cli 28-palavras
  idle pane shell shell pnmui-monorepo
  idle pane shell shell pnmui-monorepo
  idle pane shell shell pnmui-monorepo

real ~/.codex/hooks.json event groups:
['PreCompact', 'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop']
real ~/.gemini/settings.json hook groups:
['BeforeAgent', 'AfterAgent', 'SessionStart', 'SessionEnd']
```

## F-001 / F-002 (found and fixed live during this gate)
See evidence/shells/PROGRESS.md Open findings F-001 and F-002 for the full account.
