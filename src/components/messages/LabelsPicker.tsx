'use client';
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { Message, Provider } from './types';
import { request, providerLabels } from './client';
import styles from './management.module.css';
export function LabelsPicker({ message, provider, onClose, onChanged }: { message: Message; provider: Provider; onClose: () => void; onChanged: () => void }) {
  const [labels, setLabels] = useState<{ id: string; name: string; type?: string }[]>([]); const [chosen, setChosen] = useState(message.labels); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { void providerLabels(provider.id, message.account).then(data => setLabels(data.filter(label => label.type === 'user'))).catch(err => setError(err.message)); }, [message.account, provider.id]);
  const save = async () => { setBusy(true); setError(''); try { await request(`/${encodeURIComponent(message.id)}/state`, { labels: chosen }); onChanged(); onClose(); } catch { setChosen(message.labels); setError(`Could not update on ${provider.label}. Reverted.`); } finally { setBusy(false); } };
  return <div className={styles.backdrop} onClick={onClose}><section className={styles.dialog} role="dialog" aria-modal="true" aria-label="Labels" onClick={event => event.stopPropagation()}><header><h2>Labels</h2><button aria-label="Close labels" onClick={onClose}><X size={20} /></button></header>{error && <p role="alert">{error}</p>}{labels.map(label => <label className={styles.checkbox} key={label.id}><input type="checkbox" checked={chosen.includes(label.id)} onChange={event => setChosen(current => event.target.checked ? [...current, label.id] : current.filter(id => id !== label.id))} />{label.name}</label>)}{!labels.length && !error && <p>No labels available.</p>}<footer><button onClick={onClose}>Cancel</button><button className={styles.primary} disabled={busy || !labels.length} onClick={() => void save()}>Apply labels</button></footer></section></div>;
}
