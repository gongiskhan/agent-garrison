# Phase 3: Gmail

The connector declares its descriptor and requests `gmail.modify` alongside the existing Drive read scope. Independent mailbox grants preserve each account identity and returned consent scopes. Fixture adapter validation covers history progression, label changes, attachment transport, HTML sanitization and mail transforms.

Ten unique Gmail browser cases passed. Both profiles are covered: iPhone 390 by 844, device scale factor 3 and touch, and desktop 1440 by 900. Coverage includes unread image filtering, inert mail HTML, explicit image loading, reply with fenced code, reply all, forward, new mail, existing label names and provider label ids, and selection of a healthy mailbox while another mailbox needs setup.

The lead viewed all eight final screenshots in `evidence/messages/p3`. The stems `mail-thread`, `mail-replied`, `reply-all` and `new-mail` each have an `-iphone.png` and `-desktop.png` capture. The complete filename inventory is [ui-screenshot-inventory.json](../../evidence/messages/p8/ui-screenshot-inventory.json), and the final browser receipts are [ui-test-results.json](../../evidence/messages/p8/ui-test-results.json).

The phase adapter batch recorded 18 passing Gmail tests. Account metadata has four tests shared with Slack, and existing connector authority and consent regressions pass. Shared composer and media dependencies land with the mail UI; media acceptance is recorded in Phase 6.

Live smoke remains pending Google consent. The existing account has `gmail.send` and `drive.readonly` but lacks `gmail.modify`. No live mail was sent in this validation. The setup message is recorded in [phase0-findings.md](phase0-findings.md) and is emitted by the runtime after deployment.
