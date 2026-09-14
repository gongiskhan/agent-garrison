export type CommitPushResult = {
  project: string; cwd: string; status: 'pushed' | 'clean' | 'committed-no-origin' | 'no-origin'
    | 'skipped-session' | 'skipped-unknown-sessions' | 'dirty-conflict' | 'diverged' | 'failed';
  branch?: string; sha?: string; detail?: string; sessions?: number;
};
export type PullNodeRow = {
  node: string; status: 'replied' | 'no-reply'; branch: string | null; sha: string | null;
  merge: 'merged' | 'fast-forward' | 'up-to-date' | 'skipped-dirty' | 'conflict-card' | 'not-attempted';
  mergedSha?: string; cardId?: string; detail?: string;
};
export type PullResult = {project: string; from: string; nodes: PullNodeRow[]; merged: boolean; note: string};
export type PushResult = {
  project: string; from: string; local: CommitPushResult;
  cards: {node: string; cardId: string | null; title: string; status: 'filed' | 'failed'; detail?: string}[];
  note?: string;
};
export type ResultRow = {text: string; cardId?: string | null};
export const STATE_UNAVAILABLE = 'Shared state is unreachable. Git actions need it; browsing still works.';

export function commitSentence(result: CommitPushResult): string {
  switch (result.status) {
    case 'pushed': return `Committed and pushed ${result.sha?.slice(0, 7) ?? ''} to origin/${result.branch}.`;
    case 'clean': return 'Nothing to commit. Everything is already on origin.';
    case 'committed-no-origin':
    case 'no-origin': return 'Committed locally. This repository has no origin to push to.';
    case 'skipped-session': {
      const count = result.sessions ?? 0;
      return `Skipped: ${count} session${count === 1 ? '' : 's'} working in this tree. Try again when it is idle.`;
    }
    case 'skipped-unknown-sessions': return 'Skipped: the session registry could not be read, so nothing was committed.';
    case 'dirty-conflict': return `Skipped: ${sentenceDetail(result.detail)}.`;
    case 'diverged': return 'Not pushed: origin has commits this node does not. Pull from others first.';
    case 'failed': return `Failed: ${sentenceDetail(result.detail)}.`;
  }
}

function sentenceDetail(detail?: string) {return (detail || 'the operation could not complete').replace(/[.\s]+$/, '');}

export function pullRows(result: PullResult): ResultRow[] {
  return result.nodes.map(row => {
    if (row.status === 'no-reply') return {text: `${row.node}: no reply within 120 s`};
    switch (row.merge) {
      case 'merged':
      case 'fast-forward': return {text: `${row.node}: replied, merged ${(row.mergedSha || row.sha || '').slice(0, 7)}`, cardId: row.cardId};
      case 'up-to-date': return {text: `${row.node}: replied, already up to date`};
      case 'skipped-dirty': return {text: `${row.node}: replied, skipped, this tree is dirty`};
      case 'conflict-card': return {text: `${row.node}: replied, conflicts, a decision card was filed`, cardId: row.cardId};
      default: return {text: `${row.node}: replied, ${row.detail || 'nothing to merge'}`, cardId: row.cardId};
    }
  });
}

export function pushRows(result: PushResult): ResultRow[] {
  return result.cards.map(row => row.status === 'filed'
    ? {text: `${row.node}: merge card filed`, cardId: row.cardId}
    : {text: `${row.node}: could not file a card: ${row.detail || 'request failed'}`});
}

export function relativeTime(at: string, now = Date.now()) {
  const date = new Date(at), seconds = Math.max(0, (now - date.getTime()) / 1000);
  if (!Number.isFinite(seconds)) return at;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)} d ago`;
  return date.toLocaleDateString('en-GB', {day: 'numeric', month: 'short'});
}
