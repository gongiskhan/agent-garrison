---
name: garrison-browser
description: Inspect the browser tab running side-by-side in the Garrison Browser Fitting — take screenshots, read console messages, read network requests, dump DOM, run JS, and read what the user pointed at on the page — without asking them to paste or describe it. Triggers when the user references the browser pane / the canvas / the app they're viewing, mentions a console message or network error they can see, asks "what's on the page", says "this"/"that"/"here"/"remove this"/"change this" about the page, or is iterating on a UI change and wants verification.
allowed-tools: Bash(garrison-browser:*) Read
---

# garrison-browser

You have a CLI, `garrison-browser`, that talks to the
Garrison Browser Fitting and lets you inspect the headless Chromium
tab the user is watching in their split-pane canvas. Use it instead of
asking the user to paste a screenshot or console log.

The Fitting installer puts the command in the active Garrison home's `bin`
directory. The Codex instance launcher adds that directory to `$PATH`, so invoke
it as `garrison-browser <command>`.

## When to use this

- The user mentions "the browser", "the canvas", "the app", "the page",
  or anything they can see in the side-by-side pane.
- They mention a console error / warning / network failure they can see
  but haven't pasted.
- They ask whether a UI change took effect.
- You're iterating on frontend code and need a feedback loop tighter
  than "make change → ask user → wait for screenshot".

If no Browser Fitting is running, the CLI exits with a clear message —
you can fall back to asking the user.

## Commands

`garrison-browser` auto-picks the most-recently-active tab. Override
with `--tab <id>` from the `tabs` list.

```
garrison-browser tabs                                              # list open tabs
garrison-browser screenshot                        # → prints /tmp/...png path
garrison-browser screenshot --full                 # full-page (scrolled)
garrison-browser console                           # recent console entries
garrison-browser console --since <unix-ms>         # only newer than ts
garrison-browser network                           # recent network requests
garrison-browser network --errors                  # only failed / 4xx / 5xx
garrison-browser network --filter <substring>      # match URL / method / type
garrison-browser body --request <requestId>        # response body of a request
garrison-browser dom                               # full HTML
garrison-browser dom --selector main               # outerHTML of a selector
garrison-browser eval 'document.title'             # run JS, get the value back
garrison-browser nav https://example.com           # navigate the tab
garrison-browser selection                         # what the user pointed at
garrison-browser selection --clear                 # clear the current selection
```

## Pattern: the user pointed at something ("remove this")

The canvas has **Select** and **Region** buttons. The user clicks an element
(or drags a box) to mark what they mean, instead of describing it. When the
user says "this", "that", "here", "remove this", "make this bigger", etc.
about the page, resolve the reference with:

```
$ garrison-browser selection
element  div.card > button.btn-primary
  text:  "Add"
  box:   320,210 84x32
  page:  http://localhost:3002/
  screenshot: /tmp/garrison-browser-selection-<tab>.png   (Read this to see it)
  html:
    <button class="btn-primary">Add</button>
```

Use the `selector`, `text`, and `html` to find the element in the source, and
`Read` the screenshot to confirm visually. For a **region**, you get the box
plus the elements inside it (their selectors + text) — treat those as the
candidate set the user is gesturing at.

If `selection` reports "(no selection …)", the user hasn't marked anything —
ask them to click Select/Region and point, or fall back to describing.

## Pattern: see the page

```
$ garrison-browser screenshot
/tmp/garrison-browser-shot-1779571910648.png
```

Then use the Read tool on that path to see the image.

## Pattern: check for errors

Always cheap; do this before declaring a frontend change "done":

```
garrison-browser console --limit 50
garrison-browser network --errors
```

## Pattern: timestamp window

If you took a baseline a moment ago and want only entries since then,
capture `Date.now()` and pass it to `--since`:

```
START=$(date +%s)000
# … take an action …
garrison-browser console --since $START
garrison-browser network --since $START
```

## Pattern: read response body

`network` rows include a `[requestId]` at the end. Pass it to `body`:

```
garrison-browser network --filter /api/
garrison-browser body --request <requestId>
```

Bodies are only available while Chromium still has them cached — fetch
soon after the request lands.

## Not for

- Spawning a *new* browser to test something in isolation — that's the
  `playwright-cli` skill's job. `garrison-browser` only inspects the
  tab the user is already watching.
- Long automation flows. Use it for verification snapshots, not as a
  general browser automation runner.
