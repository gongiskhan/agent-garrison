# Slack validation

The Slack connector has an additive user-account setup path and descriptor. Its adapter supports user conversations, DMs, groups, channel threads, files, read markers, own-message deletion, reactions and Markdown transforms. The existing bot connection remains intact. The required user grant includes the write scopes required by conversations.mark.

The Slack adapter has 21 passing fixture tests, including Retry-After backoff and thread parenting. Both browser profiles passed the channel-thread and fenced-reply journey. All four screenshots in evidence/messages/p4 were viewed and passed. Provider and account discovery shares four metadata tests with Gmail.

Live smoke is pending Slack user consent. No usable Slack grant was configured, and no live DM was sent. The runtime records the setup notice after deployment.
