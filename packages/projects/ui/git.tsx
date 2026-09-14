import {useCallback, useEffect, useRef, useState, type FormEvent} from 'react';
import Link from 'next/link';
import {useSearchParams} from 'next/navigation';
import {ChevronLeft, LoaderCircle, RefreshCw} from 'lucide-react';
import {projectsUrl} from '../src/urls.mjs';
import {ApiError, Banner, Sheet, Skeleton, failureMessage, request, type NodeRef, type ProjectRef} from './common';
import {Diff, type GitDiff} from './diff';
import {commitSentence, pullRows, pushRows, relativeTime, STATE_UNAVAILABLE, type CommitPushResult, type PullResult, type PushResult, type ResultRow} from './git-results';

export type DirtyEntry = {xy: string; path: string; state: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict' | 'other'; staged: boolean};
export type GitStatus = {
  project: string; root: string; branch: string | null; head: string | null; upstream: string | null;
  ahead: number; behind: number; dirty: DirtyEntry[]; dirtyCount: number; stash: number;
  inProgress: string[]; mergeInProgress: boolean;
};
type Commit = {sha: string; short: string; author: string; at: string; subject: string};
type GitLog = {project: string; commits: Commit[]; limit: number};
type Action = 'fetch' | 'commit-push' | 'pull-from-others' | 'push-to-others';
const actions: {id: Action; label: string}[] = [
  {id: 'fetch', label: 'Fetch'}, {id: 'commit-push', label: 'Commit and push'},
  {id: 'pull-from-others', label: 'Pull from others'}, {id: 'push-to-others', label: 'Push to others'}
];
type Result = {first?: string; rows?: ResultRow[]; note?: string};

function ChangePath({path}: {path: string}) {
  const slash = path.lastIndexOf('/');
  return <span className="projects-change-path"><span>{slash >= 0 ? path.slice(0, slash + 1) : ''}</span><strong>{path.slice(slash + 1)}</strong></span>;
}

export function Git({reference, node, base, stateUnavailable = false}: {reference: ProjectRef; node: NodeRef; base: string; stateUnavailable?: boolean}) {
  const query = useSearchParams(), diffPath = query.get('diff'), staged = query.get('staged') === '1';
  const statusUrl = projectsUrl(reference, 'git/status'), logUrl = projectsUrl(reference, 'git/log?limit=30');
  const diffUrl = projectsUrl(reference, `git/diff?path=${encodeURIComponent(diffPath || '')}&staged=${staged ? '1' : '0'}`);
  const [status, setStatus] = useState<GitStatus | null>(null), [log, setLog] = useState<GitLog | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [unavailable, setUnavailable] = useState(stateUnavailable);
  const [working, setWorking] = useState<Action | null>(null), lock = useRef(false);
  const [sheet, showSheet] = useState(false), [message, setMessage] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [diff, setDiff] = useState<GitDiff | null>(null), [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState(''), [binary, setBinary] = useState(false), [diffRevision, retryDiff] = useState(0);

  useEffect(() => {if (stateUnavailable) setUnavailable(true);}, [stateUnavailable]);
  const reportError = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 503) {setUnavailable(true); setError(STATE_UNAVAILABLE);}
    else setError(failureMessage(failure, node.name));
  }, [node.name]);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const [nextStatus, nextLog] = await Promise.all([request<GitStatus>(statusUrl, {signal}), request<GitLog>(logUrl, {signal})]);
    if (!signal?.aborted) {setStatus(nextStatus); setLog(nextLog);}
    return nextStatus;
  }, [statusUrl, logUrl]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setStatus(null); setLog(null); setResult(null); setUnavailable(stateUnavailable);
    void refresh(controller.signal).catch(failure => {if (!controller.signal.aborted) reportError(failure);})
      .finally(() => {if (!controller.signal.aborted) setLoading(false);});
    return () => controller.abort();
  }, [refresh, reportError, stateUnavailable]);

  useEffect(() => {
    setDiff(null); setDiffError(''); setBinary(false);
    if (diffPath === null) {setDiffLoading(false); return;}
    const controller = new AbortController();
    setDiffLoading(true);
    void request<GitDiff>(diffUrl, {signal: controller.signal}).then(setDiff).catch(failure => {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && failure.status === 415) setBinary(true);
      else setDiffError(failureMessage(failure, node.name));
    }).finally(() => {if (!controller.signal.aborted) setDiffLoading(false);});
    return () => controller.abort();
  }, [diffUrl, diffPath, diffRevision, node.name]);

  async function run(action: Action, body: Record<string, unknown> = {}) {
    if (lock.current || unavailable) return;
    lock.current = true; setWorking(action); setResult(null); setError(''); showSheet(false);
    try {
      const response = await request<CommitPushResult | PullResult | PushResult | {ok: boolean; output: string; code: number}>(projectsUrl(reference, `git/${action}`), {
        method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)
      });
      if (action === 'commit-push') setResult({first: commitSentence(response as CommitPushResult)});
      if (action === 'pull-from-others') {const pull = response as PullResult; setResult({rows: pullRows(pull), note: pull.note});}
      if (action === 'push-to-others') {
        const push = response as PushResult;
        setResult({first: commitSentence(push.local), rows: pushRows(push), note: !['pushed', 'clean'].includes(push.local.status) ? 'Nothing was filed: this node could not publish its branch.' : push.note});
      }
      if (action === 'fetch') {
        const fetched = response as {ok: boolean; output: string};
        if (!fetched.ok) setResult({first: `Fetch failed: ${fetched.output.split(/\r?\n/)[0].replace(/[.\s]+$/, '') || 'request failed'}.`});
        else {
          const next = await refresh();
          setResult({first: `Fetched. ${next.behind} behind, ${next.ahead} ahead.`});
        }
      }
      if (action !== 'fetch') await refresh();
      retryDiff(value => value + 1);
    } catch (failure) {reportError(failure);}
    finally {lock.current = false; setWorking(null);}
  }

  function commit(event: FormEvent) {event.preventDefault(); void run('commit-push', {message});}
  const disabled = Boolean(working) || unavailable || loading || !status;
  return <div className={`projects-git${diffPath !== null ? ' projects-diff-open' : ''}`}>
    {error && <Banner retry={unavailable ? undefined : () => {setError(''); void refresh().catch(reportError);}}>{error}</Banner>}
    {unavailable && !error && <Banner>{STATE_UNAVAILABLE}</Banner>}
    {loading ? <Skeleton/> : <>
      {status && <div className="projects-status-strip"><div className="projects-status-chips">
        <span className="projects-chip">{status.branch || `detached at ${status.head?.slice(0, 7) || 'unknown'}`}</span>
        {status.ahead > 0 && <span className="projects-chip">{status.ahead} ahead</span>}
        {status.behind > 0 && <span className="projects-chip">{status.behind} behind</span>}
        {status.dirtyCount > 0 && <span className="projects-chip">{status.dirtyCount} changed</span>}
        {status.stash > 0 && <span className="projects-chip">{status.stash} stash</span>}
        {status.mergeInProgress && <span className="projects-chip projects-chip-danger">merge in progress</span>}
      </div><button type="button" disabled={Boolean(working)} onClick={() => {setError(''); void refresh().catch(reportError);}}><RefreshCw size={16}/>Refresh</button></div>}
      <div className="projects-git-actions">{actions.map(action => <button key={action.id} type="button" disabled={disabled} onClick={() => {
        if (action.id === 'commit-push') {setMessage(`workspace: commit-push snapshot from ${node.id}`); showSheet(true);}
        else void run(action.id);
      }}>{working === action.id ? <><LoaderCircle size={18} className="projects-working"/>Working</> : action.label}</button>)}</div>
      {result && <div className="projects-action-result" role="status">
        {result.first && <p>{result.first}</p>}
        {result.rows?.map((row, index) => <p key={index}>{row.text}{row.cardId && <> <Link href={`/embed/kanban-loop?card=${encodeURIComponent(row.cardId)}`}>Open card</Link></>}</p>)}
        {result.note && <p>{result.note}</p>}
      </div>}
      <div className="projects-git-layout"><div className="projects-git-sections">
        <section aria-label="Changes"><h2>Changes ({status?.dirtyCount ?? 0})</h2>
          {status?.dirty.map(entry => <Link className="projects-change-row" key={entry.path} href={`${base}?diff=${encodeURIComponent(entry.path)}${entry.staged ? '&staged=1' : ''}`}>
            <span className={`projects-dirty-badge projects-dirty-${entry.state}`}>{entry.xy}</span><ChangePath path={entry.path}/>
          </Link>)}
          {status?.dirtyCount === 0 && <p className="projects-empty">Nothing to commit. The tree is clean.</p>}
        </section>
        <section aria-label="Commits"><h2>Commits (30)</h2>
          {log?.commits.map(item => <article className="projects-commit-row" key={item.sha}><code>{item.short}</code><div><p>{item.subject}</p><small>{item.author} · <time dateTime={item.at}>{relativeTime(item.at)}</time></small></div></article>)}
        </section>
      </div>
        {diffPath !== null && <section className="projects-diff-view" aria-label="Diff view">
          <header><Link className="projects-diff-back" href={base}><ChevronLeft size={18}/>Back to changes</Link><h2>{diffPath || 'All changes'}</h2><span className="projects-chip">{staged ? 'staged' : 'working tree'}</span></header>
          {diffLoading ? <Skeleton/> : diffError ? <Banner retry={() => retryDiff(value => value + 1)}>{diffError}</Banner> : <Diff diff={diff} binary={binary}/>}
        </section>}
      </div>
    </>}
    {sheet && <Sheet title="Commit and push" close={() => showSheet(false)}><form onSubmit={commit}>
      <label>Commit message<textarea autoFocus value={message} onChange={event => setMessage(event.target.value)} rows={4}/></label>
      <div className="projects-sheet-actions"><button type="button" onClick={() => showSheet(false)}>Cancel</button><button type="submit" disabled={!message.trim() || disabled}>Commit and push</button></div>
    </form></Sheet>}
  </div>;
}
