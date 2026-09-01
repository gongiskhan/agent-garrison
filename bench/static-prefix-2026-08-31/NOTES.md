# Nothing variable in the cached prefix

2026-08-31. What is actually inside the cached system region, measured against
the live API rather than reasoned about, and what changed when it was moved out.

## How this was captured

`capture.mjs` starts a loopback proxy between the Agent SDK and
`api.anthropic.com`, spawns the real `resolveRoutedAgentSdkAssembly` for a given
cwd, runs one trivial turn, and writes the literal `/v1/messages` body. It shapes
the body exactly as the deployed proxy does (`cacheTtl: 1h`, tool search regex
with nothing kept loaded), so what is captured is what production sends.

Every capture ran with `CLAUDE_CONFIG_DIR=$GARRISON_HOME/stretch-claude`, which
is what `stretch_claude_home: true` gives a real stretch. Without it the CLI
injects the user's personal memory index and the block is ~12k characters bigger
and shaped differently, so a probe on the real `~/.claude` measures a shape
production does not have.

```
node bench/static-prefix-2026-08-31/capture.mjs <label>=<cwd> ...
node bench/static-prefix-2026-08-31/verify.mjs
```

## The request, as sent

Three system blocks. The cache breakpoints are on blocks 1 and 2, and there is a
third on the final user message.

| block | size | breakpoint | what it is |
|---|---|---|---|
| 0 | 85 ch | no | `x-anthropic-billing-header: ... cch=<nonce>` |
| 1 | 94 ch | 1h | "You are Claude Code..." |
| 2 | ~37,200 ch | 1h | the `claude_code` preset, then the composition's assembled prompt, then the git snapshot |

Block 0's nonce changes on every request and is **not** part of the cache key -
established 2026-08-29 by `bench/prefix-2026-08-29/cache-share-probe.mjs`, where
two requests shared a prefix with it varying. `cacheablePrefixParts` excludes it
for that reason and no other.

## Every field that differs

Diffed across two different `~/dev` projects, and across two commits in one repo.
All of it inside block 2, all of it inside the cached region.

**Between two projects** (`~/dev/garrison` vs `~/dev/28-palavras`):

| # | field | where |
|---|---|---|
| 1 | the per-project memory directory `.../projects/<cwd-slug>/memory/` | `# auto memory`, one line |
| 2 | ` - Primary working directory: <path>` | `# Environment` |
| 3 | a 160-character preset paragraph, present for four cwds and absent for a fifth | after `# Context management` |
| 4 | `Status:` - the working tree's modified files | trailing git snapshot |
| 5 | `Recent commits:` | trailing git snapshot |

**Between two commits in the same repo** (a two-commit scratch repo, `HEAD` vs
`HEAD~1`):

| # | field |
|---|---|
| 6 | `Current branch:` |
| 7 | `Recent commits:` |

Two things are worth separating. (2) and (4)/(5) are the ones people expect.
**(4) and (5) are the expensive ones**: the git snapshot moves on every commit,
so the prefix forks *within* a task, not merely between projects. And (3) is the
reason the fix cuts by REGION rather than by known line - a preset paragraph
Garrison does not control, varying by project for reasons it cannot see, would
defeat any list of known-variable lines.

Two runs in the same cwd produce a byte-identical block, so none of this is
run-to-run noise.

## The cut

`splitStaticPrefix` makes three cuts in the block carrying the last system
breakpoint, and re-emits what it removed as a system block with no
`cache_control`:

- the memory-directory line
- `# Environment` up to the start of the composition prompt (this sweeps up 2 and 3)
- the trailing git snapshot

The composition's assembled prompt is byte-stable and stays cached, and it now
sits *before* the moved material: static preset and static composition prompt
first, per-project and per-day last. The split is lossless - the two halves carry
exactly the characters of the input, so the model sees the same bytes, later.

Result: **34,618 characters cached, 2,251-2,726 characters moved.**

## Verification 1: one hash

`verify.mjs` hashes the cacheable prefix of every capture before and after.

```
  commitHEAD   before=b2e3e4be47b25b7a  after=a855baac652e0b67  cached=34618ch  moved=2268ch
  commitPREV   before=28cff60a2dac4334  after=a855baac652e0b67  cached=34618ch  moved=2251ch
  projA        before=3e720cf033967543  after=a855baac652e0b67  cached=34618ch  moved=2550ch
  projB        before=b4e3d853bd059ec4  after=a855baac652e0b67  cached=34618ch  moved=2710ch
  sameA1       before=2ae2f9b4963bcf87  after=a855baac652e0b67  cached=34618ch  moved=2726ch
  sameA2       before=2ae2f9b4963bcf87  after=a855baac652e0b67  cached=34618ch  moved=2726ch

distinct cacheable prefixes  before: 5   after: 1
```

## Verification 2: the second project reads instead of writing

Both pairs use projects never captured before, so neither request can hit an
earlier entry of its own. A first attempt at this control was invalid: the
"control" project had been captured minutes earlier with a byte-identical body
and read its own entry, which looked like a pass and proved nothing.

**Fix off** - `ekoa-site` then `awc`:

```
  ctlA   in=10 write=11412 read=0
  ctlB   in=10 write=11430 read=0
```

Project B writes its own prefix from cold. It cannot read A's: the two differ in
the fields above.

**Fix on** - `claude-control` then `cobrancas-app`:

```
  liveA  in=10 write=2977 read=8452
  liveB  in=10 write=2982 read=8452
```

Both read the full 8,452-token shared prefix - written by an *entirely different*
project earlier in the session - and write only their own ~3,000-token tail
(the moved material, the injected system reminders, and the brief, all of which
are genuinely per-turn and sit behind the message breakpoint).

On haiku that is $0.0228 against $0.0068 for the first call of a run, and the
same ratio at three times the rate on sonnet. The saving repeats for every
project switch and, because of fields 4-7, for every commit inside a task.

## What was deliberately left alone

The final user message carries its own 1h breakpoint. It looks like waste - the
brief never repeats between stretches - but a stretch is many turns, and each
turn re-sends the growing message array, so that entry is read within the
stretch. Not touched.
