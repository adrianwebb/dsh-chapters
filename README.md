# dsh-chapters

A DeepSeek Harness plugin for **topic-chaptered conversation continuation with lossless archiving**.

When a long conversation gets expensive, this plugin archives it as Markdown chapters in a project
store and opens a **new session whose entire content is a Table of Contents** of that archive. The
model reloads any chapter on demand with the `read` tool. The original conversation is never rewritten
and its prompt cache is never disturbed.

> **On the name.** It used to be `dsh-chapter-fork`, and that was misleading in a way that mattered: in
> DSH, "fork" means *copy the parent's history into the child* — the one operation this plugin must never
> perform — while "compact" or "summarize" would imply the lossy in-place editing it replaces. It is now
> **`dsh-chapters`**, which names the artifact and claims nothing false. Tools are `chapters_segment` and
> `chapters_continue`. The full reasoning, including the two candidates that lost, is in
> [docs/architecture.md](docs/architecture.md#naming). The one thing not yet renamed is the repository
> folder itself, which is cosmetic — see that section.

---

## Why This Exists

The problem is **not** that long conversations hit context limits, and it is not really compaction either.
The two problems that actually hurt, on local hardware with slow prefill:

1. **Forgetting details that cannot easily be recovered.** A summary drops the specifics — the exact flag,
   the line number, the error text — and the model has no handle to go get them back.
2. **The wall-clock cost of summarizing.** Producing a summary means prefilling the whole history into one
   auxiliary call. At local prefill rates that is not slow, it is *stopping-you-from-working* slow:

   | History | 30 tok/s | 100 tok/s | 300 tok/s |
   |---|---|---|---|
   | 32K | 18 min | 5 min | 2 min |
   | 100K | **55 min** | 17 min | 3.5 min |

   …and then it does it **again** the next time the window fills.

`dsh-chapters` removes the summarization step entirely. Chapters are **written from the session log** — a
file copy, not an inference — and the index that replaces the history is **generated deterministically**,
costing **zero model tokens**. On a 32K-capped model the archived index measured **~102 tokens** where the
equivalent transcript ran ~2,476.

> **The point is to make small models more capable, not merely longer-lived:** easily retrievable memory,
> no summarization tax, and a conversation that can keep going and going and going until the objective is
> actually finished.

Secondary, and still worth having: in-place compaction's other historical cost was breaking the prompt
cache —

1. **It breaks prompt caching from the cut point onward.** Modifying the prefix invalidates the
   provider-side cache behind it; DSH's design minimizes this by keeping the header intact and
   replacing only a span — but everything after the replacement refills. On hardware with slow prefill,
   that refill is the cost.
2. **The model loses access to what was dropped.** DSH's compaction *shadows* surface nodes rather than
   deleting the durable log, so the raw text is still recorded — but in any default composition the
   agent can no longer see it and has no in-context handle to get it back. (Upstream ships an opt-in
   package that gives a model raw event JSON for shadowed history; it costs five tool schemas in every
   request, and JSON events are not a readable archive either way.) What survives in context is a
   paraphrase it must trust.

This plugin never touches the current session. It archives the conversation verbatim to disk, then
starts a new session that carries only an index. Nothing is destroyed, and everything stays retrievable.

### Be clear about what this does not buy you

The new session still pays one cold prefill — its system prompt plus the TOC plus the handoff note —
which is at least the cost class a post-compaction request pays (a compaction keeps the header cached
and refills from the cut point; a continuation refills everything). **This is not marketed as cheaper
than compaction.** What it buys is different, and for the right workload better:

- the archive is **verbatim**, so reloading a chapter returns real text, not a summary of it
- the original session is **untouched**, keeping its cache and remaining usable as an ancestor
- the move is **reversible** — abandon the new session and keep working in the old one
- history can be **branched**, not just truncated

Built for people running local models in small windows (32K–128K), who depend on high cache hit rates
because prefill is slow, and who want relief that is inspectable rather than destructive.

---

## How It Works

### `chapters_segment`

The agent calls `chapters_segment` on the current conversation. It proposes topic chapters as
**event-sequence ranges** plus a title and one-line summary each, along with the *archive ceiling* — the
last completed turn. The agent reviews and edits the proposal.

The model supplies only boundaries and labels, never archived text. That keeps the archive verbatim
rather than reconstructed from recall, and keeps one tool call within output-token limits no matter how
long the conversation is.

### `chapters_continue`

The agent — or the user, via a button once the UI trigger lands — calls `chapters_continue` with the
approved ranges and a handoff note. The tool:

1. **Reserves** chapter numbers and slugs in the chain registry, so a crash or retry cannot collide them
2. **Renders chapter bodies from the session log** at the given ranges, writing Markdown and recording a
   content hash per file
3. **Defers oversized tool results** out of the chapter into content-addressed artifact files
4. **Builds a flat, chronological TOC** by walking the ancestor path — the plugin walks, the model reads
   a list
5. **Preflights the context budget** and refuses with concrete numbers if the new session would start too
   large
6. **Creates a new session** seeded with exactly one event: the TOC
7. **Returns** the new session id, store directory, archive ceiling, written paths, and hashes

The TOC is the new session's first message:

```markdown
## Conversation TOC

This session continues an earlier conversation. The chapters below hold its
history as Markdown. Use the `read` tool on a chapter path to reload one —
reloading costs context too, so read the bullet first and only open what you need.

### In flight
Refactoring the migration runner. `applyPending` is split; `resolveOrder` is not
touched yet. The failing test is `migrations.e2e` case 3.
Parent: 01HTZ6Q8K3 · Root: 01HTAB12CD7

### Chapters
1. [Project Setup](.dsh-chapters/01HTAB…/chapters/001-project-setup.md) — Repo scaffolding and dependency choices.
2. [Auth Debugging](.dsh-chapters/01HTAB…/chapters/002-auth-debugging.md) — Resolved CORS and token refresh issues.
3. [Database Schema](.dsh-chapters/01HTAB…/chapters/003-database-schema.md) — Designed the user table and migration.
```

"Chapters" is a flat numbered list in causal order, never a graph to explore — see
[Ancestry without traversal](#ancestry-without-traversal).

The "In flight" section exists because the turn that triggers a continuation is by construction not yet
archived: the ceiling is the last completed turn, so without a handoff note the most relevant context
would be the part that gets dropped.

### Chapters stay small: the model decides which tool results to carry

Long dumps — a `read` on a big file, a `bash` traceback — are most of a real conversation's tokens and
usually the least valuable thing to re-read. But "which ones matter" is a *semantic* judgement, not a size
question: a four-line compiler error is load-bearing and a four-hundred-line config `read` can be noise.
So the agent that lived the conversation decides, and the plugin does the arithmetic.

- The plugin enumerates the candidates — every tool result's `seq`, tool, and real size — so the model
  never guesses at byte counts.
- The default defers large results and keeps trivial ones inline; **the model submits only exceptions**
  (`toolResultOverrides: [{seq, inline}]`), so the judgement costs almost nothing in output.
- Invocations and arguments always stay inline — that is the "what was attempted" half of the record.
- The artifact file is written **either way**, so a wrong call is a context miss, never data loss. That
  asymmetry is what makes it safe to hand this decision to a model.

```
**Assistant:** Let me check the migration order.
  ↳ tool: bash `npm run migrate -- --dry-run`
    result: 41.2 KB, sha256 8f3a1c… → .dsh-chapters/01HTAB…/artifacts/8f/8f3a1c9d….txt
```

Artifacts are **content-addressed**, so the same 200-line file read ten times across a whole subtree is
stored once. Images and attachments take the same path, since Markdown cannot carry them.

The chapter files themselves are **Markdown with YAML frontmatter**, deliberately not XML: the consumer
is a model reading text, markup tokens are context tokens in a plugin whose purpose is bounding context,
and the session log plus the registry already hold the machine-readable structure. Frontmatter carries
`seqRange`, `session`, `root`, `sha256`, and `tokens`, so files stay queryable without a heavier format.
The reasoning, and the single condition that would reopen the question, are in
[docs/architecture.md](docs/architecture.md#file-format-markdown-with-frontmatter-not-xml).

### The impossible band: too big never means "try anyway"

A tool result at or above `toolResultArtifactTokens` (default 8000) is stored as a
content-addressed **artifact the moment it arrives** — before the next model request is
composed — and the context carries a reference stub instead: size, sha, path, and the
query instruction. The blob is prefilled zero times; the retention paradox (a newest node
too big to file) becomes unreachable by construction. The model works the artifact with
`chapters_artifact`: `toc` (heading map with line numbers — a 300-page book arrives with
its own contents), `search` (term hits as small blocks), `read` (exact line ranges). The
archive-time judgment above is unchanged for everything that genuinely fits.

### What "lossless" means here — precisely

Because oversized results are deferred, chapters are no longer self-contained, and the claim has to move
with the design:

> **Every byte of the conversation remains retrievable** — inline in its chapter, or by an exact path
> printed in it. Nothing is paraphrased, summarized, or dropped.

That is a weaker-sounding and *more true* statement than "the chapter contains everything." Note also
that tool **effects** (files written, commands run) survive only as their logged output. The parent
session remains the only complete record, which is why the TOC prints its id: consulting an ancestor
directly is the ultimate fallback.

---

## How The New Session Is Created

Worth reading before contributing, because it is the least obvious part of the design and the reason
there is a Phase 0.

DSH's fork operation seeds a child with the parent's history — `packages/api/session-controller/src/commands.ts:260`:

```ts
seed: source.events.slice(0, cut),
```

Using that would give the new session *all* of the parent's context plus the TOC. Context would grow at
every link instead of shrinking, and the plugin would compact nothing.

`seed` is optional (`packages/core/agent/src/index.ts:95`), so the plugin creates a session seeded with
one synthetic event and attaches it to the parent's workspace. That is what makes a bounded head real.

Two honest consequences:

- **Lineage lives in this plugin's registry, not in the kernel.** A synthetic-seed child is not a
  fork-inherited session, so the web UI's branch graph shows it as an unrelated root. The chain and
  manifest view are this plugin's responsibility.
- **It leans on kernel internals.** Workspace attachment and agent-preset composition are replicated
  from the api-proxy fork handler, following the `dsh-session-fork` precedent, and must be re-verified
  against each DSH upgrade.

---

## Ancestry Without Traversal

Continuing an older session twice makes history a tree. Asking an agent to navigate a tree is how agents
get lost, so **the model never does it**:

- **The plugin walks the ancestor path and emits a flat, numbered, chronological list.** Reading order
  *is* causal order. At depth 10 or mid-branch, the agent sees an index and `read` paths — no graph, no
  inference, no traversal.
- **The TOC is the only index.** It already lists every chapter on the path with its summary, and the
  registry holds the machine-readable form. An earlier draft added a per-root `MANIFEST.md`; it was
  dropped as a redundant, drift-prone duplicate whose size made reading it its own context cost.
- **Back-links are printed** — root session and parent session — so the trace is visible without being
  reconstructed.

Chapters are keyed by **creating session** rather than a linear chain id, so sibling branches get
different correct TOCs and cannot collide on numbering.

---

## Architecture

```
dsh-chapters/
├── src/
│   ├── index.ts           # plugin entry (name, inject, Config, apply)
│   ├── chapter-store.ts   # chapter rendering, artifact deferral, store I/O
│   ├── toc.ts             # flat TOC assembly from an ancestry walk
│   ├── segmenter.ts       # topic boundary proposal (ctx.llm.stream)
│   ├── budget.ts          # preflight: measure, refuse, never truncate
│   └── continuation.ts    # session creation + workspace attach
├── docs/
│   ├── contract.md        # DSH API facts, schema systems, file:line references
│   ├── architecture.md    # design decisions and their reasoning
│   └── verify.md          # verification procedures and test strategy
├── examples/              # cloned reference repositories (gitignored)
├── cordis.patch.yml       # mounts the plugin into a profile's bundle list
├── package.json
└── tsconfig.json
```

The `src/` tree is still to be written; the repository currently holds docs and the `examples/`
references. `AGENTS.md` is a short core for small-context agents; the detail is in `docs/`.

### Design constraint: never modify the prefix

The most important rule: **never modify the prefix of an existing session.** No `compactRegion`, no
`SurfaceManager.replaceGeneration`, no in-place rewriting. If you reach for a span-replacement API,
stop — that is the operation this plugin exists to avoid.

### Design constraint: never seed from the parent's events

Same reason, opposite failure: a continuation must not inherit its parent's log. One synthetic TOC
event at `seq = 0`, and nothing else.

### Design constraint: the header is global, so never contribute to it

System prompt and tool schemas are not stored per session; they are composed per request from the agent
preset plus plugin contributions. So:

- inheriting the parent's header is automatic — there is no per-session header to protect
- **contributing a system-prompt section would be a cache bug**, changing every session's prefix in the
  profile. Teaching the model about chapters is the TOC notice's job. `dsh-session-fork` does contribute
  a section in `src/prompt.ts`; copying that here would violate this rule
- **cache validity is per-process generation.** A restart or config edit recomposes the header and resets
  cache state profile-wide, which is also why the dev loop's restarts limit what cache measurements prove

### Design constraint: append-only, with no exceptions

Chapters are never copied, rewritten, or renumbered. Splitting an oversized chapter writes *new* chapters
alongside the old, and only at continuation boundaries. Nothing derived is written back into the store —
which is part of why there is no separate manifest file: a regenerated index would be exactly the
mutable, drift-prone artifact this rule exists to prevent.

### Design constraint: two stores, for two reasons

Chapters and artifacts are plain files **in the workspace**, because the `read` tool must reach them —
and it runs under the session's file sandbox. A store under `$HOME` can be writable while being
completely unreachable to the model, silently dead-ending every TOC bullet. Chain bookkeeping — ancestry,
numbering, hashes, ranges — lives in a DSH **storage domain**, the sanctioned durable store. Trade-off:
a workspace-relative root scopes a chain to one working directory.

### Design constraint: measure, then refuse

The new session's *added* context is capped: the TOC plus the handoff note must fit a configured share
(default 25%) of the window **remaining after the system prompt and tool schemas**. This is checked
**before** creating the session, and exceeding it is **an error with numbers, not a truncation**. There is
deliberately no length cap on the handoff note — an over-long note fails this check, and clipping one
would reintroduce exactly the silent loss the plugin exists to avoid. Basing the cap on the remaining
space matters: a 32K model's header alone can occupy a quarter of the window, and a whole-window rule would
make every continuation impossible on precisely the hardware this plugin is for.

### Trigger model

**Manual is the MVP**: ask the agent to segment and continue. The user pays the continuation cost only
when they choose to.

**Pressure detection arrives in Phase 2, and acts in Phase 3.** Detection at `turn/end` reuses the same
budget machinery the preflight needs, so it is built early rather than last — but the automatic path only
*suggests* until Phase 3. It fires **only at turn boundaries, never mid-step**; `agent/pre-step` would
break the user's in-flight request. And since the archive ceiling is a completed `turn/end`, mid-turn cut
points are not merely unsafe — they are not representable.

---

## What Is Still Open

Each of these is a decision or an unmeasured claim, not an oversight. The Phase 0/0b gates that used to
live here were **answered by probe rounds 1-25** — unseeded-but-styled creation is durable, listed, and
resumable; creation schedules no turn (children sit until steered); the compaction seam runs a plugin
subclass end to end with zero summarization tokens; and E3 measured that a compaction halves the uncached
refill rather than cold-restarting the prompt.

- **Coexistence with `dsh-session-fork`.** Name-spaces are disjoint by inspection (domains
  `dsh_chapters`/`dsh_session_fork`, tools `chapters_*`/`branch_*`, presets), but the boot-pair test came
  back MOOT: the shipped example fails to boot against the installed host **on its own** (`webServer`
  inject drift, rc.2-era code vs rc.1 host — attributed by booting it alone; r26). Re-run the pair-boot
  on a version-matched host before making it a product claim; until then coexistence is assumed-neutral,
  not proven.
- **Automatic continuation (Phase 3).** The pressure *suggestion* at `turn/end` and any autonomous
  continue decision are unbuilt by design; the engine's own automatic compaction is the host's shipped
  timing and needs nothing from us.
- **The index is bounded nowhere yet.** Chapter size is bounded; TOC length grows with depth, and
  reloading chapters can re-trigger pressure in a loop. Bullet folding, a reload budget, and retention
  for abandoned chains are Phase 4.
- **Integrity is detection, not proof.** Chapter files are writable Markdown replayed as the model's own
  memory, so bodies are hashed and mismatches surfaced — but a writer that can also edit the registry
  defeats it. Accidental drift and single-shot injection are caught; a determined tamperer is not.

## Shared Knowledge (P1, shipped)

Chapters are not just escape hatches — they are a corpus. Per project, a private git repository
(`.dsh-knowledge/` mirror, real transport via pure-JS isomorphic-git) carries the workspace's
knowledge between every harness pointed at the same remote:

- **Turn signatures** (paths/commands/terms — deterministic, zero tokens) are collected at every
  `turn/end`; the fork/continue archive merges adjacent same-topic turns into one chapter and
  splits on topic changes or the size cap (record §4).
- **Derived sharded index** + per-machine curation facts (`index/`, `edits/`) — rebuilt
  deterministically from the corpus, never hand-edited state.
- **`chapters_search`** — the model (or you) query the whole project's chapter history; results
  are paths readable with `read`.
- **Redaction** at the render chokepoint: credentials become stable `⟦redacted…⟧` markers before
  anything is archived (pattern-based speed bump, documented as such).
- **Sync loop**: pull at new-session/fork, debounced push after archives, a file writer-lock, and
  §5.3 degradation: unreachable remote ⇒ LOCAL-ONLY mode where publish/index/search keep working
  and `/chapters-status` says so with the numbers. Divergence rebuilds the mirror (it is
  transport — the workspace store is the truth).

Configure the upstream with `/chapters-link`:

```
/chapters-link                            # show upstream + mirror state (git-status-like)
/chapters-link ~/pools/proj-kb.git        # local-path pool — no HTTP, no credentials
/chapters-link https://… <token>          # network pool — token required (loopback exempt),
                                          #   stored 0600 under the DSH HOME, never here
```

`knowledgeRemote` in the plugin's profile config supplies the same URL as a lazy default for
unlinked workspaces. Status any time: `/chapters-status`.
The design record: [docs/knowledge-repo.md](docs/knowledge-repo.md).

**Not yet built (P2/P3 of the record):** model-assisted enrichment of the vocabulary (idle-batched,
per-harness disableable), and the rules-as-chapters lifecycle (`/chapters-rule add|approve|revoke`,
core-section budgets). Both are specced and phased; the corpus layer works without them.

---

## Reference Repositories

Cloned into `examples/` (gitignored). Read the **first** one that answers your question; do not read all
four. `docs/architecture.md` has the full table with line numbers.

| Repository | Role | When to read |
|---|---|---|
| **`dsh-session-fork`** | Primary precedent | Session creation, workspace attach, storage-domain registry, tool registration. |
| **`deepseek-harness`** | Official source | Ground truth for `agents.create`, `SessionHeader`, `defineTool`, `ctx.storageDomain`. |
| **`dsh-compact`** | Config and summarization | The `Schema<Config>` idiom and `ctx.llm.stream()` pattern only. |
| **`dsh-plugin-dev-kb`** | Minimal plugin shell | When you need a plugin skeleton that doesn't touch the agent loop. |

Start with `dsh-session-fork`: `src/vendor/fork.ts`, `src/branch.ts`, `src/store.ts`, `src/tools.ts`.
**Do not port from** its `squash*` files or `vendor/compact.ts` — those rewrite spans, the operation this
plugin forbids — and do not imitate `src/prompt.ts`, per the header constraint above.

---

## Planning

Scoped so the cache-critical path is proven before anything is built on it, with the budget and pressure
machinery moved early because automatic continuation depends on it.

**Phase 0 — Prove the premise.** Package skeleton and one trivial tool. Then the load-bearing question:
can a plugin create a session seeded with a single synthetic event that is durable, sidebar-listed,
resumable after restart, and materially *smaller* in tokens than its parent? Settle the name, the test
harness, and the `dsh-session-fork` coexistence question here.
*If the child is not durable and listed, the design does not work and later phases should not be funded.*

**Phase 1 — Render, cite, and bound.** `chapters_continue` with validated event ranges; bodies rendered
from the log; artifact deferral with content-addressed dedup; registry with ancestry, numbering, and
hashes; flat ancestor-path TOC with handoff note and back-links; the budget preflight with
concrete refusal numbers; atomic ordering and idempotent retry. Manual trigger only.

**Phase 2 — Segmentation as a function, and pressure detection.** `chapters_segment` returning validated
ranges, built as a callable usable **with or without an agent turn**; a `turn/end` pressure check that
surfaces a *suggestion*. Both the UI button and Phase 3 depend on this seam, which is why it is not last.

**Phase 3 — Automatic continuation.** Fires on Phase 2's detector at `turn/end` only, through the same
preflight. Never mid-step.

**Phase 4 — Bound the index.** Split oversized chapters at boundaries; bullet folding past the TOC budget;
a reload budget in the TOC preamble; artifact refcounting and a retention/prune command.

**Phase 5 — UI trigger.** A button in the conversation title bar sharing Phase 2's segmentation.
Deliberately last: it needs a client bundle and the UI slot/locale/connection injects — the heaviest
packaging in the project, for ergonomics rather than correctness.

Permanently out of scope: in-place span compaction, prefix rewriting, seeding a continuation from parent
events, contributed system-prompt sections, and truncating anything to fit.

---

## Development

### Prerequisites

- A working DeepSeek Harness installation
- The four reference repositories cloned into `examples/`

### Installing for development

The entry point is compiled output, so build before installing — and **never run `dsh` without an
isolated `DSH_HOME`**: `scripts/dsh-scratch.sh` forces it and refuses the live profile (see
`docs/development.md` — this repo's development runs inside a harness that must not be restarted):

```bash
npm run build                                                  # emits lib/ from src/
scripts/dsh-scratch.sh --home .dshdev2 plugin --profile web add "link:$(pwd)"
scripts/dsh-scratch.sh --home .dshdev2 web --port 0 --no-open  # disposable instance, its own port/token
```

Then open the printed URL, **pick the "Chapters" preset** (the plugin installs it into the scratch
profile's `.agent-presets/` on first boot), and use the plugin there. For the real target
(Local Qwen, 64K window — the minimum we support for real coding/research work) build the profile first:
`scripts/bootstrap-dev-profile.sh` then boot `.dshdev-local`. Restarts inside one scratch home
are free; anything that could touch `~/.dsh` is the bug the wrapper exists to make impossible.

> **Manual-testing home: `.dshdev-local` (the Local-Qwen @64K target), never `.dshdev`.** The `.dshdev` profile carries
> `dsh-chapters-probe`, whose rounds are one-shot boot experiments that end in `process.exit` by design
> — leaving it mounted kills an interactive server seconds after the URL prints (a live boot that
> answered HTTP 401-with-token-page after 20s once the probe was removed; `scripts/dsh-scratch.sh
> --home .dshdev2 plugin --profile web remove dsh-chapters-probe` is the fix if it reappears).

> A bundle `add` alone does not activate the plugin: bundle layers compose at boot, so a restart is
> required after any change. A restart also recomposes every session's header and resets cache state
> profile-wide, so cache measurements only mean something within one process generation.

### Trying it out

1. In a **Chapters-preset** session, hold several exchanges across a couple of topics, including one
   tool call with a long result.
2. Ask the agent to call `chapters_segment`. Review the returned ceiling, the real tool-result sizes,
   and the chapters already in the registry; ask for ranges and titles you want.
3. Ask it to call `chapters_continue` with the approved ranges and a handoff note. An over-budget notice
   must come back as a refusal WITH numbers, not a clipped note.
4. Switch to the new session (titled, listed). Its first message is the flat TOC, and it should feel
   empty apart from that.
5. Ask it to `read` a chapter path, then follow one artifact reference, and confirm both return real
   text — this is the reachability check; existence proves nothing.
6. Separately: in a long enough Chapters session let pre-step pressure compact, confirm a chapter file
   lands beside the durable `compaction/summary` (provider `dsh-chapters`, no `usage`), and `read` the
   chapter from INSIDE the compacted session — that is the engine path earning its name.

### Verifying a build

`docs/verify.md` has the full 20-step procedure with what to record. The three that decide whether the
design works at all:

1. **The new session's token count is materially smaller than the parent's.** Check this first — every
   other assertion can pass while this one fails silently, and a failure here means the child was seeded
   from the log
2. **The parent's cache hit rate is unaffected** — continue the parent and confirm
   `usage.cacheReadTokens` on the next step, within one process generation
3. **The new session builds a stable cache on its second turn** — `usage.cacheReadTokens` is high

Plus the correctness set: install and tool listing; TOC as the child's first message; the child listed in
the sidebar and resumable after restart; `read` reachability of chapters (not mere existence); artifact
deferral resolves; a second continuation still lists the first's chapters; branching one ancestor twice
yields two correct non-colliding TOCs; kill mid-continuation and retry leaves no orphan citation and no
duplicate number; overlapping or gapped ranges are refused; an over-budget handoff note is refused with
numbers rather than clipped; a hand-edited chapter is flagged from its hash; missing `ctx.fs` degrades to
a clean refusal.

### Removing the plugin

```bash
scripts/dsh-scratch.sh --home .dshdev2 plugin --profile web remove dsh-chapters
rm -rf .dshdev2/.agent-presets/chapters    # the installed preset; user-editable, left on purpose otherwise
```

---

## Contributing

Read the constraints first — they are not stylistic preferences, they are the reason the plugin exists.
`AGENTS.md` is the short core; `docs/contract.md` has the API facts with citations.

### Hard rules

- **Never modify the prefix of an existing session.** No span replacement, no in-place rewriting.
- **Never seed a continuation from its parent's events.** One synthetic TOC event, at `seq = 0`.
- **Never let the model author chapter bodies.** It supplies ranges and labels; the plugin renders.
- **Never truncate to fit.** Measure and refuse with numbers.
- **Never contribute a system-prompt section.** The header is process-global, so contributing invalidates
  every session's cache in the profile.
- **Never copy or rewrite an existing chapter.** The store is append-only across the subtree, with no
  documented exceptions and nothing derived written back into it.
- **Never reorganize chapters mid-session.** Continuation boundaries only.
- **Never fire the automatic trigger mid-step.** Turn boundaries only.
- **Never trust agent-supplied ranges.** Validate ordering, overlap, and coverage against the archive
  ceiling — an overlap duplicates archived text and a gap silently drops it.
- **Use schemastery for plugin configuration.** `import Schema from '@deepseek-ai/schemastery'` — a
  **default** import — and `export const Config: Schema<Config> = Schema.object({ … })`. Plain objects are
  rejected. Tool `parameters` are the opposite: plain declarative specs, not schemastery.
- **Always give a tool an `output` schema.** It is mandatory on every `ToolDefinition`.
- **Call `next()` in waterfall listeners** unless deliberately short-circuiting, and document why.
- **Put tunable parameters in config.** If `cordis.yml` can change it, it does not belong in code.

### Reporting a bug

Include parent, child, and root session ids, the store directory, the archive ceiling, the chapter paths
and any artifact references, and `usage.cacheReadTokens` for the parent's steps immediately before and
after plus the child's first two steps — noting **which process generation** each was taken in. Above all,
include the **first-request token counts of both sessions**: a silently re-seeded child is the most
damaging regression, and that number is what catches it.

---

## License

Apache 2.0
