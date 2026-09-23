# Verification

The checklist in `AGENTS.md` is short because it only lists what matters. This is how to actually
perform each check, with the numbers to record.

## Test Strategy First

Decide the harness in Phase 0, before Phase 1 code. Both reference plugins test their own way:
`dsh-compact` uses vitest (`vitest.config.ts`, `test/`, `e2e/`), `dsh-session-fork` uses `bun test`
with `tests/`.

The point of choosing early: several core guarantees are *pure functions* and must be unit-tested, not
hand-verified on a live profile every time.

| Unit-testable without a running harness | Why it must be automated |
|---|---|
| Range validation (ascending, non-overlapping, coverage ≤ ceiling) | A silent gap drops archived history forever |
| Chapter renderer: event slice → Markdown, including fence-escaping and artifact deferral | Deterministic input/output; the only cheap way to catch a renderer truncating at an embedded ```` ``` ```` |
| `anchoredBoundaryOf` → archive ceiling | Vendored kernel logic; drift is invisible until a chain is corrupted |
| TOC assembly from a fixture registry (flat, chronological, back-links) | Proves the DAG flattening without a live session |
| Preflight budget math and refusal message | The "never truncate" guarantee is one `if` away from being lost |

Kernel-dependent behaviour (durable create, sidebar listing, cache behaviour) cannot be unit-tested and
needs the live procedure below.

## Live Procedure

Install for every step, after building:

```bash
tsc -p tsconfig.json
dsh plugin --profile web add "link:$(pwd)"
# restart: Ctrl-C, then `dsh web`, then refresh the page
```

A restart recomposes every session's header, which resets cache state profile-wide. **All cache
measurements are only meaningful within one process generation** — record the generation (restart) with
the numbers, or the measurement is unreproducible.

### The Gate Checks

**G1 — The child is smaller than the parent.** *The* regression test for the seeding mistake.
Record the first-request `usage` of both. Expected: child ≈ system prompt + TOC + note, and **materially
below** the parent's. A child near the parent's size means it was seeded from the log — invariant 2
violated. Every other check can pass while this one fails silently, so check it first.

**G2 — The parent's cache is undisturbed.** Continue the parent; record `usage.cacheReadTokens` on the
step before the continuation and the step after. Expected: both high, no drop.

**G3 — The child builds a stable cache.** Send two messages in the child; `cacheReadTokens` should be
near-zero on the first and high on the second.

Steps 4, 7, 8 of the `AGENTS.md` list are G1–G3. They are the whole point of the design.

### Correctness Checks

| # | Check | Procedure | Passes when |
|---|---|---|---|
| 1 | Installs | `dsh plugin --profile web add "link:$(pwd)"` | no error; note that `add` alone does not activate |
| 2 | Tools listed | restart, open an agent session | `chapters_segment` and `chapters_continue` in the tool list |
| 3 | Files written | run a continuation on a 2-topic conversation | chapter files exist under `<store-root>/<root>/chapters/` |
| 4 | **G1** | see above | child first request materially smaller |
| 5 | TOC is the first message | open the child | its entire content is the TOC notice; nothing inherited |
| 6 | Durable and listed | restart `dsh web` | child still in the sidebar, still resumable |
| 7 | **G2** | see above | parent `cacheReadTokens` unchanged |
| 8 | **G3** | see above | child cache builds on turn 2 |
| 9 | Reachability | in the child, ask it to `read` a bullet path | returns real archived text. A **reachability** test, not file-existence — pass `ls` first to see the difference |
| 10 | Artifact deferral | archive a turn with a large tool result; mark it `inline: false`, then `read` the reference path | artifact written and path resolves; identical results stored once; **and** the same result is still written when inlined (deferral is a copy decision, not a data decision) |
| 11 | Cumulative TOC | a second continuation | first fork's chapters still listed, by ancestry walk |
| 12 | Sibling branches | continue an ancestor twice | two correct, non-colliding TOCs, each listing only its own ancestor path |
| 13 | Registry survives restart | restart, continue again | ancestry and next number resume; no reset to `001` |
| 14 | Atomicity | kill `dsh web` mid-continuation, restart, retry the same call | no orphan citation, no duplicate numbers, no TOC pointing at a missing file |
| 15 | Range validation | hand it overlapping ranges and a deliberate gap | refused with the offending range named — not silently archived wrong |
| 16 | Preflight refusal | force a note large enough to blow the budget | refused **before** any session is created, with token numbers; **no truncation** |
| 17 | Tamper detection | edit a chapter body on disk, then continue | `⚠ modified since archived` surfaced from the stored hash, not silent trust |
| 18 | `ctx.fs` absent | run in a configuration without the fs provider | clean refusal with an actionable message, not a crash |
| 19 | Turn boundary | attempt a continuation with an open turn | ceiling lands on a completed `turn/end`; the in-flight exchange is carried by the handoff note, not by a mid-turn cut |
| 20 | First-turn behaviour | open a fresh child, wait | confirm whether it acknowledges its own TOC (open question 2). If it does, the notice needs a stay-silent instruction |

### Evidence Map (as of probe round 26/26b, 2026-09-17)

Checks 1-19 were executed mechanically on the `.dshdev2` scratch profile
(`spikes/probe/lib/round26*.js`, `results-26*.json`): 18 of 20 PASS with durable evidence — including
[15] overlap refusals naming the range, [16] budget refusals carrying numbers, [17] a tampered chapter
surfacing `⚠ modified since archived` inside a real child's notice, [14] an idempotent retry reusing
numbers `[1, 2]` with no duplicate chapters, [13] registry state read back across a process kill, [6]
continuation children AND fork siblings resuming across boots, [19]/[20] turn-boundary refusal and
creation-schedules-no-turn. [7][8][9] (cache gates) point at r11/r22/r23 evidence; [10] boot-level rests
on its L0 tests plus the citation-rule test; [18] is N/A because the store uses node:fs by design.
**Genuinely human-only:** sidebar/visual resume in a browser, `/compact` observed in a live UI, the
readability judgment of TOC prose and chapter bodies — plus optionally following one real 40KB tool
result into an artifact.

## Knowledge Layer — P1 Checklist (record §13)

| # | Check | Passes when | Evidence |
|---|---|---|---|
| K1 | Project identity | same repo URL, different spellings → one key; non-git cwd degrades honestly; local-path upstreams key off the resolved path | unit `repo.test.ts` (10) + `sync-local-upstream.test.ts` |
| K2 | Redaction at the chokepoint | a secret-bearing transcript never lands in a chapter or artifact, same secret → same marker | unit `redact.test.ts` + render chokepoint test; FINDINGS-era |
| K3 | Turn signatures, live | a completed real turn yields a signature with paths/terms from HUMAN content only | **live probe r35j (K5b)** + L0 `engine-adapter.test.ts` (real Session shape) |
| K4 | Topic-sequential composition | same-topic adjacent turns merge into one chapter; topic changes split; size cap splits | **live r36: merge proven (score 0.171 < τ, shared primary)**; L0 compose/anchor tests |
| K5 | Index | shards deterministic; incremental manifest gates commits; rebuild-from-empty == incremental | unit `indexing.test.ts` (7) |
| K6 | Search | topic>title>summary ranking, budget packing with total-vs-shown honesty, project scoping | unit `search.test.ts`; live r35j (K7: finds through a LOCAL-ONLY mirror) |
| K7 | Commands context-free | `/chapters-link` (4 modes: view / path / git-URL+token / `treedx+`URL+token), `/chapters-status` render as flow nodes; the model's context is unchanged | durable: `command/run`+`command/done` lifecycle events, no model/usage around them (e2e plane); r35j K2/K8; treedx modes: `link-treedx.test.ts` |
| K8 | Sync loop, success path | two machines over a REAL git smart-HTTP remote: publish → remote carries layout+index → clone sees it → search crosses | integration `sync-remote.test.ts` + **e2e `knowledge.spec.ts` — suite green 2026-09-18 (4/4, twice — also after the credential-move + three-mode link)**: browser composer link pushes to a live git-http-backend remote, status reaches 'synced', the child TOC carries the Project line + (N msgs), the debounced push lands `collections/`, and machine B searches A's chapters |
| K9 | Sync loop, degradation | remote down ⇒ local-only mode (mirror+index current, status names it); recovery rebuilds and pushes | `sync-remote.test.ts` degradation arc; **live r35j: link to unreachable remote, search still works, status 'local-only'** |
| K10 | Triggers fire | push scheduled after each archive (debounced); pull on first turn + pre-fork | **proven by K8's e2e run**: `collections/` reached the remote with no manual sync between fork and poll; L0 `scheduler.test.ts` + first-turn tests |
| K11 | Notice v2 | `Project:` line + per-chapter `(N msgs)`; legacy records never render a fake zero | r35j (K6, K6b); `notice.test.ts` |

Human-only rows (unchanged): sidebar visual resume, `/compact` observed in a live UI, TOC/chapter
readability judgment.

## Knowledge Transport Providers (record §15, Amendments 2026-09-21)

| # | Check | Passes when | Evidence |
|---|---|---|---|
| T1 | Seam preserves git behavior | provider selection defaults 'git' for every pre-existing record; all K1–K10 evidence still green after the refactor | full suite (276→285) with zero git-mode changes; `provider.test.ts` selection + migration rows |
| T2 | TreeDX publish/clone/search | machine A syncs (create→workspace→commit), B clones via the provider and `chapters_search` finds A's chapter through the materialized mirror | `treedx-sync.test.ts` (transport grade, stub) + **`treedx-live.test.ts` PROVEN against the real dev-auth container 2026-09-21** (born-head clone, publish→clone→search crossing, bad-token auth detail, head advance/lease reuse, binary blob round-trip) |
| T3 | Divergence & lease classes | moved head + staged work ⇒ `diverged` ⇒ rebuild-from-store republishes BOTH contributions; busy lease ⇒ bounded retry ⇒ `rejected` ⇒ pull-and-retry; failed push CLOSES its workspace (leases survive ttl otherwise — measured) | `treedx-provider.test.ts` (all three), `treedx-sync.test.ts` (rebuild converge) |
| T4 | Degradation with numbers | service down / token bad ⇒ `local-only` (offline mirror still publishes, commits, indexes, searches); `auth` detail carries the re-link instruction, never the token | `treedx-sync.test.ts` offline row; `treedx-provider.test.ts` auth row (token-sentinel absence) |
| T5 | Oversized refusal | a UTF-8 file above the service limit ⇒ refuse with the number, never truncate | `treedx-provider.test.ts` 1 MiB-413 row |
| T6 | Identity namespaces | `treedx+host/repo` key ≠ a git remote's key for the same canonical string (one pool per transport); stable across spellings (`/api/v1`, trailing slash, case) | `provider.test.ts` identity rows |
| T7 | Commands surface | `/chapters-link treedx+…` resolve-or-creates the managed repo, stores the token 0600 under the DSH home, records kind+repoId; view/status print provider + head | `link-treedx.test.ts` (5) |
| T8 | Dead-mirror self-heal | a pre-existing non-empty mirror dir (stale test residue, moved tree, abandoned pool) moves aside as `.stale-<ts>` and the clone proceeds — the old hard refusal made every later sync of an affected workspace a permanent deadlock (the r39 e2e class) | unit `sync.test.ts` self-heal row; `treedx-provider.test.ts` clone row (both providers); e2e boots now run dirty-free |
| T9 | Body-hash anchor round-trips | the frontmatter anchor hashes EXACTLY what `parseChapterFile` returns as the body (the writer appends `'\n'`; hashing bare `bodyText` made every real chapter look tampered to the enrich guard, which silently refused — host logger). Sanctioned writes preserve body bytes and re-anchor the registry's whole-file hash | unit `enrich-store.test.ts`/`enrich-wire.test.ts`; **the enrich e2e passed 2026-09-23 — the first time the ladder ever wrote through the real UI** |
| T10 | Host-plane enrichment route | `/chapters-enrich run` resolves a route from the last real tool-bearing session (`noteRoute` persists `enrichment.route`; the host has no live agent) — without it, a fork-only flow could never enrich | `enrich-wire.test.ts` + the passing enrich e2e |
| H1 | Corpus carries no project instructions | host-injected context (instruction files, runtime snapshot, skill catalog, our own TOC notice — event-level AND `<system-reminder>` spans inside human messages) renders as a countable `⟦omitted:host-injected …⟧` marker, never bytes; conversation survives verbatim and byte-identical | unit `injections.test.ts` (15) + `render.test.ts` rows; integration `corpus-hygiene.test.ts` (archive→sync→remote→pull→search sentinel-absence, and legacy-store-publishes-unchanged anti-migration guard); e2e stays AGENTS-BLIND (tape masking) |

## The Cache Metric, Before You Trust a Number

`usage.inputTokens` is the **uncached delta** and `usage.cacheReadTokens` is the cached prefix, so:

```
totalPrompt = inputTokens + cacheReadTokens
hitRate     = cacheReadTokens / totalPrompt          // NOT cacheRead / input
```

Dividing by the delta yields nonsense like 1721% — which these notes actually did before it was caught.
For "the parent's cache is undisturbed" (G2), assert **`cacheReadTokens` does not collapse**. Do *not*
assert that hit percentage stays flat: it falls innocently every time the prompt grows past a cache-block
boundary while the prefix is fully retained. Measured steady state on this harness: 396,800 cached + 822
uncached, **99.79%**.

## Engine-Path Checks (Phase 0b delta)

For the `ChaptersCompactionEngine` path (in-place compaction, no new session). Rounds 12/13/17 already
proved the *mechanism* offline (durable records, zero usage, realm dispatch — see
[spikes/probe/FINDINGS.md](../spikes/probe/FINDINGS.md) § Phase 0b); these are the product-level checks
that still need a running chapter engine:

| # | Check | Passes when |
|---|---|---|
| E1 | Zero-inference summarization | the `compaction/summary` event carries **no `usage` field** and no provider call appears in the round (proved with a stub at r12/r13; must re-prove with the real TOC `summarize()`) |
| E2 | Archive honesty after automatic compaction | every `shadowedSeq` of a landed compaction resolves (via durable log + `sourceEventSeqs`) into a written chapter file whose hash matches the registry |
| E3 | Header cache across a compaction — **CLOSED by r23 (measured, per-machine)** | cloud: `cacheReadTokens` held at **7,424 on both post-replacement turns** while uncached refill fell 13,658 → ~7,000. Local llama.cpp (r28-era probes): reuses NOTHING across a head replacement (0 cached) but steady-state turns cost only the new content. **Never quote one machine's number for the other.** |
| E2E-TAPE | Acceptance without the GPU | `test:e2e:replay` serves every model turn from `var/model-tape/<project>` (isolated per boot) (proxy smoke: exact + prefix hit, loud 503 miss with journal). Usage fields ride the tape, so the token meter and compaction thresholds fire at identical steps under replay. Tapes are committed test DATA under `tests/fixtures/model-tape/` (the rest of `var/` stays ignored) — CI replays them via `scripts/ci-replay.sh` with no local model; regenerate via `test:e2e:record` (local GPU) when PRODUCT prompts change. The local model remains the distiller and ultimate witness. STATUS 2026-09-23: pipeline current (escape/whitespace classes, volatile rules incl. HOSTPORT-BLIND + derived-count collapses for `(N est tokens)` and host-injected char counts, tool bytes matched out); SIX-project replay chain (suite, fanout, heavy, arrival, enrich, rules). Doc-edit cost is honest, not free: the delimiter mask keeps AGENTS/skill bytes out of ordinary matching, but the harness's own checkpoint summary embeds the doc as model-visible prose in the compaction scenarios, so `heavy`/`fanout` re-record after an AGENTS.md change (finalize docs, THEN distill). The e2e is the integration witness that the deterministic layers cannot replace — it found two real product bugs (the enrich body-hash anchor mismatch and the missing host-plane route) that had been invisible behind the host logger |
| E9 | P2 enrichment + vocabulary, two-machine grade | `node --test tests/integration/two-machine-enrich.test.ts` + `--project=enrich` tape replay | **green 2026-09-20** — enriched frontmatter/provenance cross the pool byte-exact; B honors A’s aliases and dedupes its own vocab pass; caught+fixed r37 (modifications invisible to commits). Four-project replay chain green, 0 misses |
| E2E | The fork BUTTON, browser journey | **green (2026-09-19, 7 specs / three projects — suite@0.75-of-32K + heavy@0.5-floor-off + arrival@0.9-floor-500 — on port-keyed throwaway homes)**: specs CREATE their sessions through the UI ('New session' + one real Local-model turn; turn-complete = the session's OWN `turn/end` in its own log — the global registry count false-passed twice and was retired). Fixture-free by design after the R29-era rows aged out of the 90-session sidebar. The suite also caught the 'Internal Testing Notice' focus trap and the re-link origin bug (see FINDINGS). |
| E10 | P3 rules lifecycle (record §7) | unit (status resolution, budget refusal, golden absent-notice bytes) + transport (three machines over a real pool) + e2e `rules` project replay | proposed everywhere by default; per-machine core facts; verbatim in the child's OWN log after UI approve; overflow refuses with per-rule numbers — **green 2026-09-20 at unit/transport grade** (three machines over a real pool; exit criterion covered); the `rules` browser scenario parked out of the default chain pending the r39 diagnosis — evidence-preservation first |
| E2E-EDGE | Oversized turn handled gracefully | **green in the heavy project (captures 5.3–13.2m; run 11: 5 crossings, 27.8m; 6.0m suite pass)**: one browser turn reads 700KB range-by-range and crosses the threshold 5×: every mid-turn compaction commits (provider `dsh-chapters`, zero usage), every shadowed seq is chapter-covered, the pre-compaction marker survives in the transcript, the turn completes, and the follow-up turn answers — fork row reappears after settle (observed). The model's plan erosion under heavy trims is the fork's motivation; FINDINGS records it. |
| E4 | Pruner composition | with `tool-result-pruner` mounted in the realm, a chapter covering a pruned result still renders the ORIGINAL text (follow `sourceEventSeqs` backwards), plus the model's inline override where requested |
| E5 | Shrink-floor refusal is loud | a region too small to yield a smaller framed TOC fails with `ManualCompactionError code='summary'` and changes no surface (r12 behavior; keep as regression) |
| E6 | Automatic timing inherits the host's |
| E7 | Arrival-time artifacting (architecture amendment) | **green 2026-09-19 (9.3m)**: 373KB book / one read → exactly 1 arrival prune at the tail; model answers buried token + chapter count via 5 `chapters_artifact` calls; ZERO compaction events at production 0.9; blob fingerprint in no `request/*` event; cache table in FINDINGS shows prefix intact (cacheRead monotonically 15.7K→24.5K) |
| E8 | Plot carriage across in-place checkpoints | forward path live (persona discipline — suiteB oversized run carries `PLOT:` blocks through 7 compactions); render→extract round trip pinned in unit (`carried plot survives the checkpoint round-trip`); elicited fallback unit-pinned (capped input/output, degrades to null) — fires only when the agent writes no note | compaction lands at `agent/pre-step`, bracketed `compaction/start.turn` = open turn number (r13/r17 `turn: 2`); never mid-request, never mid-step |

## Bug Reports

Cache and context behaviour are the plugin's core promise, so a report must include:

- parent session id, child session id, root session id, store directory, archive ceiling
- chapter paths written, and any artifact references
- `usage.cacheReadTokens` for the parent's steps immediately before and after, plus the child's first two
  steps — **and the process generation (which restart) each was taken in**
- **first-request token counts for both sessions** — the single most diagnostic number, since a silently
  re-seeded child is the most damaging regression
- the ranges supplied and the refusal text, if a preflight rejected the attempt

## The first real-remote push (manual, one-time per project)

The sync loop is integration-tested against a fake driver that models the git
semantics it relies on; the wire protocol itself is isomorphic-git's (https only
— isomorphic-git 1.42 registers no `file://` transport, verified against its
transport registry). The first push against a real remote is therefore a
**manual, one-time step per project**:

1. Create a **private** empty repo (record §2.1: per-project, user-created) and a
   scoped token for it (fine-grained PAT limited to that repo).
2. In a Chapters session: `/chapters-link https://… <token>`.
   The token is stored 0600 at `.dsh-chapters/.git-auth/<projectKey>`.
3. The command reports the sync steps; on `push rejected`, re-run
   `/chapters-link` (pull-retry) or wait for the next archive event.

If isomorphic-git ever chokes on a specific forge's smart-HTTP, the documented
fallback is a CLI driver (the `GitDriver` seam in `src/gitops.ts` exists for
exactly this swap) — the loop's logic is driver-agnostic by design.
