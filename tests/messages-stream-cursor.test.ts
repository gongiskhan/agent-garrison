import { expect, it } from 'vitest';
import { messagesDbFixture } from './messages-db-fixture';
import { acquireIngestLease, ingestBatch, listMessages } from '../services/state/src/messages/store.mjs';
import { baseConversation, baseMessage } from '../packages/messages/providers/shared';

it('retains the reconciliation cursor across stream gaps and lease handover', () => {
  const f = messagesDbFixture();
  try {
    const provider = 'chat-fixture', account = f.account;
    const conversation = baseConversation(provider, account, 'channel', 'dm', 'Fixture', f.ts);
    const message = (id: string) => ({ ...baseMessage(provider, account, id, conversation.id, f.ts, f.ts), bodyText: id });
    const lease = f.db.prepare('SELECT fence FROM messages_ingest_lease').get();
    const batch = (actor: string, fence: number, messages: ReturnType<typeof message>[], extra: Record<string, unknown>) =>
      ingestBatch(f.db, { name: actor }, { provider, account, fence, conversations: [conversation], messages, ...extra });
    batch(f.node, lease.fence!, [message('before-stream')], { cursor: { receivedTs: '2026-09-13T12:00:00.000Z' } });
    // A message in the poll-to-stream gap must remain discoverable by the next owner.
    batch(f.node, lease.fence!, [message('later-stream-event')], { advanceCursor: false, cursor: { receivedTs: '2026-09-13T12:00:02.000Z' } });
    expect(JSON.parse(f.db.prepare('SELECT cursor FROM messages_sync WHERE provider=? AND account=?').get(provider, account).cursor)).toEqual({ receivedTs: '2026-09-13T12:00:00.000Z' });
    f.db.prepare("UPDATE messages_ingest_lease SET expiresAt='2000-01-01T00:00:00.000Z'").run();
    const next = acquireIngestLease(f.db, 'next-owner');
    expect(() => batch(f.node, lease.fence!, [message('expired-owner')], { advanceCursor: false })).toThrow('Ingest lease lost');
    const replay = batch('next-owner', next.fence!, [message('gap-message'), message('later-stream-event')], { cursor: { receivedTs: '2026-09-13T12:00:03.000Z' } });
    expect(replay.changed).toBe(1);
    expect(listMessages(f.db, { providers: [provider] }).messages.map((item: any) => item.externalId).sort()).toEqual(['before-stream', 'gap-message', 'later-stream-event']);
    expect(batch('next-owner', next.fence!, [message('gap-message'), message('later-stream-event')], { cursor: { receivedTs: '2026-09-13T12:00:03.000Z' } }).changed).toBe(0);
  } finally { f.close(); }
});
