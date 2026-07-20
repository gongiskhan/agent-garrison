# Architecture conventions

Durable doctrine for adding a `src/lib/*` module or a UI surface to Agent
Garrison. This is the conventions document a generic implementer is handed —
it stands alone; you should not need the area skill to follow it. It is
grounded in real code (cited inline). Two parts:

- **(A) Surface-wiring pattern** — how a new UI surface is wired end to end.
- **(B) Host-config IO discipline** — how a lib that touches `~/.claude` /
  `~/.garrison` reads and writes files safely.

Cross-references: `CLAUDE.md` "High-level architecture" for the `src/lib/`
inventory, [`docs/SPEC.md`](./SPEC.md) for the v1 shape, and
[`docs/METADATA.md`](./METADATA.md) for the `x-garrison` manifest.

---

## (A) Surface-wiring pattern

A surface is a route the user navigates to (Vault, Quarters, Coordination,
…). The wiring path is fixed; copy the **Vault surface verbatim** as the
template — it is the smallest complete example.

### The path

```
src/app/<x>/page.tsx              server component — renders the panel, nothing else
  └─ src/components/<x>/<Panel>.tsx   client component ("use client"), useAppShell(), fetch /api/<x>
       └─ fetch("/api/<x>")
            └─ src/app/api/<x>/route.ts   route handler — runtime/dynamic flags, jsonError
                 └─ src/lib/<x>.ts        backend logic + file IO (the only layer that touches disk)
src/components/chrome/Sidebar.tsx  add a <NavLink> so the surface is reachable
```

Each layer has one job. The page does not fetch; the component does not touch
disk; the route handler does not contain business logic (it parses the
request, calls the lib, and maps errors); the lib does not import React or
Next. Disk IO lives **only** in the lib.

### Worked reference — the Vault surface

Read these five files together; they are the canonical template.

1. **Page** — `src/app/vault/page.tsx`. A server component that renders the
   panel and nothing else:

   ```tsx
   import { VaultPanel } from "@/components/vault/VaultPanel";
   export default function VaultPage() {
     return <VaultPanel />;
   }
   ```

2. **Component** — `src/components/vault/VaultPanel.tsx`. Marked
   `"use client"`; pulls shared state and actions from `useAppShell()`
   (`@/components/chrome/AppShell`) rather than fetching ad hoc. Shared
   surface state (composition, vault status, secrets, busy flags) lives on
   the app shell so multiple surfaces stay in sync; surface-local UI state
   (e.g. the passphrase input) is a local `useState`.

3. **Route handler** — `src/app/api/vault/secrets/route.ts`. Every route
   handler declares `runtime = "nodejs"`; a route that reads live disk state
   also declares `dynamic = "force-dynamic"`. Both use the shared `jsonError`
   helper:

   ```ts
   import { NextResponse, type NextRequest } from "next/server";
   import { vaultView, writeVaultSecrets } from "@/lib/vault";
   import { jsonError } from "@/lib/http";

   export const runtime = "nodejs";          // required — libs use node:fs, node:crypto
   export const dynamic = "force-dynamic";    // required for any route that reads live disk state

   export async function GET() {
     try {
       return NextResponse.json(await vaultView());
     } catch (error) {
       return jsonError(error, 400);
     }
   }
   ```

   `jsonError` (`src/lib/http.ts`) is three lines: it normalises an unknown
   thrown value into `{ error: message }` with a status. Use it for every
   catch — do not hand-roll error JSON.

4. **Lib** — `src/lib/vault.ts`. The backend module. Imports only `node:*`
   and other libs. All the file IO, crypto, and state live here. This is the
   layer the route calls and the layer tests target directly (no HTTP).

5. **Sidebar NavLink** — `src/components/chrome/Sidebar.tsx`. Add one line to
   the `<nav className="tabs">` block so the surface is reachable:

   ```tsx
   <NavLink href="/vault" pathname={pathname} icon={<Lock aria-hidden />} label="Vault" />
   ```

   `NavLink` is a local helper in that file. Pass `href`, `pathname` (from
   `usePathname()`), a Lucide `icon`, and a `label`. For a route with
   sub-paths, pass an explicit `active={pathname.startsWith("/x")}` (see the
   Quarters and Coordination links) instead of relying on the default exact
   match. Optional `ct` renders a count badge.

