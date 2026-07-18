#!/usr/bin/env python3
"""vault-sync — host→outpost directory mirror over the Garrison Outpost Protocol."""
import argparse
import base64
import fnmatch
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

OUTPOST_HOST = (
    os.environ.get("GARRISON_OUTPOST_HOST_URL")
    or os.environ.get("OUTPOST_HOST_URL")
    or f"http://127.0.0.1:{os.environ.get('GARRISON_OUTPOST_PORT', '23702')}"
).rstrip("/")
MAX_WARN_BYTES = 5 * 1024 * 1024  # warn on files > 5 MB
DEFAULT_INTERVAL_S = 60

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def load_config() -> dict:
    source_dir = os.environ.get("GARRISON_VAULT_SYNC_SOURCE_DIR", "")
    target_outposts = os.environ.get("GARRISON_VAULT_SYNC_TARGET_OUTPOSTS", "")
    target_dir = os.environ.get("GARRISON_VAULT_SYNC_TARGET_DIR", "")
    interval_s = int(os.environ.get("GARRISON_VAULT_SYNC_INTERVAL", str(DEFAULT_INTERVAL_S)))
    ignore_raw = os.environ.get(
        "GARRISON_VAULT_SYNC_IGNORE", ".git/**,.obsidian/workspace*,*.tmp"
    )
    return {
        "source_dir": os.path.expanduser(source_dir),
        "target_outposts": [o.strip() for o in target_outposts.split(",") if o.strip()],
        "target_dir": target_dir,
        "interval_s": interval_s,
        "ignore_patterns": [p.strip() for p in ignore_raw.split(",") if p.strip()],
    }


# ---------------------------------------------------------------------------
# Outpost HTTP helpers
# ---------------------------------------------------------------------------

def _http(method: str, path: str, body=None, timeout_s: float = 60.0):
    url = f"{OUTPOST_HOST}{path}"
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        return json.loads(resp.read())


def _rpc(name: str, rpc_type: str, payload: dict, timeout_s: float = 60.0) -> dict:
    path = f"/outposts/{urllib.parse.quote(name, safe='')}/rpc"
    result = _http("POST", path, {"type": rpc_type, "payload": payload}, timeout_s=timeout_s + 5)
    if not result.get("ok"):
        raise RuntimeError(result.get("error") or f"RPC {rpc_type} failed")
    return result.get("result", {}).get("payload") or {}


def get_outposts() -> list:
    data = _http("GET", "/outposts")
    return data.get("outposts", [])


# ---------------------------------------------------------------------------
# Manifest helpers
# ---------------------------------------------------------------------------

def _matches_ignore(relpath: str, patterns: list) -> bool:
    for pat in patterns:
        if fnmatch.fnmatch(relpath, pat):
            return True
        parts = relpath.split(os.sep)
        for i in range(len(parts)):
            partial = os.sep.join(parts[:i + 1])
            if fnmatch.fnmatch(partial, pat.rstrip("/**")):
                return True
    return False


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def build_local_manifest(source_dir: str, ignore_patterns: list,
                          cache: dict) -> dict:
    manifest = {}
    for root, dirs, files in os.walk(source_dir):
        dirs[:] = [d for d in dirs if not _matches_ignore(
            os.path.relpath(os.path.join(root, d), source_dir), ignore_patterns
        )]
        for fname in files:
            abs_path = os.path.join(root, fname)
            relpath = os.path.relpath(abs_path, source_dir)
            if _matches_ignore(relpath, ignore_patterns):
                continue
            try:
                st = os.stat(abs_path)
            except OSError:
                continue
            cache_key = f"{relpath}|{st.st_size}|{st.st_mtime}"
            sha = cache.get(cache_key)
            if sha is None:
                sha = _sha256(abs_path)
                cache[cache_key] = sha
            manifest[relpath] = {"size": st.st_size, "mtime": st.st_mtime, "sha256": sha}
    return manifest


