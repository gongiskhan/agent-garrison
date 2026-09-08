import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'local-voice-setup-')); dirs.push(dir);
  const bin = path.join(dir, 'bin'), venv = path.join(dir, 'venv'), models = path.join(dir, 'models'), log = path.join(dir, 'downloads');
  await mkdir(bin); await mkdir(path.join(venv, 'bin'), { recursive: true });
  const python = spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim();
  const shim = path.join(venv, 'bin/python');
  await writeFile(shim, `#!/bin/bash\nif [ "$1" = -m ] || [ "$1" = -c ]; then exit 0; fi\nexec '${python}' "$@"\n`); await chmod(shim, 0o700);
  await writeFile(path.join(bin, 'curl'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$LOCAL_VOICE_SETUP_LOG"\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then shift; out="$1"; fi; shift; done\nif [ "$LOCAL_VOICE_SETUP_FAIL" = 1 ]; then exit 22; fi\nprintf "synthetic model" > "$out"\n');
  await chmod(path.join(bin, 'curl'), 0o700);
  await writeFile(log, '');
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, LOCAL_VOICE_VENV: venv,
    LOCAL_VOICE_MODEL_DIR: models, LOCAL_VOICE_SETUP_LOG: log, LOCAL_VOICE_WAKE_WORD: 'off', LOCAL_VOICE_STT_ENGINE: 'faster-whisper' };
  const run = (piper: string, extra = {}) => spawnSync('bash', ['fittings/seed/local-voice/scripts/setup.sh'], { encoding: 'utf8', timeout: 10_000, env: { ...env, LOCAL_VOICE_PIPER_VOICES: piper, ...extra } });
  return { dir, models, log, run };
}

describe('Local Voice setup and external model cache', () => {
  it('honors explicit Piper disable and reuses existing external models', async () => {
    const f = await fixture(), first = f.run('{}');
    expect(first.status, first.stderr).toBe(0);
    const downloads = await readFile(f.log, 'utf8');
    expect(downloads.trim().split('\n')).toHaveLength(2);
    expect(downloads).not.toContain('piper-voices');
    expect(downloads).toContain('--connect-timeout 15 --max-time 300');
    expect(await readFile(path.join(f.models, 'kokoro-v1.0.onnx'), 'utf8')).toBe('synthetic model');
    await writeFile(f.log, ''); expect(f.run('{}').status).toBe(0); expect(await readFile(f.log, 'utf8')).toBe('');
  });
  it('downloads the default Piper files only when selected', async () => {
    const f = await fixture(), result = f.run(''); expect(result.status, result.stderr).toBe(0);
    expect((await readFile(f.log, 'utf8')).trim().split('\n')).toHaveLength(4);
    expect(await readFile(path.join(f.models, 'piper-voices/pt_PT-tugao-medium.onnx.json'), 'utf8')).toBe('synthetic model');
  });
  it('fails clearly for missing custom Piper models and invalid config', async () => {
    const f = await fixture();
    const missing = f.run(JSON.stringify({ en: path.join(f.dir, 'missing.onnx') }));
    expect(missing.status).not.toBe(0); expect(missing.stderr).toContain('missing configured Piper');
    const invalid = f.run('[]'); expect(invalid.status).not.toBe(0); expect(invalid.stderr).toContain('JSON object');
  });
  it('does not publish a failed or empty model download as complete', async () => {
    const f = await fixture(), result = f.run('{}', { LOCAL_VOICE_SETUP_FAIL: '1' });
    expect(result.status).not.toBe(0);
    await expect(readFile(path.join(f.models, 'kokoro-v1.0.onnx'))).rejects.toThrow();
  });
});
