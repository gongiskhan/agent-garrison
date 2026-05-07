"""Projects index for the Garrison Projects-Index Fitting.

Standalone — stdlib-only. Reads PROJECTS_INDEX_ROOT from env (or
defaults to ~/Projects). Lazy filesystem walk; no persistent index.

Usage:
    python projects.py --probe                 # health check, prints "ok"
    python projects.py list                    # list projects with descriptions
    python projects.py describe <name>         # shape + README + CLAUDE.md hints
    python projects.py read <name> <relpath>   # file content, capped at 200KB
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Iterable

DEFAULT_ROOT = Path.home() / "Projects"
IGNORE = {
    ".git",
    "node_modules",
    ".next",
    "dist",
    "build",
    "__pycache__",
    ".venv",
    "venv",
    "target",
    ".cache",
    ".turbo",
}
PRESENCE_MARKERS = (
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "Gemfile",
    "requirements.txt",
    "CLAUDE.md",
    "README.md",
    ".git",
)
MAX_READ_BYTES = 200 * 1024  # 200KB


def root() -> Path:
    raw = os.environ.get("PROJECTS_INDEX_ROOT")
    return Path(raw).expanduser().resolve() if raw else DEFAULT_ROOT.resolve()


def list_projects(base: Path) -> list[dict]:
    if not base.is_dir():
        return []
    entries = []
    for child in sorted(base.iterdir(), key=lambda p: p.name.lower()):
        if not child.is_dir() or child.name.startswith(".") or child.name in IGNORE:
            continue
        entries.append(
            {
                "name": child.name,
                "description": _first_readme_paragraph(child),
            }
        )
    return entries


def describe_project(base: Path, name: str) -> dict | None:
    target = _resolve_project(base, name)
    if target is None:
        return None
    return {
        "name": target.name,
        "directory_listing": _shallow_listing(target),
        "readme_excerpt": _read_head(target / "README.md", lines=30),
        "claude_md_excerpt": _read_head(target / "CLAUDE.md", lines=50),
        "markers": {m: (target / m).exists() for m in PRESENCE_MARKERS},
    }


def read_project_file(base: Path, name: str, rel: str) -> dict | None:
    target = _resolve_project(base, name)
    if target is None:
        return None
    rel_path = (target / rel).resolve()
    try:
        rel_path.relative_to(target.resolve())
    except ValueError:
        return {"error": "path escapes project root", "path": rel}
    if not rel_path.exists() or not rel_path.is_file():
        return {"error": "not found", "path": rel}
    raw = rel_path.read_bytes()
    truncated = len(raw) > MAX_READ_BYTES
    body = raw[:MAX_READ_BYTES].decode("utf-8", errors="replace")
    return {
        "path": str(rel_path.relative_to(target.resolve())),
        "size_bytes": len(raw),
        "truncated": truncated,
        "body": body,
    }


def _resolve_project(base: Path, name: str) -> Path | None:
    if not base.is_dir():
        return None
    candidate = base / name
    if candidate.is_dir():
        return candidate
    lowered = name.lower()
    for child in base.iterdir():
        if child.is_dir() and child.name.lower() == lowered:
            return child
    return None


def _first_readme_paragraph(project: Path) -> str | None:
    readme = project / "README.md"
    if not readme.is_file():
        return None
    try:
        text = readme.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    paragraphs = []
    current: list[str] = []
    for line in text.splitlines():
        if not line.strip():
            if current:
                paragraphs.append(" ".join(current).strip())
                current = []
            continue
        # Skip leading H1 / setext underlines.
        if line.startswith("#") and not current and not paragraphs:
            continue
        if set(line.strip()) <= {"=", "-"} and current:
            current = []
            continue
        current.append(line.strip())
    if current:
        paragraphs.append(" ".join(current).strip())
    for p in paragraphs:
        if p:
            return p[:240]
    return None


def _shallow_listing(project: Path) -> list[dict]:
    entries = []
    for child in sorted(project.iterdir(), key=lambda p: p.name.lower()):
        if child.name in IGNORE:
            continue
        entries.append({"name": child.name, "kind": "dir" if child.is_dir() else "file"})
    return entries


def _read_head(path: Path, *, lines: int) -> str | None:
    if not path.is_file():
        return None
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    head = text.splitlines()[:lines]
    return "\n".join(head)


def _print_json(obj) -> None:
    json.dump(obj, sys.stdout, indent=2, default=str)
    sys.stdout.write("\n")


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[1] == "--probe":
        base = root()
        if not base.is_dir():
            print(f"projects_root not found: {base}", file=sys.stderr)
            return 1
        if not os.access(base, os.R_OK):
            print(f"projects_root not readable: {base}", file=sys.stderr)
            return 1
        print("ok")
        return 0

    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2

    cmd = argv[1]
    base = root()

    if cmd == "list":
        _print_json({"projects_root": str(base), "projects": list_projects(base)})
        return 0

    if cmd == "describe":
        if len(argv) < 3:
            print("usage: projects.py describe <name>", file=sys.stderr)
            return 2
        result = describe_project(base, argv[2])
        if result is None:
            print(f"project not found: {argv[2]}", file=sys.stderr)
            return 1
        _print_json(result)
        return 0

    if cmd == "read":
        if len(argv) < 4:
            print("usage: projects.py read <name> <relpath>", file=sys.stderr)
            return 2
        result = read_project_file(base, argv[2], argv[3])
        if result is None:
            print(f"project not found: {argv[2]}", file=sys.stderr)
            return 1
        if "error" in result:
            print(f"read failed: {result['error']} ({result.get('path')})", file=sys.stderr)
            return 1
        _print_json(result)
        return 0

    print(f"unknown command: {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