def build_remote_manifest(outpost_name: str, remote_dir: str) -> dict:
    """Build a remote manifest using exec.run + find (one round-trip)."""
    cmd = (
        f"find {remote_dir} -type f -print0 2>/dev/null | "
        f"xargs -0 stat -f '%N|%z|%m' 2>/dev/null || true"
    )
    try:
        result = _rpc(outpost_name, "exec.run", {
            "command": cmd,
            "cwd": remote_dir,
            "timeout_ms": 30000,
        })
        output = result.get("stdout", "")
    except Exception as exc:
        print(f"[vault-sync] remote manifest build error ({outpost_name}): {exc}",
              file=sys.stderr)
        return {}

    manifest = {}
    for line in output.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            abs_path, size_s, mtime_s = line.rsplit("|", 2)
            relpath = os.path.relpath(abs_path, remote_dir)
            manifest[relpath] = {"size": int(size_s), "mtime": float(mtime_s)}
        except (ValueError, TypeError):
            continue
    return manifest


# ---------------------------------------------------------------------------
# Sync one outpost
# ---------------------------------------------------------------------------

def sync_outpost(outpost_name: str, source_dir: str, remote_dir: str,
                 local_manifest: dict) -> dict:
    stats = {"uploaded": 0, "deleted": 0, "skipped": 0, "failed": 0, "error": None}

    try:
        remote_manifest = build_remote_manifest(outpost_name, remote_dir)
    except Exception as exc:
        stats["error"] = str(exc)
        return stats

    local_relpaths = set(local_manifest.keys())
    remote_relpaths = set(remote_manifest.keys())

    to_upload = set()
    to_delete = remote_relpaths - local_relpaths

    for relpath, linfo in local_manifest.items():
        rinfo = remote_manifest.get(relpath)
        if rinfo is None:
            to_upload.add(relpath)
        elif linfo["size"] != rinfo["size"] or abs(linfo["mtime"] - rinfo["mtime"]) > 1.0:
            to_upload.add(relpath)
        else:
            stats["skipped"] += 1

    for relpath in to_delete:
        remote_path = os.path.join(remote_dir, relpath)
        try:
            _rpc(outpost_name, "fs.delete", {"path": remote_path})
            stats["deleted"] += 1
        except Exception as exc:
            print(f"[vault-sync] delete failed {relpath}: {exc}", file=sys.stderr)
            stats["failed"] += 1

    for relpath in to_upload:
        local_path = os.path.join(source_dir, relpath)
        remote_path = os.path.join(remote_dir, relpath)
        try:
            with open(local_path, "rb") as f:
                raw = f.read()
            if len(raw) > MAX_WARN_BYTES:
                print(f"[vault-sync] large file ({len(raw) // 1024} KB): {relpath}",
                      file=sys.stderr)
            try:
                content = raw.decode("utf-8")
                encoding = "utf-8"
            except UnicodeDecodeError:
                content = base64.b64encode(raw).decode("ascii")
                encoding = "base64"
            _rpc(outpost_name, "fs.write", {
                "path": remote_path,
                "content": content,
                "encoding": encoding,
            })
            stats["uploaded"] += 1
        except Exception as exc:
            print(f"[vault-sync] upload failed {relpath}: {exc}", file=sys.stderr)
            stats["failed"] += 1

    return stats


# ---------------------------------------------------------------------------
# Status file
# ---------------------------------------------------------------------------

_GARRISON_DIR = os.path.expanduser(os.environ.get("GARRISON_HOME", "~/.garrison"))
STATUS_PATH = os.path.join(_GARRISON_DIR, "vault-sync-status.json")
CACHE_PATH = os.path.join(_GARRISON_DIR, "vault-sync-cache.json")


