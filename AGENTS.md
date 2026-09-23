# dsh-chapters — agent core

Working spec for an agent with a 32K–128K context. This file holds only what you must not get wrong.
Detail lives in `docs/` and is linked at the point of use — read those on demand, not first.

**Scope: development only.** This file guides agents developing THIS repository. Nothing shipped —
runtime behavior, the knowledge corpus, or any test — may depend on it or its contents: every real
target project carries its own instruction files, unpredictable and private to that project. The
archive-time screen that enforces this is `src/injections.ts` (host-injected context is marked, never
archived); the test-time rule keeping it out of tape matching is AGENTS-BLIND masking in
`tests/e2e/model-proxy.ts`.

- `docs/contract.md` — DSH API facts: schemastery vs zod vs tool param specs, `defineTool`, `inject`,
  `Config`, packaging, `ctx.llm`, file:line references
- `docs/architecture.md` — how a continuation is created, chapter rendering and the artifact store,
  budgets, ancestry, atomicity, integrity, phases
- `docs/development.md` — the build/test loop that does not restart the harness you are editing from
- `docs/host-compaction-seam.md` — **read before writing code**: the harness already ships pressure
  compaction, overflow recovery, and a `summarize()` subclass hook. This is our real integration surface and
  it deletes most of what an earlier plan assumed we would build.
- `docs/verify.md` — verification checklist and manual test procedures
- `docs/knowledge-repo.md` — **the governing design record for the shared knowledge layer**
  (git repo, two-layer index, topic-sequential composition, rules, search, sync loop, P1–P3
  phasing). Read before planning or implementing anything in that layer; amendments are human
  decisions, recorded in git.
- `docs/provider.md` — the knowledge-transport seam (Amendment 2026-09-21): the six verbs a
  provider implements, git vs TreeDX truth table, failure classes, state file, and the rules
  every backend must honor

## The Four Invariants

**1. Never rewrite the durable session log.** Append-only, always. Surface-span *shadowing* is permitted —
and is in fact the shipped mechanism (`compaction/*` events are log-only and a replacement `user/message`
carries the summary; `shadowedSeqs` names the hidden nodes). What is forbidden is mutating or deleting
recorded events, and replacing anything in the **header**: that is the cache cost that matters, measured at
~12K tokens on a 32K model.

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

  **A created session composes NOTHING by itself.** Round 10 proved it for the model: no `agentOptions`
  ⇒ every turn dies with `prompt variable "{{model}}" has no value for this assembly`. Phase 0b proved
  the deeper half: **`agents.create` never mounts a preset** — `meta.agentPreset` is a durable label only
  — so a setup-less child is a tool-less agent (r15: first request 974 tokens, `tools: 0`; no `read`,
  so no chapter reload). The sanctioned fix, which session-controller itself uses
  (`api/session-controller/src/agent.ts:377-390`), is
  `setup: async (agentCtx) => ctx.get('agentPresets').mount(agentCtx, presetId)`. So `chapters_continue`
  must pass `agentOptions` (from `ctx.get('agentDefaultModel').currentSelection()`), the caller's preset
  id resolved from the calling agent's own session observation, AND the setup-mount — same shape as
  `dsh-session-fork/src/index.ts:368-381`. A continuation that cannot resolve its model or tools is a
  broken session the user inherits. **Resume is the same trap**: raw `agents.resume` composes nothing
  either; anything resuming a child programmatically must pass `agentOptions` + `setup` too (r22 — the
  web UI path already does, via session-controller; a plugin-driven resume does not).

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

## The Point — and the Cost

**The win is zero-inference indexing, not cheaper compaction.** Producing a summary requires prefilling the
whole history into one auxiliary call: ~17 minutes for 100K tokens at 100 tok/s, ~55 at 30 tok/s, and it
repeats every time the window fills. Our chapters are written from the log (a file copy) and our index is
generated deterministically — **zero model tokens, zero summarization latency**. Measured: ~102 tokens of
index versus ~2,476 for the equivalent transcript, on a 32K-capped model. The mission is retrievable memory
that lets a small model keep going until the objective is done.

