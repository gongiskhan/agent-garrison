// Types for the sync manifest consumed by tests/state-client-drift.test.ts.
export interface SyncEntry {
  source: string;
  header: string;
  targets: string[];
}
export const SYNC_MANIFEST: SyncEntry[];
export function expectedBody(entry: SyncEntry): string;
