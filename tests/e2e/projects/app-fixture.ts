import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import {randomBytes} from 'node:crypto';
import {promisify} from 'node:util';
import {execFile, spawn, type ChildProcess} from 'node:child_process';
import {StateClient} from '@garrison/state-client';
import {startStateService} from '../../state-service-harness';
import {seedProject} from '../../projects-fixture';
import {cloneOf, commitFile, git, initBare} from '../../projects-git-fixture';

const execute = promisify(execFile);
const repository = process.cwd();
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
export type ProjectsNode = {id: string; name: string; accent: string; accentColor: string; home: string; devRoot: string; base: string; origin: string; log: string; client: StateClient};
export type ProjectsApp = ProjectsNode & {root: string; vault: string; token: string; peer?: ProjectsNode; boardBase?: string; stop: () => Promise<void>};
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {const port = (server.address() as net.AddressInfo).port; server.close(() => resolve(port));});
  });
}
async function stopProcess(proc: ChildProcess) {
  if (proc.exitCode !== null) return;
  const done = new Promise<void>(resolve => proc.once('exit', () => resolve()));
  try {process.kill(-proc.pid!, 'SIGTERM');} catch {}
  await Promise.race([done, new Promise(resolve => setTimeout(resolve, 5000))]);
  if (proc.exitCode === null) {try {process.kill(-proc.pid!, 'SIGKILL');} catch {} await done;}
}
async function tlsProxy(node: ProjectsNode, key: Buffer, cert: Buffer) {
  const target = new URL(node.base);
  const proxy = https.createServer({key, cert}, (request, response) => {
    const upstream = http.request({hostname: target.hostname, port: target.port, path: request.url, method: request.method, headers: {...request.headers, host: target.host}}, result => {
      response.writeHead(result.statusCode || 502, result.headers); result.pipe(response);
    });
    upstream.on('error', () => {if (!response.headersSent) response.writeHead(502, {'content-type': 'application/json'}); response.end(JSON.stringify({error: 'Synthetic peer did not answer.'}));});
    request.on('aborted', () => upstream.destroy()); request.pipe(upstream);
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  node.origin = `https://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
  return proxy;
}

export async function startProjectsApp({peer = false, pump = false}: {peer?: boolean; pump?: boolean} = {}): Promise<ProjectsApp> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'projects-e2e-'));
  const state = await startStateService({nodes: peer ? ['fixture-a', 'fixture-b'] : ['fixture-a']});
  const processes: ChildProcess[] = [], proxies: https.Server[] = [];
  let timer: ReturnType<typeof setInterval> | undefined, stopped = false;
  const stop = async () => {
    if (stopped) return; stopped = true; if (timer) clearInterval(timer);
    await Promise.all(processes.map(stopProcess));
    await Promise.all(proxies.map(proxy => new Promise<void>(resolve => {proxy.close(() => resolve()); proxy.closeAllConnections();})));
    await state.stop(); await fs.rm(root, {recursive: true, force: true});
  };
  try {
    const makeNode = async (suffix: string, name: string, accent: string, accentColor: string): Promise<ProjectsNode> => {
      const id = `fixture-${suffix}`, home = path.join(root, suffix, 'home'), devRoot = path.join(root, suffix, 'dev');
      await fs.mkdir(path.join(home, 'runtime-homes/claude'), {recursive: true});
      await fs.mkdir(devRoot, {recursive: true});
      await fs.writeFile(path.join(home, 'dev-root'), devRoot);
      await fs.writeFile(path.join(home, 'node.json'), JSON.stringify({id, name, accent}));
      await fs.writeFile(path.join(home, 'state.json'), JSON.stringify({url: state.url, token: state.tokens[id], node: id}), {mode: 0o600});
      await fs.mkdir(path.join(home, 'files/documents'), {recursive: true});
      await fs.writeFile(path.join(home, 'files/documents/2026-09-13-note.md'), '# Synthetic note\n\n- Workspace item\n');
      return {id, name, accent, accentColor, home, devRoot, base: `http://127.0.0.1:${await freePort()}`, origin: '', log: '', client: new StateClient({url: state.url, token: state.tokens[id], node: id})};
    };
    const self = await makeNode('a', 'Fixture A', 'moss', '#4a7d5f');
    const other = peer ? await makeNode('b', 'Fixture B', 'steel', '#527c91') : undefined;
    const alpha = await seedProject(self.devRoot, 'alpha', {
      'README.md': '# Alpha\n\nOriginal project overview.\n',
      'docs/deep/note.md': '# Synthetic guide\n\n- Original line\n- Second item\n\n[[plain name]]\n',
      'docs/deep/example.ts': 'const message = "Synthetic";\nconsole.log(message);\n',
      'docs/deep/pixel.png': pixel,
      'docs/deep/a-very-long-folder-for-breadcrumb-scroll/note.md': '# Synthetic deep note\n'
    });
    const alphaOrigin = await initBare(alpha, path.join(root, 'alpha-origin.git'));
    await git(alpha, 'remote', 'add', '--', 'origin', alphaOrigin);
    await git(alpha, 'push', '--quiet', '--set-upstream', 'origin', 'main');
    if (other) {
      const peerAlpha = await cloneOf(alpha, alphaOrigin, path.join(other.devRoot, 'alpha'));
      await fs.writeFile(path.join(peerAlpha, 'peer.txt'), 'Synthetic peer work\n');
      const delta = await seedProject(other.devRoot, 'delta', {'README.md': '# Delta\n', 'docs/deep/note.md': '# Peer guide\n\n- Peer item\n'});
      const deltaOrigin = await initBare(delta, path.join(root, 'delta-origin.git'));
      await git(delta, 'remote', 'add', '--', 'origin', deltaOrigin); await git(delta, 'push', '--quiet', '--set-upstream', 'origin', 'main');
      await fs.writeFile(path.join(delta, 'README.md'), '# Delta changed on Fixture B\n');
    }
    await commitFile(alpha, 'ahead.txt', 'Synthetic ahead work\n', 'Synthetic ahead snapshot');
    await fs.writeFile(path.join(alpha, 'README.md'), '# Alpha\n\nUpdated project overview.\n');
    await fs.writeFile(path.join(alpha, 'docs/deep/note.md'), '# Synthetic guide\n\n- Updated line\n- Second item\n\n[[plain name]]\n');
    await fs.writeFile(path.join(alpha, 'new.txt'), 'Synthetic untracked work\n');
    const beta = await seedProject(self.devRoot, 'beta');
    const betaOrigin = await initBare(beta, path.join(root, 'beta-origin.git'));
    await git(beta, 'remote', 'add', '--', 'origin', betaOrigin); await git(beta, 'push', '--quiet', '--set-upstream', 'origin', 'main');
    await fs.mkdir(path.join(self.devRoot, 'gamma'));
    await fs.mkdir(path.join(root, 'outside/.git'), {recursive: true});
    await fs.symlink(path.join(root, 'outside'), path.join(self.devRoot, 'sneaky'));
    const vault = path.join(root, 'vault'), token = randomBytes(32).toString('hex');
    await fs.mkdir(vault); await fs.writeFile(path.join(self.home, 'internal-token'), token, {mode: 0o600});
    await fs.writeFile(path.join(self.home, 'archive-fixture.json'), JSON.stringify({vaultDir: vault}));
    const app: ProjectsApp = Object.assign(self, {root, vault, token, peer: other, stop});
    const nodes = [self, ...(other ? [other] : [])];
    const certFile = path.join(root, 'test-ca.pem'), keyFile = path.join(root, 'test-key.pem');
    if (other) {
      await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-days', '1'], {timeout: 20_000, maxBuffer: 64 * 1024});
      const [key, cert] = await Promise.all([fs.readFile(keyFile), fs.readFile(certFile)]);
      for (const node of nodes) proxies.push(await tlsProxy(node, key, cert));
    }
    const beat = async () => {
      await Promise.all(nodes.map(node => node.client.request('POST', '/v1/hello', {body: {
        clientVersion: 'projects-fixture', minSchema: 1, maxSchema: 10000, localTime: new Date().toISOString(), platform: 'fixture', accentColor: node.accentColor,
        health: {node: {id: node.id, name: node.name, appOrigin: node.origin}, activity: 'idle'}
      }})));
    };
    await beat(); timer = setInterval(() => {void beat().catch(() => {});}, 15_000);
    for (const [index, node] of nodes.entries()) {
      const env = {...process.env};
      for (const key of Object.keys(env)) if (key.startsWith('GARRISON_') || key.startsWith('ARCHIVE_') || key === 'CLAUDE_CONFIG_DIR' || key === 'ANTHROPIC_AUTH_TOKEN' || key === 'ANTHROPIC_API_KEY') delete env[key];
      const port = new URL(node.base).port;
      Object.assign(env, {GARRISON_HOME: node.home, GARRISON_CLAUDE_HOME: path.join(node.home, 'runtime-homes/claude'), GARRISON_STATE_PATH: path.join(node.home, 'state.json'), GARRISON_STATE_URL: state.url, GARRISON_STATE_TOKEN: state.tokens[node.id], GARRISON_NODE_NAME: node.id,
        GARRISON_APP_PORT: port, PORT: port, GARRISON_INSTANCE_ID: 'dev', GARRISON_DISABLE_HOST_DAEMONS: '1', GARRISON_MESSAGES_DISABLE_WORKERS: '1', GARRISON_PROJECTS_PUMP: pump ? '1' : '0', GARRISON_PROJECTS_SELF_CHECKOUT: '0', NEXT_DIST_DIR: `.next-e2e-projects-${index ? 'b' : 'a'}`, NODE_ENV: 'development'});
      if (other) env.NODE_EXTRA_CA_CERTS = certFile;
      if (!index) {
        Object.assign(env, {ARCHIVE_TEST_MODE: '1', ARCHIVE_FAKE_LOOK: '1', GARRISON_INTERNAL_TOKEN_PATH: path.join(node.home, 'internal-token')});
        if (process.env.ARCHIVE_INTEGRATION_ACCOUNT && process.env.ARCHIVE_INTEGRATION_TOKEN) Object.assign(env, {GARRISON_ACCOUNT: process.env.ARCHIVE_INTEGRATION_ACCOUNT, ANTHROPIC_AUTH_TOKEN: process.env.ARCHIVE_INTEGRATION_TOKEN});
      }
      const drain = (bytes: Buffer) => {node.log = (node.log + bytes.toString().replaceAll(repository, '<checkout>')).slice(-256 * 1024);};
      if (pump && !index) {
        const seed = await execute(process.execPath, ['--input-type=module', '-e', "import {seedBoard} from './fittings/seed/kanban-loop/scripts/kanban.mjs'; process.stdout.write(JSON.stringify(seedBoard()));"], {cwd: repository, env, timeout: 10_000, maxBuffer: 256 * 1024});
        await node.client.putConfig('board.layout', 'global', JSON.parse(seed.stdout), {ifMatchRev: 0});
        const boardPort = await freePort(); app.boardBase = `http://127.0.0.1:${boardPort}`;
        const boardHome = path.join(root, 'board-home');
        await fs.mkdir(path.join(boardHome, 'runtime-homes/claude'), {recursive: true});
        await fs.writeFile(path.join(boardHome, 'dev-root'), node.devRoot);
        const boardEnv = {...env, GARRISON_HOME: boardHome, GARRISON_CLAUDE_HOME: path.join(boardHome, 'runtime-homes/claude'), GARRISON_KANBANLOOP_PORT: String(boardPort), GARRISON_KANBAN_DIR: path.join(boardHome, 'kanban-loop'), GARRISON_KANBAN_PROJECT_ROOT: path.join(node.devRoot, 'alpha'), GARRISON_APP_URL: node.base};
        const board = spawn(process.execPath, [path.join(repository, 'fittings/seed/kanban-loop/scripts/server.mjs')], {cwd: repository, env: boardEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
        processes.push(board); board.stdout!.on('data', drain); board.stderr!.on('data', drain);
        let ready = false;
        for (let attempt = 0; attempt < 150; attempt++) {
          if (board.exitCode !== null) throw new Error(`Synthetic board exited: ${node.log}`);
          try {if ((await fetch(app.boardBase + '/health', {signal: AbortSignal.timeout(1000)})).ok) {ready = true; break;}} catch {}
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (!ready) throw new Error(`Synthetic board did not become ready: ${node.log}`);
      }
      const proc = spawn(process.execPath, [path.join(repository, 'node_modules/next/dist/bin/next'), 'dev', '-H', '127.0.0.1', '-p', port], {cwd: repository, env, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
      processes.push(proc);
      proc.stdout!.on('data', drain); proc.stderr!.on('data', drain);
      const deadline = Date.now() + 120_000; let ready = false;
      while (Date.now() < deadline) {
        if (proc.exitCode !== null) throw new Error(`Synthetic app exited: ${node.log}`);
        try {const response = await fetch(node.base + '/api/projects', {signal: AbortSignal.timeout(5000)}); if (response.ok) {ready = true; break;}} catch {}
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      if (!ready) throw new Error(`Synthetic app did not become ready: ${node.log}`);
      const page = await fetch(node.base + '/projects', {signal: AbortSignal.timeout(120_000)});
      if (!page.ok) throw new Error(`Synthetic Projects page failed: ${node.log}`);
    }
    return app;
  } catch (failure) {await stop(); throw failure;}
}
