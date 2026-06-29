# Brief: Dark-mode toggle on settings page

**Card:** 01KW1GSY9FTCV2XQ90EBWQXMPP  
**Project:** garrison  
**Status:** Discussed — open questions unresolved; build should not start until cleared.

> **Note:** The card title is "[verify] Discuss button demo". This may be a
> pipeline verification card rather than a committed feature ask. If so, this
> brief is the expected artifact and the build should be parked pending explicit
> sign-off that the feature is real.

---

## What this is

Add a user-controllable dark-mode toggle to Garrison's settings page. The
chosen theme persists across browser reloads. The surface is the Garrison web
app (Next.js, runs on localhost:7777).

---

## Decisions made

- **Persistence layer:** localStorage (a UI preference, not a Claude Code
  setting). Keeps it Garrison-internal and avoids writing through to
  `~/.claude/settings.json` for a cosmetic UI choice. Can be migrated to
  Quarters later if cross-machine sync is needed.
- **Default behavior:** follow `prefers-color-scheme` on first visit; store the
  explicit override in localStorage under a key like `garrison.theme`.
- **Scope:** toggle only — no full design-system audit unless existing styling
  already uses CSS custom properties.

---

## Approach

1. Add a CSS custom-properties layer (if absent) that maps to light/dark token
   sets. Apply a `data-theme="dark"` attribute on `<html>` for overrides.
2. On app init, read `garrison.theme` from localStorage; if absent, read
   `prefers-color-scheme`.
3. Place the toggle in whatever surface currently acts as "settings" — most
   likely the Quarters panel or a new settings area in the sidebar.
4. Persist the toggle's value to localStorage on change.

---

## Open questions (must be answered before build)

1. **Real feature or verify-card?** If this is just testing the Discuss list,
   park the build after the brief.
2. **Which page is "settings"?** Is there a dedicated settings page today, or
   does this live in Quarters, the sidebar, or somewhere new?
3. **Existing theming infrastructure?** Does Garrison use CSS custom properties
   already, or are colors scattered across Tailwind classes and inline styles?
   Answer changes scope significantly.
4. **System-preference follow + manual override, or explicit default?** Assumed
   system-preference follow above; confirm.

---

## Acceptance

- A toggle is visible on the designated settings surface.
- Toggling applies dark/light theme to the entire Garrison UI immediately.
- On reload, the previously chosen theme is restored (not the OS default).
- No regression in light mode for existing routes.
- Verified in Chrome; Safari and Firefox smoke-checked.