def read_status() -> dict:
    try:
        with open(STATUS_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def write_status(status: dict):
    os.makedirs(_GARRISON_DIR, exist_ok=True)
    tmp = STATUS_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(status, f, indent=2)
    os.replace(tmp, STATUS_PATH)


def read_cache() -> dict:
    try:
        with open(CACHE_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def write_cache(cache: dict):
    os.makedirs(_GARRISON_DIR, exist_ok=True)
    tmp = CACHE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cache, f)
    os.replace(tmp, CACHE_PATH)


# ---------------------------------------------------------------------------
# One tick
# ---------------------------------------------------------------------------

def run_once(config: dict) -> int:
    source_dir = config["source_dir"]
    target_outposts = config["target_outposts"]
    ignore_patterns = config["ignore_patterns"]

    if not source_dir:
        print("[vault-sync] GARRISON_VAULT_SYNC_SOURCE_DIR is not set", file=sys.stderr)
        return 1
    if not target_outposts:
        print("[vault-sync] GARRISON_VAULT_SYNC_TARGET_OUTPOSTS is not set", file=sys.stderr)
        return 1
    if not os.path.isdir(source_dir):
        print(f"[vault-sync] source_dir does not exist: {source_dir}", file=sys.stderr)
        return 1

    target_dir = config["target_dir"] or source_dir

    # Check which outposts are connected.
    try:
        outpost_list = get_outposts()
    except (urllib.error.URLError, OSError) as exc:
        print(f"[vault-sync] outpost-host unreachable: {exc}", file=sys.stderr)
        return 0  # don't fail the scheduler tick

    connected = {o["name"] for o in outpost_list if o.get("connected")}
    reachable = [n for n in target_outposts if n in connected]
    unreachable = [n for n in target_outposts if n not in connected]

    if unreachable:
        print(f"[vault-sync] skipping disconnected outposts: {', '.join(unreachable)}",
              file=sys.stderr)

    if not reachable:
        return 0  # nothing to do this tick

    cache = read_cache()
    local_manifest = build_local_manifest(source_dir, ignore_patterns, cache)
    write_cache(cache)

    status = read_status()
    success_count = 0

    with ThreadPoolExecutor(max_workers=min(4, len(reachable))) as pool:
        futures = {
            pool.submit(sync_outpost, name, source_dir, target_dir, local_manifest): name
            for name in reachable
        }
        for fut in as_completed(futures):
            name = futures[fut]
            try:
                stats = fut.result()
            except Exception as exc:
                stats = {"uploaded": 0, "deleted": 0, "skipped": 0, "failed": 0,
                         "error": str(exc)}

            stats["lastSyncAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            status[name] = stats
            print(
                f"[vault-sync] {name}: "
                f"up={stats['uploaded']} del={stats['deleted']} "
                f"skip={stats['skipped']} fail={stats['failed']}"
                + (f" error={stats['error']}" if stats.get("error") else "")
            )
            if stats["failed"] == 0 and not stats.get("error"):
                success_count += 1

    write_status(status)
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def cmd_probe(_args):
    config = load_config()
    errors = []
    if not config["source_dir"]:
        errors.append("GARRISON_VAULT_SYNC_SOURCE_DIR not set")
    if not config["target_outposts"]:
        errors.append("GARRISON_VAULT_SYNC_TARGET_OUTPOSTS not set")
    if errors:
        for e in errors:
            print(e, file=sys.stderr)
        sys.exit(1)
    print("ok")


def cmd_once(_args):
    config = load_config()
    sys.exit(run_once(config))


def cmd_daemon(_args):
    config = load_config()
    interval = config["interval_s"]
    print(f"[vault-sync] daemon starting; interval={interval}s")
    while True:
        run_once(config)
        time.sleep(interval)


def main():
    parser = argparse.ArgumentParser(prog="sync.py", description="vault-sync CLI")
    parser.add_argument("--probe", action="store_true",
                        help="Validate config and exit 0/1.")

    sub = parser.add_subparsers(dest="subcommand")
    sub.add_parser("once", help="Run one sync tick.")
    sub.add_parser("daemon", help="Run continuously (for manual debugging).")

    args = parser.parse_args()

    if args.probe:
        cmd_probe(args)
        return

    if args.subcommand == "once":
        cmd_once(args)
    elif args.subcommand == "daemon":
        cmd_daemon(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
