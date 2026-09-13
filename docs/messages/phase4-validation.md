# Phase 4: Slack

The Slack connector has an additive user-account setup path and descriptor. Its adapter supports user conversations, DMs, groups, channel threads, files, read markers, own-message deletion, reactions and Markdown transforms. The existing bot connection remains intact. The required user grant includes the write scopes required by `conversations.mark`.

Four unique Slack browser cases passed. Both profiles are covered: iPhone 390 by 844, device scale factor 3 and touch, and desktop 1440 by 900. Two cases cover a channel thread with reactions and a fenced reply. Two cases cover adding a workspace in Connectors, the Slack Apps link and required User Token Scopes, password-only token input, clearing the submitted token, and displaying the connected workspace metadata. The existing connector uses a token setup flow, so the form links to Slack Apps for the operator's install and consent step.

The lead viewed all eight final screenshots in `evidence/messages/p4`. The stems `slack-thread`, `slack-replied`, `slack-account-setup` and `slack-account-connected` each have an `-iphone.png` and `-desktop.png` capture. The complete filename inventory is [ui-screenshot-inventory.json](../../evidence/messages/p8/ui-screenshot-inventory.json), and the final browser receipts are [ui-test-results.json](../../evidence/messages/p8/ui-test-results.json).

The phase adapter batch recorded 21 passing Slack fixture tests, including Retry-After backoff and thread parenting. Provider and account discovery shares four metadata tests with Gmail.

Live smoke remains pending Slack user consent. No usable Slack user grant was configured, and no live DM was sent in this validation. The runtime records the setup notice after deployment.
