import { useEffect, useState } from 'react';
import type { RailSession } from './sessions-rail';

export interface CursorConversationState {
  node_id: string;
  conversation_id: string;
  model: string | null;
  state: 'discovered' | 'working' | 'holding_short' | 'holding_long' | 'released' | 'ended' | 'stalled';
  attached: boolean;
  hold_deadline_at: number | null;
  workspace_roots: string[];
}

export function cursorStateLabel(state: CursorConversationState['state']): string {
  if (state === 'holding_short' || state === 'holding_long') return 'Waiting';
  if (state === 'released') return 'Released';
  if (state === 'ended') return 'Ended';
  if (state === 'stalled') return 'Stalled';
  return 'Working';
}

export function mergeCursorRows(history: RailSession[], live: RailSession[]): RailSession[] {
  const owned = new Set(live.map(row => `${row.node}\0${row.id}`));
  return [...live, ...history.filter(row => !owned.has(`${row.node}\0${row.id}`))];
}

export function useCursorSessions(): RailSession[] {
  const [rows, setRows] = useState<RailSession[]>([]);
  useEffect(() => {
    const source = new EventSource('/api/cursor/events');
    source.onmessage = message => {
      try {
        const update = JSON.parse(message.data);
        if (Array.isArray(update.rows)) setRows(update.rows);
        else if (update.row?.cursor) setRows(previous => mergeCursorRows(previous, [update.row]));
      } catch {}
    };
    source.onerror = () => setRows(previous => previous.map(row => ({ ...row, connection: 'disconnected' })));
    return () => source.close();
  }, []);
  return rows;
}
