"""Standard-library regression suite: python3 tests/agent-continuity.test.py."""
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]

def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

bridge = load('continuity_test', 'agent-continuity.py')
installer = load('continuity_installer_test', 'install-agent-continuity.py')


class ContinuityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name).resolve()
        self.repo = self.home / 'dev/garrison'
        self.repo.mkdir(parents=True)
        (self.repo / '.git').mkdir()
        self.cfg = {'version': 1, 'node': 'mac-pro', 'state_dir': str(self.home / 'state'),
                    'memory_project': 'main', 'basic_memory_command': ['/usr/local/bin/basic-memory'],
                    'projects': [{'root': str(self.repo), 'name': 'Garrison'}],
                    'project_parents': [str(self.home / 'dev')], 'peer_nodes': ['mac-pro', 'dev-madrid']}
        self.project = bridge.project_for(str(self.repo), self.cfg)

    def event(self, event='SessionStart', sid='raw-session-id', source='Codex', **extra):
        return bridge.hook({'hook_event_name': event, 'session_id': sid, 'cwd': str(self.repo), **extra},
                           source, self.cfg, self.home / 'config.json', detach=False)

    def records(self, directory='sessions'):
        return [json.loads(p.read_text()) for p in (self.home / 'state' / directory).glob('*.json')]

    def test_scope_missing_payload_and_sibling_rejected(self):
        for cwd in [None, '', '.', str(self.home / 'dev/garrison-old'), '/tmp']:
            self.assertIsNone(bridge.project_for(cwd, self.cfg))
        self.assertEqual(bridge.project_for(str(self.repo / 'src'), self.cfg)['key'], 'garrison')
        self.assertIsNone(bridge.hook({'cwd': str(self.repo), 'hook_event_name': 'SessionStart'}, 'Codex', self.cfg, 'unused', False))

    def test_other_projects_discovered_without_scanning_unrelated_directories(self):
        other = self.home / 'dev/other'
        (other / '.git').mkdir(parents=True)
        self.assertEqual(bridge.project_for(str(other / 'src'), self.cfg)['key'], 'other')
        outside = self.home / 'private'
        (outside / '.git').mkdir(parents=True)
        self.assertIsNone(bridge.project_for(str(outside), self.cfg))

    def test_payload_allowlist_redaction_and_private_permissions(self):
        result = self.event(model='sk-' + 'x' * 30, prompt='DO NOT STORE', tool_input={'command': 'PRIVATE COMMAND'},
                            transcript_path='/private/must-not-open.jsonl', tool_response='PRIVATE RESPONSE')
        data = json.dumps(self.records())
        for value in ['raw-session-id', 'DO NOT STORE', 'PRIVATE COMMAND', 'must-not-open', 'PRIVATE RESPONSE', 'x' * 30]:
            self.assertNotIn(value, data)
        self.assertIn('additionalContext', result['hookSpecificOutput'])
        for path in (self.home / 'state/sessions').glob('*.json'):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_clients_and_nodes_do_not_collide_and_peers_appear(self):
        self.event(source='Claude')
        result = self.event(source='Codex')
        self.assertEqual(len(self.records()), 2)
        self.assertIn('Claude', result['hookSpecificOutput']['additionalContext'])
        self.cfg['node'] = 'dev-madrid'
        self.event(source='Claude')
        self.assertEqual(len(self.records()), 3)

    def test_heartbeat_is_throttled_and_end_is_not(self):
        self.event()
        before = self.records()[0]['updated_epoch']
        self.assertIsNone(self.event('PostToolUse'))
        self.assertEqual(self.records()[0]['updated_epoch'], before)
        self.event('SessionEnd')
        self.assertEqual(self.records()[0]['status'], 'ended')
        self.event('UserPromptSubmit')
        self.assertEqual(self.records()[0]['status'], 'active')

    def test_lost_end_expires_without_asserting_session_finished(self):
        self.event()
        sessions = bridge.recent_sessions(self.cfg, self.project, time.time() + 601)
        self.assertIn('stale', sessions[0]['status'])
        self.assertNotEqual(sessions[0]['status'], 'ended')

    def test_worker_retries_failed_authority_and_preserves_newer_checkpoint(self):
        self.event()
        with patch.object(bridge, 'git_snapshot', return_value={'branch': 'node/mac-pro', 'head': 'abc123', 'paths': [' M src/x.ts']}), \
             patch.object(bridge, 'bm', side_effect=RuntimeError('offline')):
            bridge.worker(self.cfg)
        self.assertEqual(len(self.records('pending')), 1)
        calls = []
        def write(*args, **kwargs):
            calls.append(args)
            if 'write-note' in args and 'Checkpoints' in str(args):
                self.event('SessionEnd')  # Arrives while an older write is in flight.
            return '{}'
        with patch.object(bridge, 'git_snapshot', return_value={'branch': 'main', 'head': 'abc123', 'paths': []}), \
             patch.object(bridge, 'bm', side_effect=write), patch.object(bridge, 'refresh'):
            bridge.worker(self.cfg)
        self.assertEqual(self.records('pending')[0]['status'], 'ended')
        self.assertEqual(self.records()[0]['status'], 'ended')
        self.assertTrue(any('Agent Sessions garrison mac-pro' in str(c) for c in calls))

    def test_roster_failure_is_queued_separately_after_checkpoint_succeeds(self):
        self.event()
        def write(*args, **kwargs):
            if 'Agent Sessions' in str(args):
                raise RuntimeError('offline')
            return '{}'
        with patch.object(bridge, 'git_snapshot', return_value={'branch': 'main', 'head': 'abc123', 'paths': []}), patch.object(bridge, 'bm', side_effect=write):
            bridge.worker(self.cfg)
        self.assertEqual(self.records('pending'), [])
        self.assertEqual(len(self.records('roster-pending')), 1)
        with patch.object(bridge, 'bm', return_value='{}'), patch.object(bridge, 'refresh'):
            bridge.worker(self.cfg)
        self.assertEqual(self.records('roster-pending'), [])

    def test_ssh_command_quotes_arguments_without_shell_injection(self):
        self.cfg['ssh_host'] = 'dev-madrid'
        argv = bridge.bm_command(self.cfg, 'tool', 'read-note', "project's note; $(private)")
        self.assertEqual(argv[:2], ['/usr/bin/ssh', '-T'])
        import shlex
        self.assertEqual(shlex.split(argv[-1])[-1], "project's note; $(private)")

    def test_installer_preserves_other_owners_and_is_idempotent(self):
        command = 'python3 /repo/scripts/agent-continuity.py hook --source Codex'
        old = {'custom': True, 'hooks': {'SessionStart': [{'matcher': '*', 'hooks': [
            {'type': 'command', 'command': 'native-session-event'},
            {'type': 'command', 'command': 'python3 /home/me/.codex/garrison-memory-hook.py start'}]}],
            'SessionEnd': [{'hooks': [{'command': 'python3 /home/me/.claude/basic-memory/capture-session.py'}]}]}}
        merged = installer.merge_hooks(old, command, codex=True)
        self.assertTrue(merged['custom'])
        self.assertIn('native-session-event', json.dumps(merged))
        self.assertNotIn('capture-session.py', json.dumps(merged))
        self.assertEqual(installer.merge_hooks(merged, command, codex=True), merged)
        self.assertEqual(len(merged['hooks']['SessionStart']), 2)

    def test_native_import_only_reads_authored_markdown_and_is_update_only(self):
        self.cfg['claude_home'] = str(self.home / '.claude')
        source = self.home / '.claude/projects' / str(self.repo).replace('/', '-').replace('.', '-') / 'memory'
        source.mkdir(parents=True)
        (source / 'MEMORY.md').write_text('A durable choice. api_key=private-test-value')
        (source.parent / 'session.jsonl').write_text('RAW TRANSCRIPT MUST NEVER APPEAR')
        (source / 'session-old.md').write_text('RAW SESSION EXCERPT')
        (source / 'too-large.md').write_text('x' * 65537)
        secret = self.home / 'unrelated.md'; secret.write_text('UNRELATED SECRET')
        (source / 'linked.md').symlink_to(secret)
        calls = []
        with patch.object(bridge, 'bm', side_effect=lambda *args, **kw: calls.append((args, kw)) or '{}'):
            result = bridge.native_import(self.cfg, self.project)
            again = bridge.native_import(self.cfg, self.project)
            (source / 'MEMORY.md').unlink()
            deleted = bridge.native_import(self.cfg, self.project)
        self.assertEqual(result['imported'], 1)
        self.assertEqual(result['skipped'], 3)
        self.assertEqual(again['imported'], 0)
        self.assertEqual(deleted['imported'], 0)
        self.assertEqual(len(calls), 1)
        rendered = calls[0][1]['content']
        self.assertIn('durable choice', rendered)
        for prohibited in ['private-test-value', 'RAW TRANSCRIPT', 'RAW SESSION', 'UNRELATED SECRET']:
            self.assertNotIn(prohibited, rendered)
        self.assertIn('/Native/Claude/mac-pro', str(calls[0][0]))

    def test_native_failed_write_remains_retryable(self):
        self.cfg['claude_home'] = str(self.home / '.claude')
        source = self.home / '.claude/projects' / str(self.repo).replace('/', '-').replace('.', '-') / 'memory'
        source.mkdir(parents=True)
        (source / 'MEMORY.md').write_text('Decision')
        with patch.object(bridge, 'bm', side_effect=RuntimeError('offline')):
            with self.assertRaises(RuntimeError):
                bridge.native_import(self.cfg, self.project)
        with patch.object(bridge, 'bm', return_value='{}'):
            self.assertEqual(bridge.native_import(self.cfg, self.project)['imported'], 1)

    def test_instruction_unification_preserves_both_files(self):
        (self.repo / 'AGENTS.md').write_text('Unique Codex instructions\n')
        (self.repo / 'CLAUDE.md').write_text('Unique Claude instructions\n')
        installer.unify_instructions(self.repo, self.home / 'backups')
        self.assertTrue((self.repo / 'AGENTS.md').is_symlink())
        content = (self.repo / 'CLAUDE.md').read_text()
        self.assertIn('Unique Codex instructions', content)
        self.assertIn('Unique Claude instructions', content)
        installer.unify_instructions(self.repo, self.home / 'backups')
        self.assertEqual((self.repo / 'CLAUDE.md').read_text(), content)


if __name__ == '__main__':
    unittest.main()
