# Final Messages review

This is the single end-of-implementation review required by the brief. Its scope is limited to the four properties below. The findings below were corrected and checked with focused regressions. Available-provider live acceptance and full production validation were checked separately and are now recorded in the acceptance report.

## Ingestion and message data

The core ingestion worker uses a fenced, limited state credential and an operating-system-restricted child with read-only provider transport. Two gaps were found: the media child initially lacked equivalent process restrictions, and WhatsApp could fall back to automatic gateway dispatch after a restart during registration failure. The transcription child now runs with exact-bundle and Messages-only read permission, no credentials, no HTTP adapter, no process creation and no filesystem writes. A fixed broker accepts only an original attachment identity and calls the existing speech-to-text endpoint. The lead performed a bounded second verification because this split was substantial; five real process and IPC tests pass. WhatsApp now enters Messages mode before connection whenever enrolled or previously enabled, including registration outages. Message-to-card creation uses deterministic routing and a quoted data block.

## Provider state round trips

The review found that message-wide revisions made rollback depend on unrelated transcript updates, and completion of an older action could clear a newer optimistic field. Provider mutations now claim in message order, preserve later field ownership, and propagate the failed baseline to subsequent queued actions. Four focused regressions pass, including a failed Gmail update followed by a native state change. WhatsApp retains action and lazy-media metadata for the provider retention period, with retained raw payload fallback for protected older messages; missing references fail visibly. Local rule labels are kept separately from native provider IDs and survive native label changes.

## Resync and lease handover

A later stream event previously advanced the durable polling cursor, potentially skipping a message in the poll-to-stream connection gap. Stream upserts now leave the reconciliation cursor unchanged. A real relational-store test verifies the gap message is recovered by the next lease holder and replay adds no duplicate. Slack reconciliation includes older root metadata so late replies remain discoverable; its paginated sweep and rate-limit resumption passed focused fixture verification. The provider bundle passed 70 tests.

## Phone usability

The lead viewed the phone and desktop journeys. The review found a pending-action sheet covered by a toast, stale queued copy after successful replay, and an older performance capture with the shell scrolled away. These were corrected and recaptured. The lead viewed the final captures, including a fresh-path copy of the phone performance screenshot to avoid a reused image path. Conversation headers, inline system actions, mail controls, image viewer, audio player and transcript, shared composer, filter controls, saved views, provider settings and rule actions otherwise fit their phone layouts.

Final production builds and the complete suite pass. The final self-only WhatsApp run confirms provider acknowledgments, transcription, search and full image/audio decoding; browser playback at 1.5x passes on both profiles. Google and Slack remain pending consent. Browser viewport validation does not claim physical-phone or acoustic acceptance. The later binary proxy correction was a bounded transport fix covered by 77 focused tests and real playback, without another broad review.
