# dsh-chapters — agent core

Working spec for an agent with a 32K–128K context. This file holds only what you must not get wrong.
Detail lives in `docs/` and is linked at the point of use — read those on demand, not first.

- `docs/contract.md` — DSH API facts: schemastery vs zod vs tool param specs, `defineTool`, `inject`,
  `Config`, packaging, `ctx.llm`, file:line references
- `docs/architecture.md` — how a continuation is created, chapter rendering and the artifact store,
  budgets, ancestry, atomicity, integrity, phases
- `docs/development.md` — the build/test loop that does not restart the harness you are editing from
- `docs/verify.md` — verification checklist and manual test procedures

## The Four Invariants

**1. Never modify the prefix of an existing session.** No `compactRegion`, no
`SurfaceManager.replaceGeneration`, no in-place rewriting. Cache safety depends on it.

**2. Never seed a continuation from its parent's events.** DSH's native fork does exactly that —
`commands.ts:260`: `seed: source.events.slice(0, cut)`. A child seeded that way carries all of the
parent's history plus the TOC, so context *grows* every link and nothing is compacted. Ours is
`agents.create({ sessionId, seed: [tocNoticeEvent] })` — one synthetic event at `seq = 0`. This is the
trap in the original design; do not "helpfully" reuse the fork handler's seed step.

  Measured in Phase 0, and it strengthens rather than weakens this rule: `ctx.sessions.fork` does exist
  host-side but is capability-gated — *"session fork is owned by session-controller; ambient plugin access
  is denied"*. So `agents.create` is not a workaround around a missing API; it is the sanctioned seam, and
  the copy-the-log path is closed to plugins by design. The seed contract, verified by rejection messages:
  contiguous from **seq 0** (the kernel's own `permission/preset`/`sandbox/mode`/`approval/policy` events
  are appended *after* the seed, not before it), and the notice must be
  `{ id, role: 'user', source: { kind: 'plugin', plugin: 'dsh-chapters', form: 'snapshot', sections: […] }, content: […] }`.
  `source` is an object; a string is rejected as `invalid source`. See
  [spikes/probe/FINDINGS.md](spikes/probe/FINDINGS.md).

**3. Never contribute a system-prompt section.** The header is process-global, not per-session, so a
contribution changes what *every* session in the profile sees — which is the opposite of this plugin's
one-continuation-one-notice discipline. `dsh-session-fork/src/prompt.ts` does it; copying that here is a
bug. The TOC notice is how the model learns about chapters: per-continuation and append-only.

  **Caveat, from Phase 0:** the usual *reason* given for this rule — "it invalidates every session's
  cache" — is now doubtful. Real logs show system-prompt sections arriving as **appended** `user/message`
  events, and appending preserves the prefix. So treat the rule as about global versus per-continuation
  scope, not as a proven cache claim, until re-measured. See
  [spikes/probe/FINDINGS.md](spikes/probe/FINDINGS.md).

**4. Never let the model author chapter bodies.** The model supplies `startSeq`/`endSeq`, titles, and
summaries; the plugin renders text from the session log. Model-typed "lossless" archives are
reconstructed from recall, which is the failure mode we are avoiding. It also cannot fit: archiving 100K
tokens would require emitting 100K tokens in one tool call.

## What This Is

Relieve context pressure **without rewriting history**: archive a conversation into Markdown chapters in
a shared store — verbatim text, with oversized tool results deferred to reference files — then open a new
session whose entire content is a cumulative Table of Contents of that archive. The model reloads
chapters with `read`. The original session is untouched.

Say **"every byte remains retrievable"**, not "the chapter contains the full history". The deferral below
makes the second phrasing false, and a TOC preamble that overprompts the model into trusting it is a
real bug, not a wording nit.

