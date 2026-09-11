import { isDeepStrictEqual } from 'node:util';
import { parseDocument, Document } from 'yaml';

export function parseFrontmatter(markdown, fallbackTitle = '') {
  const raw = String(markdown); const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) return { frontmatter: {}, body: raw, document: new Document(), ...(raw.startsWith('---') ? { parseWarning: 'Malformed frontmatter' } : {}) };
  const document = parseDocument(match[1], { uniqueKeys: true });
  let frontmatter;
  try { frontmatter = document.toJS(); } catch { /* Malformed documents use a tolerant view. */ }
  if (document.errors.length || !frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    return { frontmatter: { title: fallbackTitle }, body: raw.slice(match[0].length), document: new Document(), parseWarning: 'Malformed frontmatter' };
  }
  return { frontmatter, body: raw.slice(match[0].length), document };
}
export function stringifyFrontmatter(frontmatter, body, original) {
  const document = original?.document?.clone() ?? new Document();
  for (const key of Object.keys(original?.frontmatter ?? {})) if (!(key in frontmatter)) document.delete(key);
  const before = document.toJS() ?? {};
  for (const [key, value] of Object.entries(frontmatter)) if (value !== undefined && !isDeepStrictEqual(before[key], value)) document.set(key, value);
  return `---\n${document.toString({ lineWidth: 0 })}---\n${String(body).replace(/^\n+/, '').replace(/\n*$/, '\n')}`;
}
