import {HttpError, tree, read} from './fs.mjs';
import {createWorkspace, workspaceRoot} from './workspace.mjs';
import {gitDiff, gitFetch, gitHead, gitLog, gitStatus} from './git.mjs';
import {commitPushProject, pullFromOthers, pushToOthers, stateClient} from './merge.mjs';

export const READ_ONLY = 'project trees are read-only; changes move through git';
// This is the URL namespace, not a filesystem resolver. The injected resolver
// alone decides whether a name identifies a confined repository on this node.
export function validProject(name) {
  return typeof name === 'string' && /^[A-Za-z0-9._-]{1,512}$/.test(name)
    && !name.startsWith('.') && !name.includes('..') && !['machines', 'workspace'].includes(name);
}

export function json(status, body) {
  return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json', 'cache-control': 'no-store'}});
}

export function failure(error) {
  if (error.name === 'StateUnavailableError') return json(503, {error: 'Shared state is unreachable. Git actions need it; browsing still works.'});
  const status = error.status || ({ENOENT: 404, ENOTDIR: 400, EACCES: 403, EPERM: 403, ELOOP: 403, EMLINK: 403}[error.code]) || 500;
  const message = error.code === 'ENOENT' ? 'not found' : error.code === 'ENOTDIR' ? 'not a directory'
    : ['ELOOP', 'EMLINK'].includes(error.code) ? 'path escapes workspace root' : error.message || 'request failed';
  return json(status, {error: message, ...error.fields});
}

export function originBlocked(request) {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  try {
    if (new URL(origin).host.toLowerCase() === (request.headers.get('host') || new URL(request.url).host).toLowerCase()) return null;
  } catch { /* An invalid origin is refused too. */ }
  return json(403, {error: 'forbidden'});
}

export async function requestBody(request, {optional = false} = {}) {
  let body;
  try {
    const text = await request.text();
    body = optional && !text.trim() ? {} : JSON.parse(text);
  } catch {throw new HttpError(400, 'invalid JSON');}
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'JSON object required');
  return body;
}

