import { describe, expect, it } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
const root = path.resolve('fittings/seed/local-voice/voice-server');

describe('Local Voice Python runtime', () => {
  it('runs dependency-free engine/configuration regressions without loading models', () => {
    const result = spawnSync('python3', [path.join(root, 'test_runtime.py')], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).toContain('Ran 12 tests');
  });
  it('exits after parent death even while a third-party import is blocked', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'local-voice-parent-'));
    const marker = path.join(dir, 'entered');
    // This is the actual server entrypoint; only the first heavy import is
    // replaced with a fixture that waits. The early watchdog must already run.
    await writeFile(path.join(dir, 'httpx.py'), `import time\nopen(${JSON.stringify(marker)},'w').write('entered')\ntime.sleep(30)\n`);
    const parent = spawn('python3', ['-c', `import os,subprocess,time\nenv=dict(os.environ,VOICE_PARENT_PID=str(os.getpid()),PYTHONPATH=${JSON.stringify(dir + path.delimiter + root)})\np=subprocess.Popen(['python3','-c',${JSON.stringify(`import runpy; runpy.run_path(${JSON.stringify(path.join(root, 'server.py'))}, run_name='__main__')`)}],env=env)\nprint(p.pid,flush=True)\ntime.sleep(30)`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let childPid = 0;
    try {
      const [data] = await once(parent.stdout, 'data'); childPid = Number(data.toString().trim());
      let entered = false;
      for (let i = 0; i < 100; i++) { try { entered = (await readFile(marker, 'utf8')) === 'entered'; } catch {} if (entered) break; await new Promise(r => setTimeout(r, 10)); }
      expect(entered).toBe(true); parent.kill('SIGKILL'); await once(parent, 'exit');
      let gone = false;
      for (let i = 0; i < 100; i++) { try { process.kill(childPid, 0); } catch { gone = true; } if (gone) break; await new Promise(r => setTimeout(r, 20)); }
      expect(gone).toBe(true);
    } finally { parent.kill('SIGKILL'); if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} } await rm(dir, { recursive: true, force: true }); }
  });
});
