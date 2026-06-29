#!/usr/bin/env python3
"""artifact-store CLI — write/read/list/link/delete files for any Fitting.

Storage layout:
    <root>/
      <namespace>/
        <filename>            # the artifact bytes
        <filename>.meta.json  # sidecar metadata

Resolution order for <root>:
    1. --root flag (used by tests)
    2. GARRISON_ARTIFACTS_ROOT env var
    3. <composition-dir>/artifacts/  (composition-dir = $(pwd) when invoked
       from the runner; setup hooks pass it through env explicitly)

The id field in the sidecar is the canonical artifact reference; UI and chat
links use garrison://artifacts/<id>. Filenames may collide across
namespaces (intentional — `documents/notes.md` and `voice/notes.md` are
distinct artifacts).
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

DEFAULT_NAMESPACES = ("documents", "automations", "voice")
META_SUFFIX = ".meta.json"


def resolve_root(explicit: Optional[str]) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    env = os.environ.get("GARRISON_ARTIFACTS_ROOT")
    if env:
        return Path(env).expanduser().resolve()
    # Default to <cwd>/artifacts. Verify hooks run with cwd=composition; setup
    # hooks pass GARRISON_ARTIFACTS_ROOT through env so they don't depend on
    # cwd.
    return Path.cwd() / "artifacts"


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def ensure_namespace(root: Path, namespace: str) -> Path:
    if not namespace or "/" in namespace or namespace.startswith("."):
        raise ValueError(f"invalid namespace: {namespace!r}")
    ns = root / namespace
    ns.mkdir(parents=True, exist_ok=True)
    return ns


def safe_filename(name: str) -> str:
    if not name or "/" in name or "\\" in name or name.startswith(".."):
        raise ValueError(f"invalid filename: {name!r}")
    if name.endswith(META_SUFFIX):
        raise ValueError(
            f"filename ends with {META_SUFFIX}; that suffix is reserved for sidecars"
        )
    return name


def iter_sidecars(root: Path) -> Iterable[Path]:
    if not root.exists():
        return []
    return sorted(root.glob(f"*/*{META_SUFFIX}"))


def read_sidecar(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def write_sidecar(path: Path, meta: dict) -> None:
    with path.open("w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2, sort_keys=True)
        fh.write("\n")


def find_by_id(root: Path, artifact_id: str) -> Optional[tuple[Path, Path, dict]]:
    """Return (artifact_path, sidecar_path, meta) for the given id, or None."""
    for sidecar in iter_sidecars(root):
        try:
            meta = read_sidecar(sidecar)
        except (json.JSONDecodeError, OSError):
            continue
        if meta.get("id") == artifact_id:
            artifact_path = sidecar.with_name(sidecar.name[: -len(META_SUFFIX)])
            return artifact_path, sidecar, meta
    return None


def cmd_write(args: argparse.Namespace) -> int:
    root = resolve_root(args.root)
    namespace_dir = ensure_namespace(root, args.namespace)
    filename = safe_filename(args.filename)
    artifact_path = namespace_dir / filename
    sidecar_path = namespace_dir / f"{filename}{META_SUFFIX}"

    body = sys.stdin.buffer.read()
    artifact_path.write_bytes(body)

    if sidecar_path.exists():
        meta = read_sidecar(sidecar_path)
    else:
        meta = {
            "id": uuid.uuid4().hex,
            "created": now_iso()
        }
    meta["filename"] = filename
    meta["namespace"] = args.namespace
    if args.producer:
        meta["producer"] = args.producer
    elif "producer" not in meta:
        meta["producer"] = args.namespace
    if args.title:
        meta["title"] = args.title
    elif "title" not in meta:
        meta["title"] = filename
    mime = args.mime or meta.get("mime")
    if not mime:
        guessed, _ = mimetypes.guess_type(filename)
        mime = guessed or "application/octet-stream"
    meta["mime"] = mime
    meta["updated"] = now_iso()

    write_sidecar(sidecar_path, meta)
    print(meta["id"])
    return 0


def cmd_read(args: argparse.Namespace) -> int:
    root = resolve_root(args.root)
    found = find_by_id(root, args.id)
    if not found:
        print(f"artifact {args.id} not found", file=sys.stderr)
        return 2
    artifact_path, _, _ = found
    sys.stdout.buffer.write(artifact_path.read_bytes())
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    root = resolve_root(args.root)
    rows = []
    since = None
    if args.since:
        since = args.since.strip()
    for sidecar in iter_sidecars(root):
        try:
            meta = read_sidecar(sidecar)
        except (json.JSONDecodeError, OSError):
            continue
        if args.namespace and meta.get("namespace") != args.namespace:
            continue
        if args.producer and meta.get("producer") != args.producer:
            continue
        updated = meta.get("updated") or meta.get("created") or ""
        if since and updated < since:
            continue
        rows.append(meta)
    rows.sort(key=lambda m: m.get("updated") or m.get("created") or "", reverse=True)
    json.dump(rows, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


def cmd_link(args: argparse.Namespace) -> int:
    root = resolve_root(args.root)
    found = find_by_id(root, args.id)
    if not found:
        print(f"artifact {args.id} not found", file=sys.stderr)
        return 2
    print(f"garrison://artifacts/{args.id}")
    return 0


def cmd_delete(args: argparse.Namespace) -> int:
    root = resolve_root(args.root)
    found = find_by_id(root, args.id)
    if not found:
        print(f"artifact {args.id} not found", file=sys.stderr)
        return 2
    artifact_path, sidecar_path, _ = found
    if artifact_path.exists():
        artifact_path.unlink()
    if sidecar_path.exists():
        sidecar_path.unlink()
    print("deleted")
    return 0


def cmd_init(args: argparse.Namespace) -> int:
    root = resolve_root(args.root)
    root.mkdir(parents=True, exist_ok=True)
    namespaces = args.namespace or list(DEFAULT_NAMESPACES)
    for ns in namespaces:
        ensure_namespace(root, ns)
    print(str(root))
    return 0


def cmd_probe(args: argparse.Namespace) -> int:
    # The probe ensures the storage root resolves and is writable. It does NOT
    # exercise individual artifacts — that's overkill for verify-time and
    # would slow the runner up loop down on large stores.
    root = resolve_root(args.root)
    root.mkdir(parents=True, exist_ok=True)
    test_file = root / ".garrison-probe"
    try:
        test_file.write_text("ok", encoding="utf-8")
        test_file.unlink()
    except OSError as exc:
        print(f"probe failed: {exc}", file=sys.stderr)
        return 1
    print("ok")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="artifacts")
    parser.add_argument("--root", help="override storage root (testing/CLI)")
    parser.add_argument("--probe", action="store_true", help="health check; prints 'ok'")

    sub = parser.add_subparsers(dest="command")

    p_init = sub.add_parser("init", help="create storage root and standard namespaces")
    p_init.add_argument("--namespace", action="append", help="extra namespace(s) to create")

    p_write = sub.add_parser("write", help="write a new (or replacement) artifact from stdin")
    p_write.add_argument("namespace")
    p_write.add_argument("filename")
    p_write.add_argument("--title")
    p_write.add_argument("--mime")
    p_write.add_argument("--producer")

    p_read = sub.add_parser("read", help="read artifact bytes by id to stdout")
    p_read.add_argument("id")

    p_list = sub.add_parser("list", help="list artifact metadata as JSON")
    p_list.add_argument("--namespace")
    p_list.add_argument("--producer")
    p_list.add_argument("--since", help="ISO timestamp (>= filter on updated)")

    p_link = sub.add_parser("link", help="print garrison://artifacts/<id>")
    p_link.add_argument("id")

    p_delete = sub.add_parser("delete", help="remove artifact + sidecar")
    p_delete.add_argument("id")

    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.probe:
        return cmd_probe(args)
    if not args.command:
        parser.print_help(sys.stderr)
        return 2
    handlers = {
        "init": cmd_init,
        "write": cmd_write,
        "read": cmd_read,
        "list": cmd_list,
        "link": cmd_link,
        "delete": cmd_delete
    }
    return handlers[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
