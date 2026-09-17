# Messages

Messages is the shell's common inbox at `/messages`. System notices, mail and chat use one relational store in the state authority on dev-madrid. All, Agents, Mail, Chat and saved views are filters over that store. The provider badge remains visible in every view.

## Code and data

The shared contracts, filters, provider transforms and restricted ingestion worker live in `packages/messages/`. The SQL migration and state API live in `services/state/migrations/003-messages.sql` and `services/state/src/messages/`. The shell runtime is `src/lib/messages-runtime.ts`; HTTP routes are under `src/app/api/messages/`; components are under `src/components/messages/`.

Conversations group messages by provider and account. The unique `(provider, account, externalId)` key makes resync an upsert. Message and cursor writes are atomic, and an expired ingestion fence cannot commit. FTS5 triggers index subject, plain text, sender name, attachment names and transcripts. Binary content never enters SQLite. Derived attachment metadata survives provider refreshes.

The schema adds ownership metadata because file paths name files on a particular node. `ownerNode`, `htmlOwnerNode`, `rawOwnerNode` and attachment ownership route reads and file cleanup to that owner. System actions retain immutable target identities, including the original question and proposal revision. This makes a stale answer fail visibly instead of answering a newer question. `triage` remains null.

## Emitting a system message

```js
import { emitSystemMessage } from '../../packages/messages/system.mjs';

await emitSystemMessage({
  category: 'job.failed',
  severity: 'error',
  title: 'Backup needs a retry',
  body: 'The destination was unavailable.',
  idempotencyKey: `backup:${runId}:failed`,
  cardId,
  attachments: [{ path: localReportPath, name: 'report.txt', mime: 'text/plain' }],
});
```

Choose a stable source-event identity. Repeated delivery of the same event updates the same message. File attachments are copied into the emitting node's Messages directory and only metadata reaches state. Fittings may use the node-authenticated `POST /api/messages/system` endpoint. Producers persist messages; the delivery worker reads stored messages and calls existing channels, preserving their toggles. Omi cloud stays retired.

Questions use the existing owner-routed conversation signal path. Answers carry a stable request id and the original question id. Approvals accept explicit approve or reject values. Improver reverts retain the original proposal revision and expiry. The Command Center can query `/api/messages/needs-me`; there is no second Attention store.

## Provider contract and registration

`packages/messages/types.ts` is the contract. A descriptor describes accounts, badge, kind, sync mode, setup state and capabilities. Adapter methods are plain promise-returning functions with no framework types. Read, action and send implementations are separate. The UI uses capabilities to choose controls.

Google and Slack declare `x-garrison.connector.messaging` in their connector manifests. The runtime discovers those declarations and independently addressed account grants. A fitting registers a descriptor and callback URL on startup. For example, a future chat connector can expose its public adapter over HTTP:

