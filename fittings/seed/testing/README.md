# testing Fitting

Project-aware test runner for Agent Garrison workbench sessions.

## What it does

`run_tests` auto-detects the project type from a given directory and runs
the project's native test command:

| Project type | Detected by | Command |
|---|---|---|
| Node.js | `package.json` | `npm test [-- <pattern>]` |
| Python (pytest) | `pyproject.toml` or `pytest.ini` | `pytest [<pattern>]` |
| Rust | `Cargo.toml` | `cargo test [<pattern>]` |
| Go | `go.mod` | `go test ./...` |

## Contract

Input (stdin JSON):
```json
{ "cwd": "/path/to/project", "pattern": "optional test filter" }
```

Output (stdout JSON):
```json
{
  "project_type": "node",
  "command": "npm test",
  "exit_code": 0,
  "stdout": "...",
  "stderr": "...",
  "duration_ms": 1234
}
```

Non-zero `exit_code` means tests failed — that is expected output, not a
tool error. Timeout is 5 minutes.

## Usage

This Fitting is surfaced as the `run_tests` MCP tool by the `mcp-gateway`
Fitting. It is not called directly from the Operative prompt.