export function createProjectsService({resolveProject, listProjects, devRoot, selfCheckout, node, env = process.env, machines, withState, log = console.info, guard = () => null}) {
  const workspace = createWorkspace(workspaceRoot(env));
  const useState = withState ?? (callback => callback(stateClient(env)));
  function projectScope(project) {
    if (!validProject(project)) throw new HttpError(400, 'invalid project');
    const root = resolveProject(project);
    if (!root) throw new HttpError(404, 'no such project');
    return {project, root, source: `project:${project}`, writable: false};
  }
  async function summary(project) {
    const scope = projectScope(project), status = await gitStatus(scope.root);
    const last = status.head ? (await gitLog(scope.root, {limit: 1})).commits[0] : null;
    const {branch, head, upstream, ahead, behind, dirtyCount, stash, mergeInProgress} = status;
    return {project, branch, head, upstream, ahead, behind, dirtyCount, stash, mergeInProgress, lastCommitAt: last?.at ?? null};
  }
  async function handle(request, segments = [], area = 'projects') {
    const blocked = guard(request) || originBlocked(request);
    if (blocked) return blocked;
    try {
      const method = request.method, url = new URL(request.url), rel = url.searchParams.get('path') || '';
      if (area === 'workspace') {
        if (segments.length !== 1) return json(404, {error: 'not found'});
        const action = segments[0];
        if (method === 'GET' && action === 'tree') return json(200, await workspace.tree(rel));
        if (method === 'GET' && action === 'file') return json(200, await workspace.read(rel));
        if (method === 'PUT' && action === 'file') {
          const body = await requestBody(request);
          return json(200, await workspace.write(body.path, body.content, body.encoding));
        }
        if (method === 'POST' && action === 'mkdir') return json(200, await workspace.mkdir((await requestBody(request)).path));
        return json(405, {error: 'method not allowed'});
      }
      if (!segments.length) {
        if (method !== 'GET') return json(405, {error: 'method not allowed'});
        const checkout = selfCheckout?.();
        const projects = listProjects().filter(validProject).flatMap(project => {
          const root = resolveProject(project);
          return root ? [{project, root, isSelfCheckout: root === checkout?.root}] : [];
        });
        return json(200, {node: node(), devRoot: devRoot(), projects, workspace: {root: workspace.root, writable: true}, machines: await machines?.list() ?? []});
      }
      if (segments[0] === 'machines') {
        if (segments.length !== 3) throw new HttpError(400, 'invalid project');
        if (!machines) throw new HttpError(503, 'the remote-shell fitting is not running, so machines are unavailable');
        return json(200, await machines.handle(request, segments[1], segments[2]));
      }
      const scope = projectScope(segments[0]);
      if (segments.length === 3 && segments[1] === 'git') {
        const action = segments[2];
        const methods = {status: 'GET', diff: 'GET', log: 'GET', fetch: 'POST', 'commit-push': 'POST', 'pull-from-others': 'POST', 'push-to-others': 'POST'};
        if (!Object.hasOwn(methods, action)) return json(404, {error: 'not found'});
        if (method !== methods[action]) return json(405, {error: 'method not allowed'});
        const identity = node();
        log(`[projects] git ${action} project=${scope.project} node=${identity.id}`);
        if (action === 'status') return json(200, {project: scope.project, root: scope.root, ...await gitStatus(scope.root)});
        if (action === 'diff') {
          const diff = await gitDiff(scope.root, {relPath: rel || null, staged: url.searchParams.get('staged') === '1'});
          return json(200, {project: scope.project, path: diff.path, staged: diff.staged, text: diff.diff, truncated: diff.truncated, capBytes: diff.cap, binary: diff.binary});
        }
        if (action === 'log') {
          const input = url.searchParams.get('limit'), number = input === null ? 30 : Number(input);
          const limit = Number.isFinite(number) ? Math.min(200, Math.max(1, Math.trunc(number))) : 30;
          const history = await gitHead(scope.root) ? await gitLog(scope.root, {limit}) : {commits: [], limit};
          return json(200, {project: scope.project, ...history});
        }
        const body = await requestBody(request, {optional: true});
        if (action === 'commit-push') {
          if (body.message !== undefined && (typeof body.message !== 'string' || !body.message.trim())) throw new HttpError(400, 'commit message required');
          if (body.force !== undefined && typeof body.force !== 'boolean') throw new HttpError(400, 'force must be a boolean');
        }
        if (action === 'push-to-others' && body.targets !== undefined
          && (!Array.isArray(body.targets) || body.targets.some(target => typeof target !== 'string' || !/^[A-Za-z0-9._-]{1,512}$/.test(target)))) throw new HttpError(400, 'invalid targets');
        return json(200, await useState(async client => {
          const options = {client, resolveProject, env: {...env, GARRISON_NODE_NAME: identity.id}};
          if (action === 'fetch') {await client.health(); return gitFetch(scope.root);}
          if (action === 'commit-push') return commitPushProject(scope.project, {...options, message: body.message, force: body.force === true});
          if (action === 'pull-from-others') return pullFromOthers(scope.project, options);
          return pushToOthers(scope.project, {...options, targets: body.targets});
        }));
      }
      if (segments.length === 2) {
        const action = segments[1];
        if ((method === 'PUT' && action === 'file') || (method === 'POST' && action === 'mkdir')) return json(403, {error: READ_ONLY});
        if (method === 'GET' && action === 'summary') return json(200, await summary(scope.project));
        if (method === 'GET' && action === 'tree') return json(200, await tree(scope, rel));
        if (method === 'GET' && action === 'file') return json(200, await read(scope, rel));
      }
      return json(404, {error: 'not found'});
    } catch (error) {
      return failure(error);
    }
  }
  return {handle, summary, projectScope, workspace};
}
