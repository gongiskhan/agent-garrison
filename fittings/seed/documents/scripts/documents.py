#!/usr/bin/env python3
"""documents CLI — markdown workspace layered on the artifact store.

Wraps `apm_modules/_local/artifact-store/scripts/artifacts.py`. Adds:
- enforces the .md extension and the `documents/` namespace
- defaults producer to `documents`
- list always filters to namespace=documents

The artifact id remains the canonical reference; documents.py never
introduces a separate id space.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Optional

NAMESPACE = "documents"
EXT = ".md"
PRODUCER = "documents"


def artifact_store_cli() -> str:
    # The Operative invokes documents.py from the composition directory; the
    # artifact-store CLI lives at the standard install path. Override via
    # GARRISON_ARTIFACTS_CLI for tests that don't have the real install layout.
    explicit = os.environ.get("GARRISON_ARTIFACTS_CLI")
    if explicit:
        return explicit
    return "apm_modules/_local/artifact-store/scripts/artifacts.py"


def call_artifacts(args: list[str], stdin: Optional[bytes] = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["python3", artifact_store_cli(), *args],
        input=stdin,
        capture_output=True,
        check=False
    )


def slugify(title: str) -> str:
    base = re.sub(r"[^a-zA-Z0-9]+", "-", title).strip("-").lower()
    if not base:
        base = "document"
    return base[:64]


def cmd_create(args: argparse.Namespace) -> int:
    title = args.title or "Untitled document"
    filename = args.filename
    if not filename:
        filename = f"{slugify(title)}-{uuid.uuid4().hex[:6]}{EXT}"
    if not filename.endswith(EXT):
        filename += EXT
    body = sys.stdin.buffer.read()
    cli_args = [
        "write",
        NAMESPACE,
        filename,
        "--title", title,
        "--mime", "text/markdown",
        "--producer", PRODUCER
    ]
    result = call_artifacts(cli_args, stdin=body)
    if result.stderr:
        sys.stderr.buffer.write(result.stderr)
    if result.returncode != 0:
        return result.returncode
    sys.stdout.buffer.write(result.stdout)
    return 0


def cmd_update(args: argparse.Namespace) -> int:
    body = sys.stdin.buffer.read()
    listing = call_artifacts(["list", "--namespace", NAMESPACE])
    if listing.returncode != 0:
        sys.stderr.buffer.write(listing.stderr)
        return listing.returncode
    rows = json.loads(listing.stdout.decode("utf-8"))
    target = next((row for row in rows if row.get("id") == args.id), None)
    if not target:
        sys.stderr.write(f"document {args.id} not found\n")
        return 2
    cli_args = [
        "write",
        NAMESPACE,
        target["filename"],
        "--mime", target.get("mime", "text/markdown"),
        "--producer", target.get("producer", PRODUCER)
    ]
    if target.get("title"):
        cli_args.extend(["--title", target["title"]])
    result = call_artifacts(cli_args, stdin=body)
    if result.stderr:
        sys.stderr.buffer.write(result.stderr)
    if result.returncode != 0:
        return result.returncode
    sys.stdout.buffer.write(result.stdout)
    return 0


def cmd_read(args: argparse.Namespace) -> int:
    result = call_artifacts(["read", args.id])
    if result.stderr:
        sys.stderr.buffer.write(result.stderr)
    if result.returncode != 0:
        return result.returncode
    sys.stdout.buffer.write(result.stdout)
    return 0


def cmd_list(_: argparse.Namespace) -> int:
    result = call_artifacts(["list", "--namespace", NAMESPACE])
    if result.stderr:
        sys.stderr.buffer.write(result.stderr)
    sys.stdout.buffer.write(result.stdout)
    return result.returncode


def cmd_link(args: argparse.Namespace) -> int:
    listing = call_artifacts(["list", "--namespace", NAMESPACE])
    if listing.returncode != 0:
        sys.stderr.buffer.write(listing.stderr)
        return listing.returncode
    rows = json.loads(listing.stdout.decode("utf-8"))
    target = next((row for row in rows if row.get("id") == args.id), None)
    if not target:
        sys.stderr.write(f"document {args.id} not found\n")
        return 2
    print(f"garrison://documents/{args.id}")
    return 0


def cmd_probe(_: argparse.Namespace) -> int:
    result = call_artifacts(["--probe"])
    sys.stdout.buffer.write(result.stdout)
    if result.returncode != 0:
        sys.stderr.buffer.write(result.stderr)
    return result.returncode


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="documents")
    parser.add_argument("--probe", action="store_true", help="health check; defers to artifact-store --probe")

    sub = parser.add_subparsers(dest="command")

    p_create = sub.add_parser("create", help="create a new document from stdin markdown")
    p_create.add_argument("--title")
    p_create.add_argument("--filename", help="override the auto-generated filename")

    p_update = sub.add_parser("update", help="overwrite an existing document by id from stdin")
    p_update.add_argument("id")

    p_read = sub.add_parser("read", help="print document markdown by id")
    p_read.add_argument("id")

    sub.add_parser("list", help="JSON list of documents")

    p_link = sub.add_parser("link", help="print garrison://documents/<id>")
    p_link.add_argument("id")

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
        "create": cmd_create,
        "update": cmd_update,
        "read": cmd_read,
        "list": cmd_list,
        "link": cmd_link
    }
    return handlers[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
