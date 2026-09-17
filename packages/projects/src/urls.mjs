let self;
export function setSelfNode(id) {self = id;}
const encode = encodeURIComponent;
const suffix = value => String(value || '').replace(/^\/+/, '');
export function projectsUrl(ref, path = '') {
  const base = ref.node === self ? '/api/projects' : `/api/mesh/nodes/${encode(ref.node)}/projects`;
  return `${base}/${encode(ref.project)}${path ? `/${suffix(path)}` : ''}`;
}
export function workspaceUrl(node, path = '') {
  const base = node === self ? '/api/workspace' : `/api/mesh/nodes/${encode(node)}/workspace`;
  return `${base}${path ? `/${suffix(path)}` : ''}`;
}
export function listUrl(node = self) {
  return node === self ? '/api/projects' : `/api/mesh/nodes/${encode(node)}/projects`;
}
