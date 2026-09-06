#!/usr/bin/env python3
"""Install the shared bridge without replacing another tool's configuration.

Run from each node's git checkout. All existing modified files receive a private
backup. Repeat --project NAME=PATH / --project-parent PATH to enroll other repos.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import sys

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('continuity', HERE / 'agent-continuity.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
START = '<!-- GARRISON_AGENT_CONTINUITY_START -->'
END = '<!-- GARRISON_AGENT_CONTINUITY_END -->'
POLICY = '''## Shared memory and concurrent work

Claude Code, ChatGPT/Codex and Garrison sessions share Basic Memory project `main`.
At the beginning of work, read the project's shared `Agent Startup Brief` and
relevant topic notes under `Projects/<project>/Memory`; check `Agent Sessions`
notes and live sessions for overlapping work. Read the canonical repository
`CLAUDE.md` (`AGENTS.md` is its symlink), `PRD.md`, `PLANING.md` and `TASKS.md`
when present. Repository instructions and live evidence outrank memory.

Write durable decisions, verification, remaining work and handoffs back to those
same shared topic notes at meaningful milestones and before finishing. Native
agent memory is a local index: if it contains a new durable project fact, save
that fact to the shared topic as well. Read existing notes before updating them;
append a dated correction or scoped edit rather than overwriting another agent's
work. Link relevant plans and evidence on their owner node. Never copy raw
transcripts, secrets, full configurations or tool outputs wholesale into memory.

Lifecycle hooks publish metadata-only session observations, with timestamps and
hashed session keys. A roster is advisory and expires after ten minutes without
a heartbeat; verify live work before editing overlapping files. Coordinate file
ownership, preserve uncommitted work, and never infer that a stale or absent row
means the checkout is free. Use `python3 ~/dev/garrison/scripts/agent-continuity.py status --cwd <project>` or Basic Memory to inspect peer context. Sessions and
artifacts stay on their owner node; code moves through git.
'''


def private_backup(path, backup_dir):
    if path.exists() or path.is_symlink():
        backup_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        name = bridge.slug(str(path)) + '-' + bridge.hashlib.sha256(str(path).encode()).hexdigest()[:8]
        dest = backup_dir / name
        shutil.copy2(path, dest, follow_symlinks=True)
        dest.chmod(0o600)


def save(path, content, backup_dir):
    if path.is_symlink():
        raise ValueError(f'Refusing to replace symlinked host configuration: {path}')
    if path.exists() and path.read_text() == content:
        return False
    private_backup(path, backup_dir)
    bridge.atomic_write(path, content)
    return True


def managed_policy(text):
    block = START + '\n' + POLICY + '\n' + END
    if START in text:
        if END not in text:
            raise ValueError('Incomplete shared-memory instruction marker')
        before, tail = text.split(START, 1)
        _, after = tail.split(END, 1)
        return before + block + after
    return block + '\n\n' + text


def known_legacy(command):
    # Exact known owners only. Keep mixed groups and every unrelated command.
    return ('garrison-memory-hook.py' in command or
            '.claude/basic-memory/capture-session.py' in command or
            'garrison-agent-continuity' in command or
            'agent-continuity.py' in command)


def merge_hooks(data, command, codex=False):
    data = json.loads(json.dumps(data))
    groups = data.setdefault('hooks', {})
    if not isinstance(groups, dict):
        raise ValueError('hooks must be an object')
    for event, entries in list(groups.items()):
        kept = []
        for entry in entries:
            hooks = entry.get('hooks', [])
            remaining = [h for h in hooks if not known_legacy(str(h.get('command', '')))]
            if remaining:
                kept.append({**entry, 'hooks': remaining})
            elif not hooks:
                kept.append(entry)
        groups[event] = kept
    for event in sorted(bridge.EVENTS):
        handler = {'type': 'command', 'command': command, 'timeout': 2}
        if codex and event in {'SessionStart', 'UserPromptSubmit'}:
            handler['additionalContextLimit'] = 1800
        # No matcher for lifecycle events: new reason strings must still match.
        group = {'hooks': [handler]}
        if event == 'PostToolUse':
            group['matcher'] = '.*' if codex else '*'
        groups.setdefault(event, []).append(group)
    return data


def unify_instructions(root, backup_dir):
    agents, claude = root / 'AGENTS.md', root / 'CLAUDE.md'
    if agents.is_symlink() and agents.resolve() == claude.resolve() and claude.is_file():
        return
    if claude.is_symlink() and claude.resolve() == agents.resolve() and agents.is_file():
        return
    if agents.is_symlink() or claude.is_symlink():
        raise ValueError(f'Review existing noncanonical instruction symlink in {root}')
    a = agents.read_text() if agents.exists() else ''
    c = claude.read_text() if claude.exists() else ''
    if a and c and a != c:
        # Both full texts survive; canonical project-specific decisions are not inferred.
        c += '\n\n## Preserved AGENTS.md instructions\n\n' + a
    elif a and not c:
        c = a
    save(claude, managed_policy(c or '# Project instructions\n'), backup_dir)
    private_backup(agents, backup_dir)
    if agents.exists():
        agents.unlink()
    agents.symlink_to('CLAUDE.md')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--node', required=True)
    p.add_argument('--project', action='append', default=[], metavar='NAME=PATH')
    p.add_argument('--project-parent', action='append', default=[])
    p.add_argument('--peer-node', action='append', default=[])
    p.add_argument('--ssh-host', help='Omit on the Basic Memory authority node')
    p.add_argument('--basic-memory', default='/home/ggomes/.local/bin/basic-memory')
    p.add_argument('--home', type=Path, default=Path.home(), help='Override for isolated installer validation')
    p.add_argument('--unify-instructions', action='store_true', help='Unify explicitly enrolled project roots, preserving both texts')
    args = p.parse_args()
    home = args.home.expanduser().resolve()
    state = home / '.local/state/garrison/agent-continuity'
    backup_dir = state / 'install-backups' / datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    config_path = home / '.config/garrison/agent-continuity.json'
    previous = bridge.read_json(config_path, {})
    projects = {v['root']: v for v in previous.get('projects', [])}
    for value in args.project:
        name, sep, path = value.partition('=')
        root = Path(path).expanduser()
        if not sep or not name or '/' in name or name in {'.', '..'} or not root.is_absolute() or not root.is_dir():
            raise ValueError('Each project must be NAME=/existing/absolute/path')
        if root.resolve() != root.absolute():
            raise ValueError('Project checkouts must not be reached through symlinks')
        projects[str(root)] = {'name': name, 'key': bridge.slug(name), 'root': str(root)}
    config = {**previous, 'version': 1, 'node': bridge.slug(args.node), 'memory_project': 'main',
              'projects': list(projects.values()), 'project_parents': sorted(set(previous.get('project_parents', []) + [str(Path(v).expanduser().resolve()) for v in args.project_parent])),
              'peer_nodes': sorted(set(previous.get('peer_nodes', []) + args.peer_node)),
              'basic_memory_command': [args.basic_memory], 'state_dir': str(state), 'ssh_host': args.ssh_host}
    # Never synthesize MCP JSON/TOML: the host setup uses each client's supported CLI.
    save(config_path, json.dumps(config, indent=2) + '\n', backup_dir)
    for client, path in [('Claude', home / '.claude/settings.json'), ('Codex', home / '.codex/hooks.json')]:
        data = bridge.read_json(path)
        if path.exists() and not isinstance(data, dict):
            raise ValueError(f'Refusing invalid JSON configuration: {path}')
        command = ' '.join(shlex.quote(v) for v in [sys.executable, str(HERE / 'agent-continuity.py'), '--config', str(config_path), 'hook', '--source', client])
        merged = merge_hooks(data or {}, command, codex=client == 'Codex')
        save(path, json.dumps(merged, indent=2) + '\n', backup_dir)
    for path in [home / '.claude/CLAUDE.md', home / '.codex/AGENTS.md']:
        save(path, managed_policy(path.read_text() if path.exists() else ''), backup_dir)
    if args.unify_instructions:
        for value in args.project:
            unify_instructions(Path(value.partition('=')[2]).expanduser(), backup_dir)
    print(json.dumps({'node': config['node'], 'config': str(config_path), 'projects': len(config['projects']),
                      'project_parents': config['project_parents'], 'backup_dir': str(backup_dir),
                      'hooks_per_client': len(bridge.EVENTS), 'requires_new_session_hook_review': True}, indent=2))


if __name__ == '__main__':
    main()