**This is not a fork.** Native forking copies history; we create an unseeded session that cites an
archive. The mechanism is a *citation-linked continuation*, and the package name says so — `dsh-chapters`,
tools `chapters_segment` / `chapters_continue`. Why "fork" and "compact" both failed review is in
[docs/architecture.md § Naming](docs/architecture.md#naming).

## Cost — Be Honest About It

**This is not cheaper than in-place compaction.** The new session pays one cold prefill of system
prompt + TOC + handoff note, the same cost class a post-compaction request pays. What we buy instead:

- **verbatim** archive, so a reload returns real text rather than a paraphrase
- **untouched parent**, keeping its cache and remaining usable as an ancestor
- **reversible** — abandon the child and keep working in the parent
- **branchable** — history can fork, not just truncate

Never market or document this as a prefill saving.

## Data Flow

```
agent turn ──► chapters_segment ──► {archiveCeiling, chapters:[{title, summary, startSeq, endSeq}]}
                                          │ agent reviews/edits ranges (never text)
                                          ▼
              chapters_continue(title, handoffNote, chapters[])
                                          │
        ┌─────────────────────────────────┼──────────────────────────────┐
        ▼                                 ▼                              ▼
 render bodies from log          defer oversized blobs            preflight the budget
 (verbatim, per range)           to content-addressed             TOC + note vs remainder
 artifacts/ files                       │                                 │
        └─────────────► chapter .md files ◄───────────────────────────────┘
                                          │ refuse loudly if over budget
                                          ▼
                        agents.create({ seed: [TOC notice] }) ──► new session
```

The two things the model never does: produce archived text, and traverse the ancestry graph. Both are
the plugin's job. See [docs/architecture.md](docs/architecture.md).

## Continuation Budget, Not a Handoff Cap

There is **no cap on the handoff note.** The real invariant is a ceiling on the *newly added* context of a
continuation, expressed as a share of the space **left over after the header**:

```
tocTokens + handoffNoteTokens ≤ continuationBudgetRatio × (window − systemPromptTokens)
```

Measured **before** creating the session. Over budget → **refuse with the numbers**; never silently
truncate. A dropped or clipped handoff note is precisely the lossy behaviour this plugin rejects. A model
that dumps a whole conversation into the note is caught by this same check, so no separate cap is needed.

**Do not re-express this as a fraction of the whole window.** A 32K model with a ~9K system prompt and
tool schemas would have an 8K total budget, making *every* continuation unmeetable — the plugin would
refuse to function on exactly the small-context hardware it exists for. The header is a fixed cost, not a
competitor for the index.

This reserve margin is the same machinery automatic triggering needs, which is why pressure detection
moves **earlier** in the plan rather than later. See [docs/architecture.md § Phases](docs/architecture.md#phases).

## Oversized Tool Results

Long dumps (`read` on a big file, `bash` output) are the bulk of most conversations and rarely the part
worth re-reading. So they leave the chapter body — but **the model decides which ones, not a size rule**,
because "this diff matters, this npm log does not" is a semantic judgement only the agent holding the
conversation can make.

The split of responsibility:

- **Plugin computes** the facts: it has the log, so it knows every tool result's size and can enumerate
  candidates. The model never guesses at byte counts.
- **Default is defer.** Results above a fallback size go to `artifacts/` and are referenced, not inlined.
  Small glue stays inline so the narrative reads naturally.
- **The model submits only exceptions** — `toolResultOverrides: [{seq, inline: true}]` for a large result
  that genuinely matters, or `inline: false` to trim a small one. Sparse by construction, so the judgment
  costs almost no output tokens.
- **Invocations and arguments are always inline.** That is a plugin rule, not a model choice; it is the
  "what was attempted" half of the record.
- **The artifact is written either way.** Inlining is a convenience copy alongside its reference, so a bad
  keep/drop call is a context-economy miss, never a data loss. That is what makes handing this judgment to
  the model safe.

```
**Assistant:** Reading the runner to trace the migration order.
  ↳ tool: bash `npm run migrate -- --dry-run`
    result: 41.2 KB, sha256 8f3a1c… → .dsh-chapters/<root>/artifacts/8f/8f3a1c….txt
```

Content-addressed, so identical results across the whole subtree are stored once. The guarantee becomes
*every byte remains retrievable*, not "every byte is in the chapter" — honest, and a better fit for the 8K
chapter target. Attachments and images take the same reference path, since Markdown cannot carry them.

Full rules in [docs/architecture.md § Chapter Rendering and the Artifact Store](docs/architecture.md#chapter-rendering-and-the-artifact-store).

## Ancestry: A DAG We Flatten For The Model

Branching an ancestor twice makes the history a tree, and asking an agent to traverse a tree is how
agents get lost. So the model never traverses:

- **The plugin walks the ancestor path and emits a flat, chronological, numbered list.** Reading order
  *is* causal order. No graph-walking required, at any depth or in any branch.
- **Explicit back-links are printed** — root session, parent session — so the trace is visible without
  being inferred.
- **The TOC is the only index.** It lists every chapter on the ancestor path, with summaries, in one flat
  numbered block. There is deliberately **no separate `MANIFEST.md`**: the chapter list is already in the
  TOC and the registry already holds the machine-readable version, so a third index would be a regenerated
  duplicate that can drift — and, being read whole, its own growth would reintroduce the context cost this
  plugin removes. Cross-branch (sibling) browsing is a possible future read-only command, not a per-fork
  artifact.
- Chapters are keyed by **creating session**, not a linear chain id, so siblings cannot collide.

Details in [docs/architecture.md § Ancestry](docs/architecture.md#ancestry-a-dag-we-flatten-for-the-model).

## Storage

| What | Where | Why |
|---|---|---|
| Chapter bodies + artifacts | workspace (`<store-root>/<root>/…`) | the `read` tool must reach them; `$HOME` may be unreachable while still writable |
| Ancestry, numbering, hashes, bullet lists | storage domain `ctx.storageDomain` | sanctioned durability, survives restart, atomic-ish allocation |

`ctx.fs` is **optional** — absence must be a clean refusal, never a crash. Chapter files are
**Markdown with YAML frontmatter**, not XML: structure that machines need lives in frontmatter, the
session log, and the registry; the readable surface stays token-dense. See
[docs/contract.md](docs/contract.md) and [docs/architecture.md § Storage](docs/architecture.md#storage).

## Hard Rules

- **Never renumber, rewrite, or copy a chapter, and never add a second index.** The store is append-only
  with no exceptions.
- **Never reorganize chapters mid-session.** Continuation boundaries only.
- **Never trust agent-supplied ranges.** Validate ascending, non-overlapping, coverage ≤ archive
  ceiling. An overlap duplicates archived text; a gap silently drops it.
- **Never truncate to fit.** Refuse with measured numbers instead.
- **Never fire automatically mid-step.** `turn/end` only; never `agent/pre-step`.
- **Schemastery for `Config`** (default import, `Schema<Config>`); **plain specs** for tool
  `parameters`; **zod** for domain records. Three systems, never mixed.
- **Always give a tool an `output` schema** — mandatory on every `ToolDefinition`.
- **Call `next()` in waterfall listeners** unless deliberately short-circuiting, and document why.
- **No hardcoded tunables.** If `cordis.yml` can change it, it belongs in config.

## Start Here

**Phase 0 passed.** Across nine probe boots on an isolated instance, a plugin created a session seeded with
exactly one synthetic `user/message`, and that session was **listed** by `sessionQuery.listSessions`,
**resumable** via `agents.resume({ resumeSessionId })` after disposing the create handle, **durable across a
process kill**, and its TOC text round-tripped **byte-identical**. Structurally the head is bounded: ~102
tokens of notice versus ~2,476 for the equivalent transcript. Full measurements and the seed contract:
[spikes/probe/FINDINGS.md](spikes/probe/FINDINGS.md).

The fiber-eviction trap `dsh-session-fork/src/branch.ts:10-14` warns about did **not** bite — an unattached
session was the whole explanation for round 6's "not listed", fixed by
`workspaceRegistry.createCanonical(cwd)` → `workspace.attachSession(id)`.

**Not yet measured, and it needs a real model turn:** cache behaviour (G1–G3). That requires credentials in
the scratch root and a token spend — ask before doing it. Two minor follow-ups: title a continuation with the
call that actually sticks, and confirm which model/preset a continuation gets (round 8-9 omitted
`meta.agentPreset`/`agentOptions`/`setup` and still resumed, so verify rather than assume).

Also unsettled: whether to coexist with, depend on, or exclude `dsh-session-fork` (it maintains session
lineage and patches client `sessions.fork` globally). The dev/test loop that avoids restarting the harness
being edited from is solved — see [docs/development.md](docs/development.md).

Then [docs/contract.md](docs/contract.md) for how to declare things, and
[docs/verify.md](docs/verify.md) before claiming any step passes.

## Efficiency Rules

1. Do not read all four `examples/` repos. Read the one file that answers the current question
   (`docs/architecture.md § References` has the table).
2. Do not reach for `ctx.sessions.fork`, host-side or otherwise. It exists on `ctx.sessions` but is
   capability-gated ("owned by session-controller; ambient plugin access is denied"), and its handler
   copies the parent's log anyway. `agents.create` with a seed is the only sanctioned path. Measure the
   contract from `spikes/probe/FINDINGS.md` rather than re-deriving it from greps.
3. Prefer `deepseek-harness` over any community plugin when they disagree.
4. Re-check the pinned line references in `vendor/fork.ts`'s header after any DSH upgrade — this design
   leans on kernel internals.
5. Build before installing (`tsc -p tsconfig.json`), and remember a restart recomposes every session's
   header, so cache measurements only mean something within one process generation.
