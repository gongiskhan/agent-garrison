export type GitDiff = {project: string; path: string | null; staged: boolean; text: string; truncated: boolean; capBytes: number; binary: string[]};
type DiffLine = {text: string; kind: 'hunk' | 'added' | 'removed' | 'context' | 'meta'; old: number | null; next: number | null};

export function diffLines(text: string): DiffLine[] {
  let old = 0, next = 0, inHunk = false;
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map(line => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {old = Number(hunk[1]); next = Number(hunk[2]); inHunk = true; return {text: line, kind: 'hunk', old: null, next: null};}
    if (line.startsWith('diff --git ')) inHunk = false;
    if (inHunk && line.startsWith('+')) return {text: line, kind: 'added', old: null, next: next++};
    if (inHunk && line.startsWith('-')) return {text: line, kind: 'removed', old: old++, next: null};
    if (inHunk && line.startsWith(' ')) return {text: line, kind: 'context', old: old++, next: next++};
    return {text: line, kind: 'meta', old: null, next: null};
  });
}

export function Diff({diff, binary = false}: {diff: GitDiff | null; binary?: boolean}) {
  if (binary) return <p className="projects-empty">This is a binary file; there is no text diff.</p>;
  if (!diff) return null;
  return <div className="projects-diff-scroll" tabIndex={0} role="region" aria-label="Unified diff"><pre className="projects-diff">{diffLines(diff.text).map((line, index) => <span className={`projects-diff-line projects-diff-${line.kind}`} key={index}><span className="projects-diff-number" aria-hidden="true">{line.old ?? ''}</span><span className="projects-diff-number" aria-hidden="true">{line.next ?? ''}</span><code>{line.text || ' '}</code></span>)}</pre>{!diff.text && <p className="projects-empty">No changes in this diff.</p>}{diff.truncated && <p className="projects-diff-truncated">Diff truncated at 500 KB.</p>}</div>;
}
