import {useEffect, useRef, type CSSProperties, type ReactNode} from 'react';
import {X} from 'lucide-react';

export type NodeRef = {id: string; name: string; accentColor: string; isSelf: boolean; state: 'online' | 'offline' | 'unknown'};
export type ProjectRef = {node: string; project: string};
export type ProjectRow = {project: string; root: string; isSelfCheckout: boolean};
export type ProjectSummary = {project: string; branch: string | null; head: string | null; upstream: string | null; ahead: number; behind: number; dirtyCount: number; stash: number; mergeInProgress: boolean; lastCommitAt: string | null};
export type ProjectList = {node: NodeRef; devRoot: string; projects: ProjectRow[]; workspace: {root: string; writable: boolean}; machines: {transport: string; label: string; root: string}[]};
export type Bridge = {render: (source: string) => string};
export class ApiError extends Error {
  constructor(public status: number, public body: {error?: string; size?: number}) {super(body.error || 'Request failed');}
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
export function NodeChip({node}: {node: NodeRef}) {
  const letters = node.name.split(/[\s._-]+/).filter(Boolean).map(word => word[0]).join('').slice(0, 2).toUpperCase();
  return <span className="projects-node-chip" style={nodeStyle(node)}><span className="projects-monogram" aria-hidden="true">{letters}</span><span>{node.name}</span></span>;
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
    const resize = () => dialog.style.setProperty('--sheet-height', `${window.visualViewport?.height ?? window.innerHeight}px`);
    resize(); window.visualViewport?.addEventListener('resize', resize);
    return () => {window.visualViewport?.removeEventListener('resize', resize); dialog.close();};
  }, []);
  return <dialog className="projects-sheet" ref={ref} aria-label={title} onCancel={event => {event.preventDefault(); close();}}><header><h2>{title}</h2><button type="button" aria-label="Close" onClick={close}><X size={20}/></button></header>{children}</dialog>;
}
