import {useEffect, useRef, type ComponentType, type CSSProperties, type ReactNode} from 'react';
import {X} from 'lucide-react';
import {STATE_UNAVAILABLE} from './git-results';

export type NodeRef = {id: string; name: string; accentColor: string; isSelf: boolean; state: 'online' | 'offline' | 'unknown'};
export type ProjectRef = {node: string; project: string};
export type ProjectRow = {project: string; root: string; isSelfCheckout: boolean};
export type ProjectSummary = {project: string; branch: string | null; head: string | null; upstream: string | null; ahead: number; behind: number; dirtyCount: number; stash: number; mergeInProgress: boolean; lastCommitAt: string | null};
export type ProjectList = {node: NodeRef; devRoot: string; projects: ProjectRow[]; workspace: {root: string; writable: boolean}; machines: {transport: string; label: string; root: string}[]};
export type Bridge = {render: (source: string) => string; NodeChip: ComponentType<{node: NodeRef}>};
export class ApiError extends Error {
  constructor(public status: number, public body: {error?: string; size?: number}) {super(body.error || 'Request failed');}
}
export function failureMessage(failure: unknown, node: string) {
  if (failure instanceof ApiError) {
    if (failure.status === 503 && (!failure.body.error || /state.*(?:unreachable|unavailable)/i.test(failure.body.error))) return STATE_UNAVAILABLE;
    if (!failure.body.error || ['peer-unreachable', 'peer-unaddressable', 'peer-read-failed'].includes(failure.body.error)) return `${node} did not answer.`;
  }
  return failure instanceof Error && !(failure instanceof TypeError) ? failure.message : `${node} did not answer.`;
}
export async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {cache: 'no-store', ...options});
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, body);
  return body;
}
export function nodeStyle(node: NodeRef): CSSProperties {
  return {'--node-accent': node.accentColor} as CSSProperties;
}
export function Skeleton({subtitle = false}: {subtitle?: boolean}) {
  return subtitle ? <span className="projects-shimmer projects-subtitle-shimmer" aria-label="Reading summary"/> : <div className="projects-skeleton" aria-label="Reading items">{[0, 1, 2].map(n => <div className="projects-shimmer" key={n}/>)}</div>;
}
export function Banner({children, retry}: {children: ReactNode; retry?: () => void}) {
  return <div className="projects-banner projects-error" role="alert"><span>{children}</span>{retry && <button type="button" onClick={retry}>Try again</button>}</div>;
}
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const unit = bytes < 1024 * 1024 ? 'KB' : 'MB';
  const value = bytes / (unit === 'KB' ? 1024 : 1024 * 1024);
  return `${value >= 10 ? Math.round(value) : Number(value.toFixed(1))} ${unit}`;
}
export function Sheet({title, children, close}: {title: string; children: ReactNode; close: () => void}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    const viewport = window.visualViewport;
    const resize = () => {
      const height = viewport?.height ?? window.innerHeight, top = viewport?.offsetTop ?? 0;
      dialog.style.setProperty('--sheet-height', `${height}px`);
      dialog.style.setProperty('--sheet-top', `${top}px`);
      dialog.style.setProperty('--sheet-bottom', `${Math.max(0, window.innerHeight - height - top)}px`);
    };
    resize(); viewport?.addEventListener('resize', resize); viewport?.addEventListener('scroll', resize); window.addEventListener('resize', resize);
    return () => {viewport?.removeEventListener('resize', resize); viewport?.removeEventListener('scroll', resize); window.removeEventListener('resize', resize); dialog.close();};
  }, []);
  return <dialog className="projects-sheet" ref={ref} aria-label={title} onCancel={event => {event.preventDefault(); close();}}><header><h2>{title}</h2><button type="button" aria-label="Close" onClick={close}><X size={20}/></button></header>{children}</dialog>;
}
