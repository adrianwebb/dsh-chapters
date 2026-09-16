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

## Bug Reports

Cache and context behaviour are the plugin's core promise, so a report must include:

- parent session id, child session id, root session id, store directory, archive ceiling
- chapter paths written, and any artifact references
- `usage.cacheReadTokens` for the parent's steps immediately before and after, plus the child's first two
  steps — **and the process generation (which restart) each was taken in**
- **first-request token counts for both sessions** — the single most diagnostic number, since a silently
  re-seeded child is the most damaging regression
- the ranges supplied and the refusal text, if a preflight rejected the attempt
