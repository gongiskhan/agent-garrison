# Gmail validation

The connector declares its descriptor and requests gmail.modify alongside the existing Drive read scope. Independent mailbox grants preserve each account identity and returned consent scopes. Fixture adapter tests cover history progression, label changes, attachment transport, HTML sanitization and mail transforms. The six Gmail browser cases passed across both profiles, including unread image filtering, image loading, reply with fenced code, reply all and new mail. All eight screenshots in evidence/messages/p3 were viewed and passed.

The Gmail adapter has 18 passing tests. Account metadata has four tests shared with Slack, and the existing connector authority and consent regressions pass. Shared composer and media dependencies land with the mail UI; their full media acceptance remains Phase 6.

Live smoke is pending Google consent. The existing account has gmail.send and drive.readonly but lacks gmail.modify. No live mail was sent. The setup message is recorded in phase0-findings.md and is emitted by the runtime after deployment.
