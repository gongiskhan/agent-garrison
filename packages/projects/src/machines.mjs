import path from 'node:path';
import {HttpError, MAX_TEXT_BYTES, isSensitive, kindFor, relativePath} from './fs.mjs';

export const MACHINES_UNAVAILABLE = 'the remote-shell fitting is not running, so machines are unavailable';
export function createMachines({discover = async () => null, fetchImpl = fetch} = {}) {
  async function get(base, resource, timeoutMs) {
    const response = await fetchImpl(`${base.replace(/\/+$/, '')}/${resource}`, {signal: AbortSignal.timeout(timeoutMs), cache: 'no-store'});
    const data = await response.json();
    if (!response.ok || data.error) throw new HttpError(response.ok ? 502 : response.status, data.error || 'machine did not answer');
    return data;
  }
  return {
    async list() {
      try {
        const base = await discover();
        if (!base) return [];
        const data = await get(base, 'transports', 8000);
        return (data.transports || []).filter(row => typeof row.name === 'string' && /^[A-Za-z0-9._-]{1,512}$/.test(row.name) && !['.', '..'].includes(row.name)).map(row => ({transport: row.name, label: row.label || row.name, root: row.cwd || '~'}));
      } catch {return [];}
    },
    async handle(request, transport, action) {
      if (request.method !== 'GET') throw new HttpError(405, 'method not allowed');
      if (!['tree', 'file'].includes(action)) throw new HttpError(404, 'not found');
      if (!/^[A-Za-z0-9._-]{1,512}$/.test(transport) || ['.', '..'].includes(transport)) throw new HttpError(400, 'invalid machine');
      const rel = relativePath(new URL(request.url).searchParams.get('path') || '');
      if (isSensitive(rel)) throw new HttpError(403, 'file not browsable');
      const base = await discover();
      if (!base) throw new HttpError(503, MACHINES_UNAVAILABLE);
      const data = await get(base, `transports/${encodeURIComponent(transport)}/${action === 'tree' ? 'files' : 'file'}?path=${encodeURIComponent(rel)}`, action === 'tree' ? 25_000 : 35_000);
      if (action === 'tree') {
        const items = (data.entries || []).filter(entry => !isSensitive(entry.path)).map(entry => ({name: entry.name, path: entry.path, type: entry.type === 'dir' ? 'dir' : 'file', size: entry.size})).sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
        return {source: `machine:${transport}`, path: data.path, writable: false, items};
      }
      if (data.truncated || data.size > MAX_TEXT_BYTES) throw new HttpError(413, 'file too large to open in the browser', {size: data.size});
      const kind = kindFor(rel), encoding = kind === 'image' ? 'base64' : 'utf8';
      return {path: rel, kind, encoding, content: kind === 'image' ? data.base64 : Buffer.from(data.base64, 'base64').toString('utf8'), ...(kind === 'image' ? {ext: path.extname(rel).slice(1)} : {}), readOnly: true};
    }
  };
}
