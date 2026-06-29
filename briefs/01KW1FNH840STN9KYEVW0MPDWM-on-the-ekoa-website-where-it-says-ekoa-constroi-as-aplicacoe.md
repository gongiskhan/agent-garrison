# Brief: ekoa copy — "constrói ou ajusta as aplicações"

**Card:** 01KW1FNH840STN9KYEVW0MPDWM  
**Project:** ekoa  
**File:** `~/dev/ekoa-site/index.html`

---

## What this is

A brand copy update. The phrase "constrói as aplicações" (builds the
applications) is softened to "constrói ou ajusta as aplicações" (builds or
adjusts the applications) — better reflecting that Ekoa also adapts and
configures existing apps, not only creates new ones from scratch.

---

## Occurrences found

The exact quoted phrase ("Ekoa constrói as aplicações") doesn't appear
verbatim; the real occurrences include the article and continue beyond
"aplicações". All 4 instances read "a Ekoa constrói as aplicações,
automações e sistemas...":

| Line | Location |
|------|----------|
| 8    | `<meta name="description">` |
| 12   | `<meta property="og:description">` |
| 20   | `<meta name="twitter:description">` |
| 324  | Visible hero `<p class="sub">` |

---

## Decisions

- **Change all 4 instances.** Meta/OG tags and visible copy should carry the
  same positioning. Changing only the visible paragraph while leaving old
  messaging in search-result snippets and social shares would be inconsistent.
- **Minimal edit:** insert "ou ajusta" after "constrói" in each instance.
  No other wording changes.
- **Accent/Portuguese:** "ajusta" needs no accent. Straightforward insert.

---

## Approach

In `~/dev/ekoa-site/index.html`:
- Lines 8, 12, 20, 324: replace `constrói as aplicações` →
  `constrói ou ajusta as aplicações`.

That's it. Static HTML, no build step.

---

## Open questions

1. **Scope confirmed?** Change all 4 (recommended) or only the visible
   paragraph on line 324?
2. **Lines 20 and 324 have slightly different surrounding text** from lines
   8/12 — confirm the same insert applies uniformly, not a custom rewrite of
   each sentence.

---

## Acceptance

- `grep -c 'constrói as aplicações' index.html` → 0 (old phrasing gone).
- `grep -c 'constrói ou ajusta as aplicações' index.html` → 4 (all instances
  updated).
- HTML parses cleanly.
- Visible hero paragraph reads correctly in browser.
