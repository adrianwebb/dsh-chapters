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
| E3 | Header cache across a compaction — **CLOSED by r23 (measured)** | a composed session (27-tool chapters preset) took a deterministic compaction between turns 1 and 2; `cacheReadTokens` held at **7,424 on both post-replacement turns** while uncached refill fell 13,658 → ~7,000 and stayed there. Verdict wording: "the header prefix survives surface replacement; refill halves, it does not vanish" — never "the full ~13K header stays cached" (measured cacheable prefix on this provider was ~7.4K of ~13.7K) |
| E4 | Pruner composition | with `tool-result-pruner` mounted in the realm, a chapter covering a pruned result still renders the ORIGINAL text (follow `sourceEventSeqs` backwards), plus the model's inline override where requested |
| E5 | Shrink-floor refusal is loud | a region too small to yield a smaller framed TOC fails with `ManualCompactionError code='summary'` and changes no surface (r12 behavior; keep as regression) |
| E6 | Automatic timing inherits the host's | compaction lands at `agent/pre-step`, bracketed `compaction/start.turn` = open turn number (r13/r17 `turn: 2`); never mid-request, never mid-step |

## Bug Reports

Cache and context behaviour are the plugin's core promise, so a report must include:

- parent session id, child session id, root session id, store directory, archive ceiling
- chapter paths written, and any artifact references
- `usage.cacheReadTokens` for the parent's steps immediately before and after, plus the child's first two
  steps — **and the process generation (which restart) each was taken in**
- **first-request token counts for both sessions** — the single most diagnostic number, since a silently
  re-seeded child is the most damaging regression
- the ranges supplied and the refusal text, if a preflight rejected the attempt
