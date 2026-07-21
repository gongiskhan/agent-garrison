#!/usr/bin/env python3
"""Garrison outpost-actions CLI — invoke operations on remote outpost machines."""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

OUTPOST_HOST = (
    os.environ.get("GARRISON_OUTPOST_HOST_URL")
    or os.environ.get("OUTPOST_HOST_URL")
    or f"http://127.0.0.1:{os.environ.get('GARRISON_OUTPOST_PORT', '23702')}"
).rstrip("/")
DEFAULT_TIMEOUT_MS = 30000


def _http(method: str, path: str, body=None, timeout_s: float = 30.0):
    url = f"{OUTPOST_HOST}{path}"
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            msg = json.loads(raw).get("error") or raw
        except (json.JSONDecodeError, AttributeError):
            msg = raw[:300]
        raise _BridgeError(msg) from exc
    except urllib.error.URLError as exc:
        raise _HostUnreachable(str(exc)) from exc


def _rpc(name: str, rpc_type: str, payload: dict, timeout_ms: int = DEFAULT_TIMEOUT_MS):
    path = f"/outposts/{urllib.parse.quote(name, safe='')}/rpc"
    result = _http("POST", path, {"type": rpc_type, "payload": payload},
                   timeout_s=timeout_ms / 1000 + 5)
    if not result.get("ok"):
        raise _BridgeError(result.get("error") or f"RPC {rpc_type} failed")
    return result.get("result", {}).get("payload") or {}


def _get_outposts():
    data = _http("GET", "/outposts")
    return data.get("outposts", [])


def _check_machine(name: str):
    """Exit with the correct code if the machine is unknown or offline."""
    try:
        outposts = _get_outposts()
    except _HostUnreachable:
        _die_unreachable()
    names = [o["name"] for o in outposts]
    if name not in names:
        known = ", ".join(names) if names else "(none registered)"
        _die(2, f"unknown outpost: {name!r}  (available: {known})")
    entry = next(o for o in outposts if o["name"] == name)
    if not entry.get("connected"):
        _die(3, f"outpost {name!r} not connected")


def _die(code: int, msg: str):
    print(msg, file=sys.stderr)
    sys.exit(code)


def _die_unreachable():
    _die(5, f"outpost-host unreachable on {OUTPOST_HOST.split('/')[2]}")


class _BridgeError(Exception):
    pass


class _HostUnreachable(Exception):
    pass


# ---------------------------------------------------------------------------
# Subcommand implementations
# ---------------------------------------------------------------------------

def cmd_probe(_args):
    try:
        _http("GET", "/health")
        print("ok")
    except _HostUnreachable:
        _die_unreachable()


def cmd_list_outposts(_args):
    try:
        outposts = _get_outposts()
        print(json.dumps({"outposts": outposts}))
    except _HostUnreachable:
        _die_unreachable()


def cmd_run_on(args):
    machine = args.machine
    command = " ".join(args.command)
    timeout_ms = args.timeout_ms

    _check_machine(machine)
    try:
        result = _rpc(machine, "exec.run", {"command": command, "timeout_ms": timeout_ms},
                      timeout_ms=timeout_ms)
        print(json.dumps({
            "stdout": result.get("stdout", ""),
            "stderr": result.get("stderr", ""),
            "exit_code": result.get("exit_code", 0),
        }))
    except _BridgeError as exc:
        _die(4, str(exc))
    except _HostUnreachable:
        _die_unreachable()


def cmd_read_file_on(args):
    machine = args.machine
    path = args.path

    _check_machine(machine)
    try:
        result = _rpc(machine, "fs.read", {"path": path})
        print(json.dumps({"content": result.get("content", "")}))
    except _BridgeError as exc:
        _die(4, str(exc))
    except _HostUnreachable:
        _die_unreachable()


def cmd_write_file_on(args):
    machine = args.machine
    path = args.path
    content = sys.stdin.read()

    _check_machine(machine)
    try:
        _rpc(machine, "fs.write", {"path": path, "content": content})
        print(json.dumps({"ok": True}))
    except _BridgeError as exc:
        _die(4, str(exc))
    except _HostUnreachable:
        _die_unreachable()


def cmd_list_files_on(args):
    machine = args.machine
    path = args.path

    _check_machine(machine)
    try:
        result = _rpc(machine, "fs.list", {"path": path})
        print(json.dumps({"entries": result.get("entries", [])}))
    except _BridgeError as exc:
        _die(4, str(exc))
    except _HostUnreachable:
        _die_unreachable()


# ---------------------------------------------------------------------------
# Argument parser
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        prog="outpost.py",
        description="Invoke operations on remote Garrison outpost machines.",
    )
    parser.add_argument("--probe", action="store_true",
                        help="Health check — print 'ok' if outpost-host is reachable.")

    sub = parser.add_subparsers(dest="subcommand")

    sub.add_parser("list_outposts", help="List registered outposts and their connection status.")

    p_run = sub.add_parser("run_on", help="Run a command on a remote machine (blocking).")
    p_run.add_argument("machine", help="Outpost machine name.")
    p_run.add_argument("command", nargs="+", help="Command and arguments to run.")
    p_run.add_argument("--timeout-ms", type=int, default=DEFAULT_TIMEOUT_MS, dest="timeout_ms",
                       help="Timeout in milliseconds (default: 30000).")

    p_read = sub.add_parser("read_file_on", help="Read a file from a remote machine.")
    p_read.add_argument("machine", help="Outpost machine name.")
    p_read.add_argument("path", help="Absolute or tilde-prefixed path on the remote machine.")

    p_write = sub.add_parser("write_file_on",
                              help="Write a file on a remote machine (content from stdin).")
    p_write.add_argument("machine", help="Outpost machine name.")
    p_write.add_argument("path", help="Absolute or tilde-prefixed path on the remote machine.")

    p_list = sub.add_parser("list_files_on", help="List files in a directory on a remote machine.")
    p_list.add_argument("machine", help="Outpost machine name.")
    p_list.add_argument("path", help="Absolute or tilde-prefixed directory path.")

    args = parser.parse_args()

    if args.probe:
        cmd_probe(args)
        return

    dispatch = {
        "list_outposts": cmd_list_outposts,
        "run_on": cmd_run_on,
        "read_file_on": cmd_read_file_on,
        "write_file_on": cmd_write_file_on,
        "list_files_on": cmd_list_files_on,
    }

    if args.subcommand is None:
        parser.print_help()
        sys.exit(1)

    dispatch[args.subcommand](args)


if __name__ == "__main__":
    main()
