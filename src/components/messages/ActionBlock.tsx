import { useEffect, useState } from 'react';
import type { Message } from './types';
import { isActionable } from './client';
import styles from './messages.module.css';

export function ActionBlock({ message, onAnswer }: { message: Message; onAnswer: (message: Message, answer: string) => Promise<void> }) {
  const [text, setText] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [now, setNow] = useState(Date.now());
  const action = message.action;
  useEffect(() => { if (action?.kind !== 'revert' || action.answeredAt) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [action]);
  if (!action) return null;
  if (action.answeredAt) return <div className={styles.answered} data-testid="answered">Answered: {action.answer}</div>;
  const remaining = action.revertUntil ? Math.max(0, Math.ceil((Date.parse(action.revertUntil) - now) / 1000)) : null;
  const submit = async (answer: string) => { if (!answer.trim() || busy) return; setBusy(true); setError(''); try { await onAnswer(message, answer); } catch (err) { setError(err instanceof Error ? err.message : 'Could not answer. Retry.'); } finally { setBusy(false); } };
  return <section className={styles.actionBlock} aria-label="Message action"><p>{action.prompt}</p>{isActionable(message) && <div className={styles.actionButtons}>
    {action.kind === 'cancel-send' ? <button disabled={busy} onClick={() => void submit('cancel')}>Cancel send</button> : action.kind === 'approval' ? <><button disabled={busy} className={styles.primary} onClick={() => void submit('approve')}>Approve</button><button disabled={busy} onClick={() => void submit('reject')}>Reject</button></> : action.kind === 'revert' ? <><button disabled={busy || remaining === 0} onClick={() => void submit('revert')}>Revert</button><span aria-live="off">{remaining === null ? '' : remaining === 0 ? 'Revert window closed' : `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')} remaining`}</span></> : action.options?.length ? action.options.map(option => <button key={option} disabled={busy} onClick={() => void submit(option)}>{option}</button>) : <form onSubmit={event => { event.preventDefault(); void submit(text); }}><input aria-label="Your answer" value={text} onChange={event => setText(event.target.value)} placeholder="Your answer" /><button className={styles.primary} disabled={busy || !text.trim()}>Send</button></form>}
  </div>}{error && <p role="alert" className={styles.error}>{error}</p>}</section>;
}
