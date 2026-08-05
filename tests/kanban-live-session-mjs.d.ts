declare module "*/kanban-loop/lib/live-session.mjs" {
  export function liveSessionPointerFile(root: string, cardId: string, runSeq: number): string | null;
  export function writeLiveSessionPointer(root: string, card: any, identity: any, at?: string): Promise<any>;
  export function readLiveSessionPointer(root: string, card: any): Promise<any | null>;
  export function clearLiveSessionPointer(root: string, cardId: string, runSeq: number): Promise<boolean>;
}