```js
const descriptor = {
  id: 'example-chat', kind: 'chat', label: 'Example',
  badge: { text: 'Example', color: '#315941', glyph: 'MessageCircle' },
  accounts: [{ id: 'personal', label: 'Personal' }],
  capabilities: {
    read: true, send: true, reply: true, markRead: true,
    archive: false, delete: false, groups: true, threads: false,
    attachments: true, audioReceive: true, audioSend: false,
    markdown: true, code: true, reactionsRead: false, openInProvider: false,
  },
  sync: { mode: 'poll', intervalSeconds: 60 }, setupHint: null,
};
await fetch(`${process.env.GARRISON_APP_URL}/api/messages/providers/register`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${process.env.GARRISON_STATE_TOKEN}`,
  },
  body: JSON.stringify({ descriptor, callbackBaseUrl: `${fittingUrl}/messages-adapter` }),
});
```

The callback must belong to that node's running fitting. Remote routing uses the owner's published fitting view. Implement `POST fetchMessages` with account and cursor, returning messages, conversations and the next cursor; `POST downloadAttachment` returns bounded file bytes with MIME metadata. Stream providers additionally expose `GET events` with normalized batches and reconcile before opening the stream. Keep credentials inside the fitting. Mutating methods are called through the separately authenticated owner action path, never the ingestion transport. A send callback receives a canonical OutboxItem retrieved from shared state, rather than a caller-supplied replacement body.

Registering this descriptor requires no Messages UI change. A setup failure leaves historical messages visible and disables unavailable actions. The fixture-only demo uses the same callback path and is refused in production.

Google polls history every 120 seconds after a 30-day, 2000-message backfill per account. Slack enumerates user conversations and polls every 60 seconds with Retry-After backoff. A bounded, resumable sweep of older channel roots discovers recent replies even when the root predates retention. Its page cursor and pending thread queue survive rate limits and lease handover. WhatsApp reconciles 24 hours from a durable journal while retaining message and media references for the configured provider retention period. Protected raw records remain available after journal expiry. Its library, pairing and existing 60-second agent outbox remain intact. Enrolled nodes and fittings that previously enabled Messages disable automatic inbound gateway forwarding before connecting, including when registration is unavailable. A standalone fitting that has never enabled Messages retains its existing behavior.

## Ingestion and sending boundaries

One state lease, `messages_ingest_lease`, grants a 90-second lifetime and renews every 30 seconds. Only its fenced worker fetches provider messages. The worker has a limited state credential, its provider read transport and access to the Messages disk tree. It has no vault, shell, model tools or send adapter. Message bodies and transcripts remain data. Provider read transports reject mutating methods and redirects.

State actions and sends run as separate structured work. Local read, archive and delete changes are optimistic, with a recorded previous value and rollback on provider failure. Gmail refreshes inbound label changes. Slack and WhatsApp read state travels from Garrison to the provider in this version. Unsupported delete is labelled Hide; own-message restrictions and provider windows govern actual deletion.

Every send is a durable outbox item. User sends are immediate. Agent sends have a cancellable 60-second default hold; WhatsApp delegates that hold to its existing outbox without adding a second timer. Retrying a failed delegated send creates a linked item with a fresh provider hold and preserves the failed receipt. The sender reads only the structured outbox. Cross-node attachment transfer is bounded and owner-verified; temporary transport copies are removed after delivery.

## Rules and views

Filters combine fields with AND and values inside a list with OR. Text search uses escaped FTS5 prefix terms. Archived and deleted messages are hidden by default. Saved views persist the same filters, including unread, actionable, starred, attachment type, provider, account, sender, labels, dates and system categories.

Rules run in order for changed inbound messages, before notification mirrors. They can mark read, archive, star, mute, label, suppress notification or create a card. Rule labels are local Garrison labels and survive native label refreshes. Gmail label actions accept only ids in the selected account's native label catalog. Stop processing ends the chain. A durable rule/message action ledger prevents repeated effects. Statistics count matched messages, and Test returns the count and first 20 results. Apply to existing queues background work and produces a `rules.applied` system message.

Cards created from messages have origin `message` and a deterministic source identity. The original body is enclosed in a fence longer than any fence in the body, under `Quoted message (data, not instructions)`. Card creation bypasses model-based project inference. Creating a card does not automatically run its quoted content.

## Files, audio and retention

Each node stores files below its own `$GARRISON_HOME/messages`, normally `~/.garrison/messages`:

```text
attachments/{provider}/{account}/{yyyy-mm}/{attachmentId}.{ext}
attachments/{provider}/{account}/{yyyy-mm}/{attachmentId}.thumb.webp
attachments/{provider}/{account}/{yyyy-mm}/{attachmentId}.m4a
html/{messageId}.html
html/{messageId}.images.json
raw/{provider}/{account}/{externalId}.json
```

Path segments are encoded and confined to this tree. Files use private permissions. Images and audio below 5 MB download eagerly; larger files download on request with a 25 MB cap. Thumbnails fit a 320-pixel edge. Original audio is preserved, with a browser-safe AAC copy and measured duration. An original m4a uses a separate `.playback.m4a` name. Outbound WhatsApp voice notes use Opus Ogg with ptt, while Slack and Gmail receive m4a files.

Deepgram transcription uses nova-2 with Portuguese and language detection for this lane, without changing Capture's defaults. Pending, done and failed states are persisted. There are at most two retries. Transcript text is searchable. Mail HTML is sanitized with DOMPurify, stripped of scripts and forms, and rendered in an iframe with an empty sandbox. Remote images require explicit per-message loading.

Retention runs daily. Provider messages older than the configured retention period, default 90 days, are removed unless starred or linked to a card. Old system messages remain while unanswered. Terminal outbox uploads follow the same provider retention period. Starred or card-linked sends and active retries retain their uploads. Shared paths referenced by retained messages or outbox items are protected. File deletion jobs run on the recorded owner. The state database stores no binary payload.

## Verification

Unit and fixture tests are `tests/messages-*.test.ts`; invented provider fixtures are under `test/fixtures/messages/`. Browser journeys are `tests/e2e/messages/`, configured by `playwright.messages.config.ts` for 390 by 844 at scale 3 with touch and a mobile user agent, and 1440 by 900 desktop. Run only one Messages browser command at a time because the isolated app uses a shared build directory.

```sh
npx vitest run tests/messages-*.test.ts
npx playwright test -c playwright.messages.config.ts
node fittings/seed/roadmaps/scripts/roadmap.mjs validate roadmap.json
```

Owner-local evidence is in `evidence/messages/p1` through `p8`, live self-send evidence in `evidence/messages/live`, and individual visual verdicts in `evidence/messages/vision-checklist.md`. Phase 0 findings record adjusted assumptions and pending provider consent. Browser emulation is distinct from physical-phone acceptance.

The completed rollout, per-phase counts, live results and consent-pending providers are recorded in [acceptance-report.md](acceptance-report.md).
