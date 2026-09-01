Build a todo app in this repo, API plus a minimal web UI served by the
same server, following the conventions in AGENTS.md.
1. Create a todo with a title and an optional due date
2. List todos, filterable by all / open / done
3. Mark done and undo
4. Delete
5. Edit the title
6. Persists across a server restart
7. Overdue todos are visually distinct in the UI
8. Tests covering create, complete and list filtering, passing
Done means: npm install && npm start works from a clean checkout with
no manual fixes, and all of the above are usable in a browser.