### The required Next.js route flags (non-negotiable)

Every one of the repo's route handlers (all 44 at time of writing) declares
`export const runtime = "nodejs"` — the libs use `node:fs`, `node:crypto`, and
`node:os`, which are unavailable on the Edge runtime, so this one is mandatory
and universal. Most (36 of 44) also declare `export const dynamic = "force-dynamic"` — the
prevailing convention for a route that reads mutable disk/composition state, so
Next does not cache a stale snapshot at build time. It is applied
**inconsistently** in practice (several live-state routes — e.g.
`compositions/[id]`, `vault/unlock`, `orchestrator/place` — omit it), so treat
it as a precaution, not an enforced invariant. The only hard requirement is
`runtime = "nodejs"`; add `dynamic = "force-dynamic"` when a route reads live
state and you want to be certain Next never serves a build-time snapshot.

### Adding a brand-new surface — checklist

1. `src/lib/<x>.ts` — the logic + IO (follow part B if it touches host config).
2. `src/app/api/<x>/route.ts` — handler with `runtime = "nodejs"` (and
   `dynamic = "force-dynamic"` if it reads host-config state) + `jsonError`.
3. `src/components/<x>/<Panel>.tsx` — `"use client"`, `useAppShell()`.
4. `src/app/<x>/page.tsx` — server component that renders the panel.
5. `src/components/chrome/Sidebar.tsx` — one `<NavLink>`.
6. A vitest spec under `tests/` targeting the lib directly (see part B for
   the injected-path test pattern).

### Modules that aren't surfaces

A `src/lib/*` module need not have a UI. Runtime/internal modules (the runner,
the capabilities resolver, the metadata parser) live flat under `src/lib/`
with no sub-packages and are called by other libs, not by a page. The lib
conventions in part B still apply to any of them that touch host config.

---

## (B) Host-config IO discipline

Garrison is a control plane over the user's **real** `~/.claude` and
`~/.garrison`. The user's hand-authored config and other tools (Claude Code
itself, APM) write the same files concurrently, and Garrison autosaves with no
Save button. A naive `fs.writeFile` truncates-then-rewrites, so a concurrent
reader can catch a partial file, a crash mid-write loses the old contents, and
a blind overwrite silently clobbers something Garrison does not own. These
rules remove those hazards. They apply to **every** lib that reads or writes
under `~/.claude` / `~/.garrison` — e.g. `claude-settings-file.ts`,
`hooks-crud.ts`, `mcp-writer.ts`, `plugin-writer.ts`, `claude-md.ts`,
`claude-json.ts`, `primitive-files.ts`, `parked-config.ts`, `plans.ts`,
`provenance.ts`, and `view-state.ts` (all of which write through
`src/lib/atomic-write.ts`). Two writers stand apart and are NOT atomic-helper
exemplars: `src/lib/reconcile.ts` (the importer) does the hash-compare echo
suppression of rule 6 but writes captured fittings via `fsp.cp` /
`writeYamlFile` (raw `fs`), not the atomic helper; and `src/lib/vault.ts`, the
local secret store, writes its own `data/vault.json` under `DATA_DIR` (not
`~/.claude`) via raw `fs.writeFile` with an explicit `0600` mode, predating the
atomic helper. Treat `vault.ts` as the **surface-wiring** template (part A), not
as a host-config-IO exemplar.

### 1. Read-fresh → mutate → write-whole-document

Never hold a cached copy of a host file across an edit. For each mutation:
read the current file fresh, apply the change in memory, write the whole
document back. Never blind-overwrite — i.e. never write a file you did not
just read. This is how the host-config libs avoid losing a change another
writer made between your last read and your write.

### 2. Never clobber a file Garrison does not own