**This is not cheaper than in-place compaction** in the cache sense. The new session pays one cold prefill of system
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
      agents.create({ seed:[TOC notice], agentOptions, setup: mount(presetId) }) ──► new session
                                          │   (all three or the child is broken — invariant 2)
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
- **Never create a session automatically mid-step.** Continuation-creating actions fire at `turn/end`
  boundaries only. (In-place *surface* compaction is different and is the harness's own design: the base
  engine compacts at `agent/pre-step` — between steps, never mid-request, bounded retries — measured
  r13/r17 and durable-correct there. Do not add a second automatic engine timing of our own.)
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

**Phase 0b passed (rounds 12-17): the compaction seam is real.** A plugin-subclassed `BasicCompactionEngine`
with a deterministic `summarize()` ran both the manual (`/compact`) and automatic (`agent/pre-step`)
paths to durable commit — surface 504→206 tokens, **zero summarization tokens**, log append-only
throughout. The live engine slot is the **agent-preset realm**, not the host plane; double-provisioning
one plane fails boot loudly; and the Phase 1 mount is a shipped preset naming `dsh-chapters` +
`setup`-mounted creation (all of it measured, cited, in
[docs/host-compaction-seam.md](docs/host-compaction-seam.md) and FINDINGS).

**Phase 1 stages 0-4 landed (rounds 18-22): the whole loop works with the real parts.** Registry/store/engine/
preset-install/tools pass — a realm row names our subpath export (`dsh-chapters/engine`), the cascade
finalizes post-commit, `presets/chapters/` installs itself into `.agent-presets` at boot (profile
`!!js` has no `require`, copying is the delivery mechanism), and r22 closed the MVP loop: parent →
`chapters_segment` → `chapters_continue` (ranges only; plugin renders) → TOC-only child with the composed
preset (15K head) → the CHILD `read` its chapter and echoed its title back. Two real bugs caught and
fixed en route: finalization must run on the rejection path too (the retry loop can commit, then throw),
and `validateRanges` refuses before any file is written.
Rounds 23-28 then: E3 measured (per-machine — see the Cache section, never cross the numbers),
`chapters_fork` (r24), the durable title (r25), the 20-check mechanical pass (r26/26b: 18/20 proven
on-scratch, the rest human-only), the target-hardware verdict (r28: zero-token compaction confirmed at
llama.cpp counters, ~2 s steady-state turns), and a full-install product bug found-and-fixed by the
same run — one domain, one opener, `acquireChapterStore` (e0e67d0).
**MVP state: engine + tools + preset verified ON THE REAL MODEL, and the message-level fork BUTTON
is shipped and e2e-green** (`conversation.chat.assistant-actions` → `remote.commands` → watermark
fork → `sessions.open` after `refresh`; `tests/{unit,integration,e2e}`, Playwright with
workspace-cached chromium — client-plane facts are now measured, never guessed).
**Long-context mechanics (architecture amendments, 2026-09-19) are BUILT**: arrival-time
artifacting — tool results ≥ `toolResultArtifactTokens` never enter the surface (stub +
content-addressed artifact, queried via `chapters_artifact` toc/search/read; measured: 373KB
book, zero blob prefills, cacheRead monotone across the stub) — and plot carriage (persona
`PLOT:` discipline carried through in-place checkpoints; bounded elicited fallback behind
`elicitedPlot`). e2e is now NINE specs in SIX projects (suite @ 0.75 of the pinned 32K/15K
stress regime; heavy @ 0.5 with the arrival floor OFF — measured: a floor below the chunk size
arrival-stubs the surface and silently prevents compaction from ever being needed; arrival @
production 0.9 + floor 500; fanout @ 0.75 — its own boot since 2026-09-23, the chains its child
sessions write are the deepest on this hardware and must be distilled in isolation; enrich @
0.9 with enrichmentEnabled; rules @ 0.9) against port-keyed throwaway homes `var/e2e-home-<port>` — the dev
home is SHARED with live agents and must never be the test ledger (FINDINGS 2026-09-19: run 13
asserted against an agent transcript; draft identity, YAML colon-in-plain-scalar, worker-bound
setupFiles, and same-home sibling boots all bit; identity is now verified via localStorage + the
log's own header event). ACCEPTANCE RUNS OFF THE MODEL TAPE by default:
`npm run test:e2e:replay` serves every model turn from `tests/fixtures/model-tape/<project>` (proxy
`tests/e2e/model-proxy.ts`; explore 14.7 s replayed vs 1.7 min live; recorded usage keeps the
token meter — and thus threshold behavior — bit-identical); `npm run test:e2e:record` distills
tapes from the real model (once per scenario; re-record when PRODUCT prompts change —
persona, tool descriptions, notice text, thresholds. Workspace docs (AGENTS.md itself,
skill catalogs) are masked out of matching by the AGENTS-BLIND rule (user decision
2026-09-20: development artifacts, every real project ships its own — doc edits are
FREE, no re-record — with one measured exception: near-threshold scenarios (heavy, fanout)
digest the injected doc into their compaction summary as model-visible prose, which no
delimiter mask can reach; after an AGENTS.md edit, re-record THOSE tapes (2026-09-23).
Best practice: finalize doc edits, then distill). `rm -rf tests/fixtures/model-tape` for a clean corpus. The normalization
pipeline is CLOSED — escape/whitespace classes, volatile rules, tool-result content and
injected instruction blocks matched out; the AGENTS-blind addition was the last change
and required one final re-record; 2026-09-23 added two DERIVED-COUNT collapses to the
same family — `(N est tokens)` in chapter index lines and the char count inside
`⟦omitted:host-injected …⟧` markers (both move with doc/render drift, both identified
already by their line — pinning them made heavy/enrich tapes brittle across builds). Replay chain verified green — all SIX projects strict 2026-09-23 (suite×4, fanout, heavy, arrival, enrich, rules; zero fallback). The `rules` browser scenario was UN-PARKED — the r39 diagnosis: the spec read zstd-compressed session directories as flat files and hardcoded a rule id; the product was always right. The enrich e2e earned its keep: it exposed two real product bugs invisible to every deterministic layer (verify.md T9/T10 — the body-hash anchor convention mismatch that silently blocked enrichment since P2, and the missing host-plane route) (r38 lesson: the DRAFT screen turns composer text into a first MESSAGE, not a command — establish a session before exercising command surfaces; and RR2=137: a chatty live loop that records mid-test can be OOM-killed — keep e2e prompts tool-free in WORDS the model obeys; and 2026-09-23: a tape records the CONTEXT it was distilled in — re-record whole projects, never one spec of a shared boot, and never run two GPU suites at once). 288 unit/integration, zero skips when the TreeDX container is up (live-gate fails loudly when configured-but-unreachable; skips only with no configuration at all).
Git history was rewritten 2026-09-20 (test-results/.dsh purged, .git 7M→840K) and force-pushed —
clone fresh or `git reset --hard origin/main` after pulling.
**Knowledge layer P1 (record §13) is complete and live-proven**: signatures collect at real
`turn/end`s (r35j), the fork composes topics live (r36 — same-file turns merge, topic changes
split), the index + `chapters_search` + redaction + `/chapters-link`/`/chapters-status` ride a
sync loop that degrades to local-only honestly and rebuilds the mirror on divergence, with the
two-machine exit criterion automated over a real git smart-HTTP remote (integration + the
`knowledge.spec.ts` browser journey). **P2 is BUILT (2026-09-20)**: the idle/after-push
enrichment ladder with validation-before-commit, provenance chains (`generated:` newest-first),
the body-hash guard as the only sanctioned chapter-file mutation, `/chapters-enrich
run|model|report`; shadow-by-default emergent vocabulary writing git-visible `topic-alias`
curation + derived `topics/vocabulary.json`; and index-level fragment stitching (adjacent
legacy fragments cohere into ONE search entry citing all members — nothing merged on disk). Two-machine exit criterion proven — catching r37 on the way: stageAllAndCommit compared the workdir against itself, making modifications to tracked files permanently invisible to commits (additive P1 hid it; enrichment would never have traveled). **P3 is BUILT (2026-09-20, §15 amendment: approval = per-machine curation fact, never a file rewrite)**: write-once proposed rule files, /chapters-rule add|list|approve|revoke, chapters_rule_propose tool, verbatim core block in the continuation notice (byte-identical ABSENT, golden-tested), refuse-with-numbers overflow budget, category-aware search with a per-machine core bonus, and the rules lifecycle proven transport-grade over a real pool with three machines. §7.4 auto-inclusion stays P3b.
**Knowledge transport is now a provider seam (2026-09-21, record §15: "transport is pluggable; git is one provider" + "host-injected context is not conversation")**: `src/provider.ts`'s six verbs carry every sync path; `kind:'git'` (default, every pre-existing record — zero behavior change) or `kind:'treedx'` (`/chapters-link treedx+<url>/<repo> <token>`, `src/treedx/`: workspace-create → overlay-write → commit transport, `.treedx-state.json` mirror memory). Search/rules/index/notice layers read the materialized mirror unchanged — §3.1 survives both backends; divergence routes through rebuild-from-the-store in both; TreeDX lease contention maps to the existing rejected→pull-retry, moved head to diverged. Contract + truth table in `docs/provider.md`; TreeDX API facts (doc-reads vs live-measured, with corrections) in `spikes/treedx/FINDINGS.md`; dev loop `scripts/treedx-local.sh` + `dev/treedx.compose.yaml` (the cloned repo's own compose is platform-bound and will not boot standalone — measured). Transport-grade proof: 24 tests over an in-process stub (`treedx-{provider,sync,link}.test.ts`); the real-container exit criterion (`treedx-live.test.ts`) ran and PASSED 2026-09-21 (5/5 against a booted dev-auth service; full suite 286/286 zero skips — the live run caught three parser shapes, the born-with-`.treedxkeep` phantom-deletion trap, the lease-survives-TTL close requirement, and a swallowed auth detail, all fixed and pinned). **The same round landed the injection screen** (`src/injections.ts`): host-injected context (instruction files, runtime snapshots, skill catalogs, our own TOC notice — event-level and `<system-reminder>` spans inside human messages) is marked-and-counted, never archived; the conversation-bytes guarantee and TOC `(N msgs)` now say what is actually true, and the knowledge corpus carries no project's instruction bytes (H1 rows in `docs/verify.md`).
**Outstanding: the human verification rows (live `/compact` in a real browser, readability
judgment), per-message anchoring (the button forks at the conversation's end today; `deriveRanges`
already supports any anchor), and the default-preset shipping policy (opt-in menu vs profile
default), which is the user's call, not ours.**

The fiber-eviction trap `dsh-session-fork/src/branch.ts:10-14` warns about did **not** bite — an unattached
session was the whole explanation for round 6's "not listed", fixed by
`workspaceRegistry.createCanonical(cwd)` → `workspace.attachSession(id)`.

**Cache behaviour measured (rounds 10-11, 13, 16, real provider).** A continuation builds its own cache —
0% hit cold, 74% warm — and the parent keeps hitting across the boundary, so **G3 and G2 are green**. G1's
head is now *measured* for the composed shape: r16's `setup`-mounted child's first request was **13,315
tokens (27-tool header, this roster)** — quote the older "≈ 8K" only as a projection. Steady state it
protects: 396,800 cached + 822 uncached (**99.79%**) live session. E3 measured — and it is
per-machine (r23/r28): on the cloud provider a replacement keeps ~7.4K of prefix cached (refill
halves, 13,658 → ~7,000); on llama.cpp (the target) the slot reuses NOTHING across a head-position
replacement (cacheReuse 0) — the local win is zero-token compaction (r28: 0 prompt tokens vs ~11 min
for an LLM summary on that box) plus ~2 s steady-state turns. **Never quote one machine's cache
number for the other.**

Metric formula, since getting it wrong produces 1721% hit rates: `totalPrompt = inputTokens +
cacheReadTokens`; `hit = cacheReadTokens / totalPrompt`. Judge "cache undisturbed" by
`cacheReadTokens` not collapsing, **not** by hit percentage, which falls innocently as the prompt grows
past a cache-block boundary.

Phase 1 follow-ups CLOSED: the title call is the *service* (`sessionController.rename`, live-handle
window — r25 durable), and the preset/composition note in invariant 2 ships in every child.

Coexistence with `dsh-session-fork` is currently **untestable, not disputed**: the shipped example fails
to boot the installed host ALONE (its rc.2-era code vs rc.1's `webServer` inject requirement — verified
by pair-boot then solo-boot, r26). Name-spaces are disjoint by inspection; re-run the pair-boot on a
version-matched host before claiming either way. The dev/test loop that avoids restarting the harness
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
