export async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/messages${path}`, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `Request failed (${response.status})`), { status: response.status });
  return data as T;
}
export const categories: Record<string, string> = { 'card.done': 'Done', 'card.needs-input': 'Needs you', 'improver.decision': 'Improver', 'job.failed': 'Job failed', 'system.error': 'Error', 'system.warning': 'Warning', convergence: 'Convergence', 'rules.applied': 'Rules' };
export function isActionable(message: { action?: { kind: string; answeredAt: string | null } | null }) { return !!message.action && ['question', 'approval', 'revert', 'cancel-send'].includes(message.action.kind) && !message.action.answeredAt; }
export function timestamp(value: string, now = new Date()) { const date = new Date(value); if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); if (now.getTime() - date.getTime() < 7 * 86400000) return date.toLocaleDateString('en-GB', { weekday: 'short' }); return date.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' }); }