Ownership is explicit and checked before every write. Garrison-owned config is
stamped with a `_garrison` marker (e.g. a `_garrison: "fitting:<id>"` tag on a
settings hook group); hand-authored config is left untagged. A writer must
**refuse** to mutate an unowned/hand-authored target rather than overwrite it.
`src/lib/hooks-crud.ts` is the reference: its CRUD helpers explicitly refuse to
touch any `_garrison`-tagged group (those are fitting-managed and read-only
there), and conversely keep hand-authored hooks untagged so the owned/loose/
parked state model never misclassifies the user's hook as fitting-owned. The
mirror of "never clobber" is the safety invariant a test must prove:
**never-clobber** — a hand-authored/unowned target is refused and nothing is
written.

### 3. One writer per host file

Each host file has exactly one writer module; everyone else goes through it.
The settings writer is shared by the Settings UI and by hook installs — they
do not both open `settings.json`. APM is the single writer for package files;
Garrison owns only orphan cleanup. Concentrating writes in one module is what
makes read-fresh → write-whole-document tractable.

### 4. Inject base paths — never hardcode `~/.claude` / `~/.garrison`

A lib must take its roots as injectable parameters so a test can point it at a
tmpdir and **never** touch the real `~/.claude`. The repo resolves all roots
through `src/lib/claude-home.ts`, which honours env overrides:

```ts
// src/lib/claude-home.ts
export function claudeHome(): string {
  const override = process.env.GARRISON_CLAUDE_HOME?.trim();
  return override && override.length > 0 ? override : path.join(homedir(), ".claude");
}
export function garrisonDir(): string {
  const override = process.env.GARRISON_HOME?.trim();
  return override && override.length > 0 ? override : path.join(homedir(), ".garrison");
}
```

Lib functions then take the home as a defaulted parameter, e.g.
`createHandHook(input, home = claudeHome())` in `hooks-crud.ts`. A test passes
an explicit tmpdir home; production passes nothing and gets the real path.
`GARRISON_CLAUDE_HOME` and `GARRISON_HOME` (plus `GARRISON_CLAUDE_JSON` for the
`~/.claude.json` sibling) also let the build's e2e / walkthrough runs target a
seeded sandbox. The test pattern is the injected-path tmpdir spec in
`tests/claude-hooks.test.ts`; every backend test must inject the home so it
never mutates the user's real config.

### 5. Use the atomic-write helper — `src/lib/atomic-write.ts`

Do not call `fs.writeFile` directly for a host file. Use the helper:

- `writeFileAtomic(absPath, data, opts)` — writes a sibling temp file on the
  **same filesystem** as the (symlink-resolved) destination, `fsync`s it, then
  `rename`s over the target. `rename(2)` is atomic within a filesystem, so a
  concurrent reader sees either the complete old file or the complete new file,
  never a torn one, and a crash leaves the previous file intact. Writing
  through a symlinked directory deploys into the real target while leaving the
  link itself intact (matching APM's `.claude` symlink write-through).
- `writeJsonAtomic(absPath, value, opts)` — pretty-prints with a trailing
  newline (the shape Claude Code itself writes) and atomic-writes.
- `readFileTolerant(absPath, opts)` — reads a file another writer may be
  replacing concurrently: ENOENT short-circuits to `{ exists: false }`; a read
  error or a `validate` failure (e.g. `JSON.parse`) retries with linear
  backoff. Use it for any file a watcher might catch mid-write.

**Mode preservation + fsync.** A temp-file+rename loses the destination's
permissions, which would widen a `0600` secret-bearing host file to `0644` on
every autosave. So mode resolution is: an explicit `opts.mode` wins;
otherwise the existing target's mode is preserved; otherwise `0644` for a
brand-new file. When a mode is determined it is `fchmod`-ed after creating the
temp file so the result is exact regardless of the process umask. Always pass
`{ mode: 0o600 }` when (re)writing a secret-bearing file. The write is
`fsync`-ed before the rename.

**Optimistic concurrency (`opts.cas`).** For a file another tool actively
rewrites (e.g. `~/.claude.json`, which a running Claude Code rewrites), pass
`cas: { priorContent }`. The destination is re-read at the tightest possible
point — immediately before the rename — and the write is aborted with a
`CasMismatchError` (temp file cleaned up) if the content changed since you read
it, rather than clobbering the other writer's change. `priorContent: null`
expects the file to be absent.

### 6. Echo suppression (where a watcher reads back your own writes)

A surface that both writes a host file and watches it for external edits must
not re-import its own write as if it were a user edit. The reconcile importer
(`src/lib/reconcile.ts`) does **hash-compare** echo suppression, not
ignore-next: after a Garrison-initiated write it snapshots the file's sha256
into the provenance ledger's `lastWrittenHash`; on the next watcher fire, a
loose primitive whose current on-disk hash equals that recorded hash is our own
write echoing back, so it is skipped rather than re-captured. The provenance
ledger (`garrison-provenance.json`, path from
`provenanceLedgerPath()`) carries what the APM lockfile structurally cannot —
per-primitive ownership and `lastWrittenHash`. Apply this pattern only to
surfaces that watch what they write.

### Safety invariants a backend test must prove

A lib that follows part B should have a vitest spec (injected-path tmpdir,
per rule 4) asserting both behaviour and safety:

- **never-clobber** — a hand-authored/unowned target is refused; nothing is
  written.
- **round-trip** — a Garrison-owned file installs/uninstalls cleanly with a
  recorded sha256.
- **drift** — an externally-edited owned file is left intact on uninstall.
- **passthrough** — unknown keys round-trip byte-for-byte (the writer never
  drops a config key it doesn't recognise).

## (C) Remote access model — URLs the client can actually reach

Garrison and its own-port Fittings run on ONE machine, but the user's browser
is almost never on it: the normal path is another workstation, an iPad, or a
phone reaching **prod** over the HTTPS tailnet address
(`https://<tailnet-host>:<serve-port>`, mapped by
`scripts/tailnet-serve-views.mjs`). Design every client-facing URL for that
reality:

1. **Relative URLs first.** A fitting UI talking to its own server uses
   same-origin relative paths (`/api/...`). These survive any access path -
   loopback, LAN, tailnet - and are the default answer. Drill's screenshot
   proxy (`/api/authoring/screenshot/<tabId>`) exists precisely so the image
   is same-origin instead of a cross-origin loopback URL.

2. **Loopback + tailnet URL pairs when an absolute URL is unavoidable**
   (cross-fitting embeds, "open in X" links). The SERVER pairs the canonical
   loopback URL with its `tailscale serve` mapping; the CLIENT picks by
   `window.location.hostname`:
   - on localhost -> the loopback URL (direct);
   - on the tailnet host -> the HTTPS tailnet URL;
   - otherwise -> best-effort hostname rebind, refused (empty string) when it
     would be mixed content - and the UI must SAY the view is unreachable
     rather than render a silently blank iframe.

   Shell implementation: `src/lib/tailnet-serve.ts` (serve-status read, cached)
   consumed by `src/app/api/fittings/views/route.ts` (`url` + `tailnetUrl`)
   and resolved by `resolveViewUrl` in
   `src/components/fitting-views/browser-view-url.ts`. Fitting-local
   implementation (no cross-fitting imports, per house convention):
   `fittings/seed/drill/lib/tailnet-serve.mjs` (`canvasUrl` +
   `canvasTailnetUrl` pairs) resolved by `resolveEmbedUrl` in
   `fittings/seed/drill/ui/main.tsx`.

3. **Server-to-server loopback is fine.** Fittings calling sibling fittings on
   the same box (`GARRISON_BROWSER_URL`, status-file URLs) stay loopback -
   those URLs just must never be forwarded to the client as-is.

4. **Verify from a non-localhost origin before shipping.** A surface that
   looks perfect on `http://127.0.0.1:<port>` can be a grey broken-frame pane
   over the tailnet (unreachable host + mixed content). Loading the prod
   tailnet URL headlessly from the Garrison box itself reproduces the remote
   path faithfully - the page host is the tailnet host, not localhost.
