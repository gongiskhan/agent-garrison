# Conversation approval parity — 11 September 2026

The Madrid conversation `chat-mtwkavnq-08skwe` had an unanswered approval-requested ledger entry and its card correctly in To do. The shared SessionTranscript banner rendered the plan and a text-reply hint but had no approval action.

ConversationView now supplies the shared banner with Approve & continue through its existing owner-routed message transport. The visible message is the same as the card action: `Approved - continue.` The control preserves composer drafts and attachments, locks while sending/accepted, displays failed delivery for retry, and uses a stable request ID across retries. Frozen/read-only hosts and historical search views do not receive the action. Approval uses the theme accent instead of the problem banner style.

Operator rule: routine plan approvals belong in To do. Needs attention is reserved for problems and blockers, not every request for human action. The existing card transition and completion guards remain in place. The screenshot's proposed CSG operation was evidence of the missing UI action, not authorization to approve that separate task.

Validation: rebuilt the web-channel and Kanban browser bundles; TypeScript passed. All 46 tests in the three-file focused regression gate passed. It covers card/conversation approval, a rejected delivery followed by retry at 390px, preserved draft, the intended resumed duty, approval removal after resume, and the To do/Done completion guards. An initial browser run used stale prebuilt fixture assets; rebuilt assets were used for acceptance.

Deployment and HTTPS acceptance are recorded in the shared Web Channel Turn Journal and Kanban Capture UX topic after rollout. Screenshot evidence stays on its owner node.
