import { MessagesOfflineClient } from '../../../packages/messages/offline';
import type { PendingMessageAction } from '../../../packages/messages/offline';
async function transport<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/messages${path}`, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `Request failed (${response.status})`), { status: response.status });
  return data as T;
}
let offlineClient: MessagesOfflineClient | null = null;
function browserClient() { if (typeof window === 'undefined') return null; if (!offlineClient) offlineClient = new MessagesOfflineClient({ storage: window.localStorage, transport }); return offlineClient; }
export async function request<T>(path: string, body?: unknown): Promise<T> { const client = browserClient(); return client ? client.request<T>(path, body) : transport<T>(path, body); }
export const pendingActions = (): PendingMessageAction[] => browserClient()?.pending() || [];
export const subscribePending = (listener: () => void) => browserClient()?.subscribe(listener) || (() => {});
export async function flushPending() { const client = browserClient(); const hadPending = !!client?.pending().length; await client?.flush(); if (hadPending) window.dispatchEvent(new CustomEvent('messages.replayed')); }
export async function retryPending(id: string) { await browserClient()?.retry(id); window.dispatchEvent(new CustomEvent('messages.replayed')); }
export function discardPending(id: string) { browserClient()?.discard(id); window.dispatchEvent(new CustomEvent('messages.replayed')); }
export const categories: Record<string, string> = { 'card.done': 'Done', 'card.needs-input': 'Needs you', 'improver.decision': 'Improver', 'job.failed': 'Job failed', 'system.error': 'Error', 'system.warning': 'Warning', convergence: 'Convergence', 'rules.applied': 'Rules' };
export function isActionable(message: { action?: { kind: string; answeredAt: string | null } | null }) { return !!message.action && ['question', 'approval', 'revert', 'cancel-send'].includes(message.action.kind) && !message.action.answeredAt; }
export function timestamp(value: string, now = new Date()) { const date = new Date(value); if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); if (now.getTime() - date.getTime() < 7 * 86400000) return date.toLocaleDateString('en-GB', { weekday: 'short' }); return date.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' }); }

export interface ProviderLabel { id: string; name: string; type?: string }
const labelRequests = new Map<string, { expires: number; request: Promise<ProviderLabel[]> }>();
export function providerLabels(provider: string, account: string) { const key = `${provider}/${account}`; const previous = labelRequests.get(key); if (previous && previous.expires > Date.now()) return previous.request; const result = request<{ labels: ProviderLabel[] }>(`/providers/${encodeURIComponent(provider)}/labels?account=${encodeURIComponent(account)}`).then(data => data.labels); labelRequests.set(key, { expires: Date.now() + 30000, request: result }); result.catch(() => labelRequests.delete(key)); return result; }

export function accountProblem(provider: import('./types').Provider | undefined, accountId: string) { if (!provider) return ''; const account = provider.accounts.find(item => item.id === accountId); if (account?.setupHint) return account.setupHint; const health = provider.accountHealth?.[accountId]; if (health) return health.ok ? '' : health.reason || 'Account is unavailable'; return provider.setupHint || (provider.health?.ok === false ? provider.health.reason || 'Provider is unavailable' : ''); }
