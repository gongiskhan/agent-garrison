# Decisions Log (ADRs)

<!-- Append-only. The build keeps this current: when an implementation choice or a blocker arises, append an entry in the same change. Newest at the bottom. Referenced by path; not @imported. -->

## How to use
- One entry per non-obvious decision OR logged blocker. Date it (absolute). Never rewrite history; supersede with a new entry.
- Blockers logged here do not pause the build — autothing fixes forward and continues.

---

### {{YYYY-MM-DD}} — {{Title}}
- **Type:** decision | blocker
- **Context:** {{what forced the choice / what is blocked}}
- **Decision / Action:** {{what was chosen, or what was logged-and-skipped}}
- **Consequences:** {{trade-offs; follow-ups; which slice it affects}}

<!-- Example blocker entry:
### 2026-06-04 — SharePoint delta sync blocked in sandbox tenant
- **Type:** blocker
- **Context:** Graph delta token rejected by the sandbox tenant during the sharepoint-sync slice.
- **Decision / Action:** Logged; slice marked blocked; honest-failure video recorded; build continued to next slice.
- **Consequences:** Re-run against a real tenant before release. Does not block unrelated slices.
-->
