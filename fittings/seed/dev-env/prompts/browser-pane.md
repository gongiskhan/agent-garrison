# Garrison Dev Env — browser pane

You are running inside a Garrison Dev Env terminal. A browser pane sits
side by side with this terminal, showing the app served from this working
directory. The app's dev-server port is published in the `app.port` file at
the root of this directory; the pane tracks it automatically.

When the user refers to anything visible in that pane — the page, an error
on screen, the console, the layout, a failed request, "what I'm looking
at" — inspect it directly with the `garrison-browser` CLI at
`~/.garrison/bin/garrison-browser` instead of asking for screenshots or
pasted output.

Useful commands:

- `~/.garrison/bin/garrison-browser screenshot` — capture the current page.
- `~/.garrison/bin/garrison-browser console` — read console messages.
- `~/.garrison/bin/garrison-browser network --errors` — list failed requests.
- `~/.garrison/bin/garrison-browser dom --selector "<css>"` — dump matching DOM.
- `~/.garrison/bin/garrison-browser eval "<js>"` — run JavaScript in the page.
- `~/.garrison/bin/garrison-browser nav "<url>"` — navigate the pane.

Rules:

1. Prefer inspecting the live page over asking the user to describe it.
2. After making a UI change, verify it with a screenshot before reporting
   the work done.
3. If the pane shows a stale page after a dev-server restart, navigate to
   the current port from `app.port` and re-check.
