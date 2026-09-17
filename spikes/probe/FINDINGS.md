# Phase 0 — Measured Findings

Five probe boots against a throwaway harness (`DSH_HOME=$PWD/.dshdev`, `--port 0`), each process killed
and re-started for the last one. Round sources: `lib/index.round1.js` (results.json), `round2.js`
(results-2.json), `round3.js`, `round4.js`, `round5.js`. Nothing here is inferred; every line is output.
(**Later sessions grew this file:** rounds 6-11 below, and rounds 12-17 — the Phase 0b compaction-seam
campaign — are appended at the end with their own `results-12..17.json`.)

## Verdict: the premise holds

**A plugin can create a session whose entire content is one synthetic message, and that session survives
process death and is re-readable.** So a bounded continuation head is real, and Phase 1 may be funded.

```
create boot : seeded session, live, 5 events
verify boot : ctx.sessions.get(id)            → absent (cold, expected)
              ctx.sessionQuery.observeSession → FOUND, events: 5      ← durable + re-readable
```

## The seed contract, as measured

A seed must be **contiguous from seq 0**. The kernel's own setup events are *not* part of the caller's
seed — they are appended after it. Observed final log of a one-event seed:

```
user/message@0        ← ours: the TOC notice
session/end-seed@1    ← kernel boundary marker
permission/preset@2
sandbox/mode@3
approval/policy@4
```

Rejections seen verbatim, which is how the contract was found:

| Attempt | Kernel said |
|---|---|
| `{content: [...]}` | `seed user/message at index 0 lacks an identified message` |
| `{id, content}` (no role) | `… message must have role "user"` |
| `{id, role: "user", source: "user"}` | `… message has invalid source` |
| seed at `seq: 3` | `seed event at index 0 has seq 3 (expected 0); seed must be contiguous from 0` |

The accepted `user/message` data shape:

```js
{
  id: <uuid>,                    // required — "identified message"
  role: 'user',                  // required, exactly "user"
  source: { kind: 'plugin',      // required, and an OBJECT, not a string
            plugin: 'dsh-chapters',
            form: 'snapshot',
            sections: [{ name: 'chapters:toc', text: <TOC markdown> }] },
  content: [{ type: 'text', text: <TOC markdown> }],
}
```

`source` accepted `{kind: 'user'}` and every `{kind: 'plugin', plugin: …}` variant tried, including
without `form`/`sections`. **`kind: 'plugin'` is the right one for us** — and see the next section for
why it matters more than the shape itself.

## The design validation hiding in the real logs

Reading the host's own session logs (`~/.dsh/sessions/**/*.jsonl.zstd`) to find that shape turned up the
important thing: DSH already injects context into live sessions by **appending plugin-sourced
`user/message` events**. Observed in production logs:

- `source: {kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections: […]}`
- `source: {kind: 'agent-instructions', form: 'instructions', changes: [{action: 'set'|'replace', digest, path, scope}], baselineIdentity: …}`
- `source: {kind: 'skill-catalog', form: 'catalog', entries: […]}`

The `agent-instructions` events carry a **digest per file and a `changes` list** — i.e. when `AGENTS.md`
changes mid-session, the harness appends a delta message rather than rewriting the prefix. That is the
same move this plugin makes with its TOC notice, and it means:

1. **Invariant 3's objection is confirmed; its stated *mechanism* is not.** A plugin's system-prompt
   section is materialized into the session log as an appended snapshot message, so a contributed section
   is genuinely per-session content, present in every session that loads the plugin — the rule stands. But
   "appended" is the opposite of "rewrites the prefix", so the specific claim that it destroys caches is
   unproven and may be wrong. See the caveat below; fix the wording in AGENTS.md if the next round
   confirms appending.
2. Our notice should imitate the `plugin`/`snapshot`/`sections` shape rather than inventing one, so it is
   attributable (`plugin: 'dsh-chapters'`) and renders through whatever the UI already does for those.
3. The `format-watch` lesson from `dsh-session-fork` is real: that vocabulary is closed. A retired or
   malformed `source` is not a cosmetic problem — upstream reports logs that then refuse to load. Pin it
   with a test before shipping, and treat `kind: 'plugin'` + our bundle id as a fixed contract.

## Two doc claims this refuted

1. **Wrong**: "there is no host-side `ctx.sessions.fork` for a plugin to call." It exists on
   `ctx.sessions`, along with `_forkSeed` and `_resolveForkSource`. **Correct**: it is capability-gated —
   `session fork is owned by session-controller; ambient plugin access is denied`. So `agents.create` is
   not a gap in the design; it is the sanctioned seam, and the fork path is deliberately closed to
   plugins. Invariant 2 stands on better ground than the docs claimed, and the *reason* changes: we cannot
   copy a parent's log even if we wanted to, which removes the temptation entirely.
2. **Wrong, and retracted**: round 1's note "continuity IS validated". The rejection that produced it was
   a message-shape error firing earlier. Continuity was only genuinely established in round 5, by a seed
   at `seq: 3` being rejected with an explicit contiguity message while `seq: 0` was accepted.

## Rounds 6-9: the remaining rows, closed

| Row | Result | Evidence |
|---|---|---|
| **Sidebar listing** | **PASS** | `listSessions(signal)` — signal is **positional** (`session-query/src/index.ts:174`), records are `{header, live, persisted}` — returns the probe continuations by `header.id`. Round 6's "not listed" was two bugs: an options object where a positional signal belongs, and reading `s.id` off a wrapper. |
| **Attached vs unattached** | attach works | `workspaceRegistry.createCanonical(cwd)` → `workspace.attachSession(id)`. Round 6 created *without* a workspace (round 5-6 had `list()` = 0 workspaces in a fresh profile); round 7+ attached and the session listed. Not the eviction trap — just an unattached session, exactly as `dsh-session-fork/src/index.ts:383-384` describes. |
| **Resume** | **PASS** | `agents.resume({ resumeSessionId })` succeeded **after the create handle was disposed**; while held it correctly refused: *"already owned by an active write handle"*. Ownership working as designed. |
| **Durability + integrity** | **PASS** | A round-7 continuation read back in a later boot: 5 events, notice present, `source.kind: 'plugin'`. Round 6 also proved the TOC text round-trips **byte-identical** through `observeSession`, `sections` intact. |
| **Bounded head (structural)** | **PASS, ~24x** | TOC notice ≈ 102 tokens vs the equivalent 12-turn transcript ≈ 2,476 (chars/4 fallback — `tokenMeter` method names were not matched, so refine). Structural only: no provider round-trip. |
| **Session title** | **OPEN, minor** | `commands.execute('session.rename', {sessionId, title})` resolved without error but `readTitle` still returned `null`. Listing does **not** depend on a title, so this is not a gate — but Phase 1 should title continuations for the UI, and needs the working call. |

## Rounds 10-11: a real provider, and what it actually proved

Round 10 spent **nothing** — every turn died before the provider with
`prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")`. That is
the `hasPreset: false` observation made concrete: **`agents.create` alone yields a durable, listed,
resumable session that cannot converse.** It needs an agent preset and a model selection, exactly as
`dsh-session-fork/src/index.ts:368-381` passes them. Round 11 composed with
`ctx.get('agentDefaultModel').currentSelection()` → `{provider, model, reasoningEffort}` and every turn
completed (`{"kind":"completed"}`).

Measured on the scratch profile (`qwen/qwen3.8-flash` via openrouter):

| Turn | total prompt | hit% | note |
|---|---|---|---|
| parent 1 | 540 | 0% | cold |
| parent 2 | 592 | 86.5% | cache written |
| parent 3 | 627 | 81.7% | |
| **continuation 1** | **633** | **0%** | cold, as expected for a new session |
| **continuation 2** | **692** | **74.0%** | **cacheRead 512 — the child builds a cache. G3 holds** |
| parent 4 | 662 | 77.3% | parent still hitting after the continuation existed |

### Three honest corrections to my own reading

1. **G1 is not measured by this run.** These probe sessions have **no system prompt and no tools** — 540
   tokens for a 3-turn conversation, versus the ~27.5 KB request header (≈6.9K tokens) that real sessions
   carry. A ~633-token TOC is trivially comparable to a ~627-token synthetic history, so the comparison
   was meaningless. The real arithmetic comes from production numbers instead: a live session on this
   harness measured **396,800 cached + 822 uncached ≈ 397.6K tokens** at a **99.79%** hit rate, and a
   continuation would start at roughly header (≈6.9K) + TOC (≈1K) ≈ **8K — about a 98% reduction**. That
   is a computed projection from two measured quantities, and it should be labelled as such wherever it is
   quoted, not presented as an observed continuation.
2. **My G2 assertion was wrong, not the design.** I required `hit%` to hold steady and it drifted 81.7% →
   77.3%. Hit *percentage* is the wrong statistic: it falls whenever the prompt grows past a cache-block
   boundary while the cached prefix is fully retained. The right check is `cacheReadTokens` **not dropping**
   toward zero. On that test the parent passed — it kept serving ~512-token cache blocks throughout.
   Same for G3, which passed cleanly (0% → 74%).
3. **The missing preset is an artifact of the probe, not the plugin.** Round 11's exemplar scan found no
   session carrying `projections.values.agentPreset` because the scratch profile has never hosted a real
   interactive session — there was nothing to copy. `chapters_continue` runs *inside* the calling agent's
   turn, so it can read that agent's own observation for its preset, which is precisely what
   `dsh-session-fork` does. **Carry it forward as a Phase 1 requirement, not an open risk** — but verify it
   there, because a continuation that cannot resolve its model is a broken session the user inherits.

### Metric formula, pinned

`usage.inputTokens` is the **uncached delta**; `usage.cacheReadTokens` is the cached prefix. So:

```
totalPrompt = inputTokens + cacheReadTokens
hitRate     = cacheReadTokens / totalPrompt          // NOT cacheRead / input
```

The earlier `hit%` of 1721%/69356% in these notes came from dividing by the delta and is meaningless —
if any doc or tool computes it that way, fix it.

## What still genuinely requires a model turn

| Question | Status |
|---|---|
| Listed in the web sidebar | **not shown.** `listSessions` was called wrongly by the probe (`signal?.throwIfAborted is not a function`). Needs a correct call, then a human look. |
| Resumable / continuable by a user | **not shown.** `agents.resume` was skipped — the probe's role filter didn't match its own records. |
| Header identity with the parent | **moot as framed.** The header is composed per request, and `hasPreset: false` on a created session means no preset projection was recorded — which also means "inherit the parent's preset via `composeAgent`" is not automatic and Phase 1 must resolve it explicitly. |
| Cache behaviour (G1–G3) | **not measured.** Needs a real model turn: scratch credentials, then token spend. Ask first. |
| Oversized-seed rejection | not tested; only one- and two-event seeds were used. |
| Workspace onboarding | `createCanonical(cwd)` conjured a workspace in an empty profile; whether the real UI groups these sessions under the project row unseen by the probe is a human check. |
| **Invariant 3's cache argument** | Weakened by this round, not confirmed. Seeing `@deepseek-ai/dsh-system-prompt` snapshot content delivered as an APPENDED `user/message` suggests prompt-ish context may travel in-band, in which case contributing a section could be append-only (prefix-preserving) rather than cache-destroying. The behavioural objection to a global section stands regardless — it changes what every session sees — but the sentence "it invalidates every session's cache" is currently unverified. Re-test before repeating it as fact. |

Phase 1 should not start until the sidebar and resume rows above are green — those are exactly the
fiber-eviction failure mode `dsh-session-fork/src/branch.ts:10-14` warns about, and they are the difference
between "a session exists on disk" and "the user can keep working in it".

## Reproduce

```bash
mkdir -p .dshdev
DSH_HOME=$PWD/.dshdev dsh plugin --profile web add "link:$(pwd)/spikes/probe"
# point spikes/probe/package.json main at the round you want to run
DSH_HOME=$PWD/.dshdev PROBE_MODE=sources timeout 90 dsh web --port 0 --no-open
DSH_HOME=$PWD/.dshdev timeout 90 dsh web --port 0 --no-open        # round 5: create
DSH_HOME=$PWD/.dshdev PROBE_MODE=verify timeout 90 dsh web --port 0 --no-open   # round 3: verify
cat spikes/probe/results-*.json
```

The probe installs into `.dshdev` only. It never touches `~/.dsh/profiles/web`, which is the profile this
session is running in.

---

# Phase 0b — the host compaction seam, measured (rounds 12-17)

Rounds 12-17 closed the five "Still to verify" items of `docs/host-compaction-seam.md` against the
installed host (0.1.5-rc.1 CLI whose bundled `@deepseek-ai/dsh-compaction-basic` is **0.1.5-rc.2**, cordis
4.0.2 — verified by reading the installed package.jsons; the npm registry serves both). The probe package
now declares `dependencies` on `@deepseek-ai/{dsh-compaction,dsh-compaction-basic,agent-presets}` at
`0.1.5-rc.2` — exact parity with the host. Rounds 12/14 are **fully offline** (no provider); 13/15/16/17
spent tiny "Reply with exactly" turns: r13 ≈ 1.6K, r15 ≈ 4.7K, r16 ≈ 13.4K (one composed turn), r17 ≈
1.6K — about 21K prompt tokens across four boots.

## The headline: the seam is real, and it is better than the doc hoped

**A plugin that ships its own npm copies of the host packages can subclass `BasicCompactionEngine`,
override only `summarize()`, and run the host's entire compaction machinery with a deterministic,
zero-LLM summary.** Round 12 (manual `/compact` path) and round 13 (automatic `agent/pre-step` pressure
path) — every substantive assertion green; r12's one `ok:false` record is the cross-copy `instanceof`
*finding* quoted under "Corrections this forces on other docs", and r13's was a probe bug
(`pluginInventory` API guess). The load-bearing lines:

| Proven | Evidence (round, probe name) |
|---|---|
| `summarize()` override receives verbatim region content | r12 `summarize got verbatim region messages` — input messages begin `"SEED-0 alpha bravo …"` |
| A zero-LLM `SummaryResult` is legal | the type *has* an unmarked branch (`llmStreamCall?: never`, "template, remote, or other summarizer" — compaction-basic/src/summarizer.ts:100-106); r12 committed with `provider:'dsh-chapters-probe'`, `model:'deterministic'`, **no `usage` field** |
| The durable transaction is honest | r12: `compaction/start` → `compaction/summary` (our text, `shadowedSeqs` matching) → replacement `user/message` with `source {kind:'plugin', plugin:'compact', compactionId}` + `surfaceOp:{op:'replace',startSeq:0,endSeq:4}` → `compaction/end`; **log 10→14, shadowed events still readable at their seqs** (invariant 1 confirmed by the host itself) |
| The shrink floor protects, not truncates | r12 second `compactNow` → `ManualCompactionError code='summary'` "could not produce a smaller summary" — when our TOC wouldn't beat the last nodes' price, the kernel refused |
| Surface pressure actually drops | r12: 6 nodes/504 tok → 2 nodes/206 tok; r13: a live session's **turn-2 request went out at 603 tokens after a 974-token turn 1** — mid-session relief, automatic |
| The automatic path dispatches into the subclass | r13: `agent/pre-step` (registered by the base ctor) → our `compactIfNeeded` override → our `summarize()` → durable records `turn: 2` (numbered owner, mid-turn automatic bracket) — despite the host listener living in a *different fiber* from the plugin's ctx… i.e. the base's listeners see real agents |
| `/compact` mounts and resolves our service | r12: the probe bundle's own patch layer re-enabled the host `command-compact` row (`- id: command-compact\n  disabled: false`); boot succeeded (its strict inject `['commands','compaction']` was satisfied by OUR registration from a different module copy) |

## The architecture the seam doc did not know (found in the composed profile)

`DSH_HOME=$PWD/.dshdev dsh --profile web --dump-config` + the installed bundle patches show the web
surface **disables all three host-plane compaction rows by default**
(`dsh-web-app/cordis.patch.yml:427-434`, same in the fork and the examples snapshot), while the
**`standard` agent preset mounts them inside an isolated cordis group**
(`dsh-agent-presets/presets/standard/agent.cordis.yml:138-156`: `- id: compaction / name: cordis:group /
isolate: {compaction: true, toolResultPruner: true}` wrapping `compaction-basic` + `command-compact` +
`tool-result-pruner`). `minimal` mounts none; `ptc`/`cordis` do. So the seam doc's "disable basic, insert
ours, exactly one engine" was doubly wrong for the web profile: the host rows are *already* disabled, and
compaction is **per-preset-realm, not a process singleton** — one engine instance per mounted session,
which is exactly why the isolation exists (presets/agent-presets/src/mount.ts:256: "A preset publishes a
service behind an `isolate` realm so two sessions cannot collide").

Consequences, each measured:

1. **Double-provision on one plane fails boot loudly.** r14 re-enabled `compaction-basic` next to our
   row: boot died with `service "compaction" has been registered at <BasicCompactionEngine>` thrown from
   the host cordis `reflect.provide` — cross-copy registration goes through the host's own enforcement
   (all cordis internal keys are `Symbol.for('cordis.*')`, so plugin copies interoperate; that's also why
   our plugin-cordis `Service` registered at all). The "two engines fight" worry is kernel-guarded.
2. **`agents.create` composes NO preset.** Rounds 12-15's sessions — including one with
   `meta.agentPreset: 'standard'` — ran *bare*: first-request 974 prompt tokens, `summarize` inputs had
   `tools: 0`, and `serviceForAgent(ctx, agent, 'compaction')` found no realm even mid-step. The header
   records the id and the projection reads it back (`presetAtCreate: "standard"`), but nothing mounts.
   **A bare child cannot read its chapters — it has no `read` tool.** The web path fixes this in
   `api/session-controller/src/agent.ts:377-390`: `composeAgent()` passes
   `setup: async (agentCtx) => presets.mount(agentCtx, id)` to `agents.create` — setup composes the
   agent's scoped world *pre-publication* (core/agent/src/index.ts:100-120).
3. **The fix works: r16** child with `setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard')` —
   **first request 13,315 prompt tokens, 27 header tools.** That is the production G1 shape: a composed
   continuation's cold head is header+TOC ≈ 13.3K *measured* (this roster, qwen3.8-flash/openrouter) —
   up from the old ≈8K computed projection; the ~98%-reduction claim must be recomputed against whatever
   the parent's steady state is, and stays a projection for other rosters.
4. **The preset realm can name OUR package, and our engine then runs automatically for those sessions.**
   r17: user-root preset `probe-chapters-b` (written by the probe to `$DSH_HOME/.agent-presets/`,
   live-discovered — discovery is unmemoized, presets/src/index.ts:96; user presets need a NEW id, since
   discovery is first-root-wins and the shipped system root is prepended, index.ts:179-183) whose
   compaction group names `dsh-chapters-probe` with `auto: true, thresholdRatio: 0.001, retainTokens: 0`.
   A child created with `setup`-mounting that preset: **a second instance of our class was constructed
   during setup** (`instance#1 auto=true threshold=0.001`), the child's turn-2 pre-step dispatched into
   **the realm instance's** `summarize()` (host instance untouched: `hostCalls: []`), and the durable
   records landed (`compaction/start turn=2 → summary → end`). **6/6 PASS. This is the Phase 1 mount
   story: a shipped chapters-preset (standard's rows, our row in the compaction group) + `setup`-mount
   in `chapters_continue` — no host-plane engine needed at all** (keeping `auto: false` on any host
   registration if we ever add one; a realm agent's steps are also seen by host-plane listeners —
   r13 proved host-plane auto dispatch — so a host engine + realm engine WOULD double-fire; round 14's
   kernel refusal only guards one plane).
5. `serviceForAgent` (the realm-inspection helper) is **blind across the module-copy boundary**: it
   scans `livePresetMounts()` from its own module instance, and the host mounted presets in its copy.
   r14/r15/r16 saw `undefined` even when the realm existed. Instance counting inside our own class is
   the reliable witness (r17).

## Corrections this forces on other docs

- **`compactIfNeeded` cannot fire on a session's first step**: `routedTarget()` is undefined until the
  first durable routed request (compaction-basic/src/index.ts:260-261) — r13 measured it (turn 1: zero
  compaction events; turn 2: fired). "Pressure relief before the first request" is impossible by design.
- **The base's automatic timing IS `agent/pre-step`** (index.ts:144) — between steps, never mid-request,
  and the pressure loop is bounded (`compactionRetries`, then throw → caught → warn → `next()`, turn
  continues: index.ts:152-159, 312-328). r13's turn 2 completed cleanly while the loop ran (one
  compaction committed inside a single pre-step; the retry-then-throw path is code-reading, not yet
  exercised). Our AGENTS.md hard rule "never `agent/pre-step`" was written for *our own*
  session-creating actions; inherited engine timing is the harness's own and must not be described as
  violating anything. The rule stands for `chapters_continue`.
- **Our engine inherits pruner invocation** — see next section — and it calls `ctx.get('toolResultPruner')`
  inside the realm, which is why the preset group mounts basic and the pruner together (standard yml
  comment: "the pruner must share this realm rather than sit outside it").
- **Manual `/compact` classification degrades across the copy boundary**: command-compact (host copy)
  does `error instanceof ManualCompactionError` (command-compact/src/index.ts:76); our engine (plugin
  copy) throws its copy's class. r12 section J: `/compact` **threw raw `ManualCompactionError`** where
  it should have returned the curated text. If we mount `command-compact` in a row next to our engine
  from our own module tree (r17 style) the classes match again; a host-plane pairing needs our own
  command. Design note for Phase 1, not a blocker.
- **`retainRatio` must be in (0, 1]; use `retainTokens: 0` for zero-tail tests** — r13 died boot with
  `BasicCompactionConfig.retainRatio (0) must be a number in (0, 1]` (rc.2 added this validation beyond
  the `validateRatioRetention` in rc.1-era source). Misconfiguration fails loud, per house style.
- **A class-plugin's inherited `static inject` gates `ctx.*` property access**: our first r12 pass died
  with `cannot get property "agents" without inject` because we inherited `['llm','tokenMeter','sessions']`.
  Subclassing carries the base's inject; append what you use. `ctx.get(name)` works for optional services.
- **`ctx.get('compaction')` returns the host's receiver-proxy, not the raw instance** — `rawEq: false`
  while our `p12Marker` property read through (r12). Identity comparisons against the service must not
  be written; behavior checks through the proxy are fine.

## Check-by-check closure of the seam doc's list

1. **Engine replacement** — PROVEN, above (r12/r13/r14/r17); production shape is the **preset realm**,
   and the kernel polices single-provision per plane.
2. **Shadowed-content reachability** — *by default composition*: the model has **no** tool that reads
   shadowed or log-only events. The web profile's only session-history surface for the model is absent
   (`dsh-tool-session-query` is not in the installed tree nor in any preset's tool rows; `session_search`
   appears only as a browser RPC on the session-controller typert surface, and the sqlite full-text
   backend ships `path: ':memory:', openAt: never`). **But the capability exists as an opt-in package**:
   rc.2's `packages/session-query/tool-session-query/` gives the model `session_event_read`
   ("one full unabridged event as JSON", plus searches with `surfaces: [current|shadowed|log-only]`)
   once mounted — README: "The package is opt-in, and enabling it adds fixed guidance plus five tool
   schemas to every model request." So the README's "no addressable handle to get it back" needs the
   precise version: *no handle in any default composition; an opt-in event-JSON tool exists upstream;
   neither gives topic-named readable files or a zero-token index — and mounting it costs five tool
   schemas plus guidance text in every request, which is the tax this plugin exists to avoid.* This
   session's own log is ambient confirmation: 738 events, zero `compaction/*` so far, no session-query
   tools in the roster.
3. **Prefix-cache sharing across sessions** — settled by rounds 10-11: **none** (child cold 0%, then
   builds its own to 74%), so every continuation pays exactly one full cold header (13.3K measured,
   r16). The comparison side is NOT yet measured: whether in-place compaction keeps the ~12K header
   cached while refilling only the replaced span + retained tail. r13's sessions were header-less
   (`cacheReadTokens` absent on both turns — zero cache), so its 974→603 is a pure prompt-size result,
   not a cache result. **verify-delta (a) still needs a composed (r16-shape) session with ≥2
   post-compaction turns**; until then "compaction is kinder to the cache than a continuation" is a
   mechanism argument, not a measurement.
4. **Pruner × our deferral** — compose, with one rule and one precedent:
   - Ordering: `compactIfNeeded` runs `prune.pruneSession(session)` **before** range selection and
     remeasures (index.ts:278-308), so by the time our `summarize()` sees `input.messages`, oversized
     results are head+`PRUNE_MARKER`+tail (pruner src/index.ts:83-122; 8192/4096/1024 chars by config).
   - The pruner never mutates history: each replacement is a new `tool/result` event with
     `sourceEventSeqs: [originalSeq]` citing the untouched original (pruner index.ts:169-175), preceded
     by a `compaction/prune` shadow-price event. **Rule for chapter rendering: render bodies from the
     durable log following `sourceEventSeqs` backwards to the first version of each event — never from
     `input.messages`** — then chapters keep full verbatim text whatever the pruner did to the surface.
     (This is also why the correlation plan must survive pruned content.)
   - The shadow-price fold needs nothing from us: we never append `replace` ops on our own — the base
     transaction does, and its pricing is already correct.
   - A pruner-side *precedent* for us: model-free, replay-safe surface surgery already ships and is
     composed by default inside the standard group; our value-add over it is the retrievable file +
     path (the seam doc's own claim, now with the exact mechanism).
5. **Message-source vocabulary** — pinned in code: `src/notice.ts` (builder + transcribed kernel
   validator) and `test/notice.test.ts` (10 tests: every measured seed-time rejection reproduced; the
   published `MessageSourceMap` kinds and `ContextForm` union as constants; a drift guard that parses
   the *installed* `dsh-llm/lib/types/message.d.ts` when readable and fails on a removed form —
   never skip-and-silent). Note the kernel's seed check is only "non-empty string kind" for
   `user/message` (dsh-session lib assertMessageEventShape) — the *published* union is the contract;
   an unpinned kind is exactly the 66-log class of mistake, hence the closed list.

## The correlation seam for chapter files (settled by source, to verify in Phase 1)

`summarize()` receives only `(input, agent, signal)` — **no shadowed seqs** (region.ts:401), and the
manual path calls `compactSurfaceRegion` **without dispatching `this.compactRegion`** (index.ts:382),
so overriding `compactRegion` cannot capture manual transactions. The trustworthy correlation is
afterwards: `CompactionResult.shadowedSeqs` (and the durable `compaction/summary` event, which carries
`compactionId`, `shadowedSeqs`, `shadowedRange`, our `summary` text). Plan: `summarize()` emits TOC
text citing **deterministic paths derived from the open `compaction/start` event** (findable at
summarize time: the last unmatched `compaction/start` is this transaction — the lock semantics in
region.ts:309-335 guarantee uniqueness), chapter files are then **finalized post-commit** from the
authoritative `shadowedSeqs` via the durable log (rule 4 above). If the transaction fails after
summarize, the reserved numbers are abandoned — append-only tolerates gaps; the store is never lied about.

## Reproducing rounds 12-17

```bash
cd spikes/probe
# deps are pinned to the INSTALLED host's sub-package versions (0.1.5-rc.2, cordis 4.0.2):
npm install --no-audit --no-fund        # one npm install; package-lock.json (committed) pins the exact tree
node -e "const fs=require('fs'),p=JSON.parse(fs.readFileSync('package.json','utf8'));
  p.main=p.exports['.']='./lib/round17.js'; fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
# the row config in cordis.patch.yml must match the round's intent (auto/threshold per round header)
DSH_HOME=$PWD/../../.dshdev timeout 240 dsh web --port 0 --no-open
cat results-17.json   # the probe writes JSON then exits the process itself
```

Rounds 12/14 need no credentials; 13/15/16/17 use the `.dshdev/.credentials.yaml` already present and
spend only the tiny turns listed above.

## Doc corrections made alongside Phase 0b

- `docs/architecture.md § Bounds` had a bullet corrupted in the file's *first commit* — an orphan
  fragment `DAG" becomes a new way to exhaust context.` with its opening lost (not introduced by these
  rounds; `git show 748b9da` lacks the file, `dc8346e` has the fragment). It was reconstructed from the
  surrounding design (ancestor-path-only TOC flattening, § Ancestry) with an in-place note; re-review
  and delete that note.
- README's "the agent … has no addressable handle to get it back" → qualified with the check-2 finding
  (no handle *in default composition*; opt-in event-JSON tool exists upstream; neither is a readable
  chapter).
- AGENTS.md: invariant-2 composition paragraph rewritten for the setup-mount discovery; the
  "never `agent/pre-step`" hard rule scoped to session-creating actions (inherited engine timing is the
  host's own); G1/cache paragraphs updated (13.3K measured head; header-cache-across-compaction flagged
  OPEN); Phase 0b verdict added to Start Here.

---

# Phase 1 stages 0-3 — the real plugin boots (rounds 18-21)

Rounds 18-21 ran the COMPILED plugin (not probe stubs) in `.dshdev`/`.dshdev2`.
Provider turns spent: r18 ≈ 3.4K, r19 ≈ 2.6K + 4.5K (cascade reruns), r20/r21 zero.

## Proven

1. **A preset realm row can name a plugin subpath export** — `name: dsh-chapters/engine`
   → `exports["./engine"]` resolved and mounted from the profile's symlinked
   package (r18). This is the engine's deployment shape: never the host plane.
2. **The real `ChaptersCompactionEngine` ran the automatic path end to end** (r19):
   pre-step pressure → deterministic TOC summarize → durable commit → post-commit
   reconciliation → chapter files on disk with verbatim seed text → second
   compaction's TOC merge-forwards bullet 1, whose path resolves to the real
   file (assertion checks `fs.existsSync`, not string equality) → both committed
   summaries carry NO `usage`; 4 provider usages, all conversation turns.
3. **A shipped plugin can deliver its preset by copying to `$DSH_HOME/.agent-presets/`
   at boot** (r21, write-if-missing + config-gated), because the alternative is
   dead: profile-patch `!!js` evaluates as `new Function('ctx', ...) with (ctx)` —
   **`require` is not defined** (r20's boot-killing failure, quoted below), so a
   patch layer cannot name a package-relative `roots` path. The kernel's own
   dshHomePath() IS in the interpolate scope (how base rows root storage paths).
4. **Registry finalization survived contact with reality** — see bug below.

## Bugs this stage caught (the argument for boot probes over reading)

- **Finalization only ran on the success path, and the retry loop breaks that.**
  The base's pressure loop can COMMIT compaction N and then throw on attempt N+1
  (shrink floor). `compactIfNeeded` rejecting meant my override never finalized
  the committed record: measured state had **3 plans / 1 finalized / zero logged
  errors**. Fix: `#finalizeGuarded` runs on BOTH paths (`catch → finalize →
  rethrow`), the scan being idempotent makes the failure path free. Rerun:
  2/2 committed summaries finalized, orphan plan = the shrink-refused attempt,
  exactly the designed abandonment semantics.
- **The base's `resolveConfig` rejects unknown row-config keys at RUNTIME**
  (loader passes config unstripped): `BasicCompactionConfig: unknown key
  "artifactStoreRoot"` killed the realm mount at r18's first flight. Engine rows
  must destructure their own keys off before `super(ctx, config)`.
- **`ctx.logger` is invisible in headless `dsh web`** (r19: every useful warn
  vanished; console got one line). Engine failures now mirror to an append sink
  when `DSH_CHAPTERS_ENGINE_ERRORS=<file>` is set — diagnostics seam, not config.
- Probe-hygiene near-misses worth recording because they cost cycles: `plugin add`
  REWRITES `dsh.profile.bundles` (re-add any earlier link), the loader's logger
  writes nowhere visible, and a probe that `rm -rf`s a shared store dir can
  delete a still-running older probe's chapters — per-run unique store roots
  fixed it. A bare `dsh plugin add` (no wrapper) hit the LIVE profile once;
  `scripts/dsh-scratch.sh` now refuses any `DSH_HOME` under the real `~/.dsh`
  (the sandbox's EROFS made that mistake harmless; the wrapper makes it
  impossible).


## Round 22 — the MVP loop, closed end to end (9/9)

Through the REAL wiring (`buildChaptersTools` + real storage domain + real
`agents.create`/`presets.mount`/workspace attach): parent turn →
`chapters_segment` (ceiling 22, candidates, existing chapters) →
`chapters_continue` (two ranges, registry-committed, budget
~180/25751 allowance) → chapter files on disk with correct frontmatter
(seqRange, sha256, `unrenderedSeqs` accounting) → child session whose WHOLE
history is one TOC notice resumes after handle disposal → one real turn on the
child: **15,014 prompt tokens** (the composed chapters-preset header, r16's
13.3K plus this roster), it calls `read` on its first cited path, and replies
`REPLIED: # Seeds one` — the chapter's own title line, from disk, through the
model. Reachability proven, not asserted.

Probe lessons folded into docs: `assistant/message` data is an envelope
(`data.message`, not `data.content`); raw `agents.resume` composes nothing and
must mirror session-controller (agentOptions + setup-mount); JsonValue output
schemas reject `undefined`-typed fields (conditional spreads) and interface
types (anonymous literals carry the implicit index signature);
parameter-properties break strip-mode — explicit constructor assignment only.

## Round 23 — E3: the header-cache claim, measured

Composed session (full chapters preset via `setup` mount; engine row tuned to
`thresholdRatio: 0.001, retainTokens: 0`), three tiny turns. One deterministic
compaction committed between turns 1 and 2 (provider `dsh-chapters`, `usage`
absent — again zero summarization tokens, now with a REAL header present):

| turn | inputTokens (uncached) | cacheReadTokens | totalPrompt | compactions so far |
|---|---|---|---|---|
| 1 (route establishment) | 13,658 | 1,024 | 14,682 | 0 |
| 2 (post-replacement) | 7,032 | **7,424** | 14,456 | 1 |
| 3 | 7,177 | **7,424** | 14,601 | 2 |

Verdicts: **E3 passes** — `cacheReadTokens` did not collapse when the surface
head was replaced; it HELD at 7,424 across both post-compaction turns while
uncached refill halved (13,658 → ~7,000) and stayed halved. Honest phrasing:
**"refill halves", never "the header stays fully cached"** — the measured
cacheable prefix is ~7.4K of ~13.7K on this provider (block-granularity and
per-session tail context above the pure header). Turn 1's 1,024 (with sibling
sessions warm) confirms r10/11: cross-session sharing is one leading block.
Side observation: with a threshold that small and `totalTokens` including the
request envelope, EVERY pre-step qualifies — compaction then correctly
repeated-and-decayed (each pass shrinks the remainder; the shrink floor makes
further attempts refuse). At the production `thresholdRatio: 0.9` this cannot
thrash; the row config is the governor, as designed.

## Round 25 — the continuation title, closed (and 24 closed the fork)

`sessionController.rename({sessionId, title})` — called from the createChild port WHILE the live
handle is still ours (before dispose), through the official normalizer — appends a durable
`session/title` event: `{"title":"P25 Archive Branch","source":{"kind":"user"}}`. r6's failure was
the wrong door: `commands.execute('session.rename')` is not how a plugin titles a session. The
child's seed is exactly the designed shape: notice@0, `session/end-seed@1`, kernel config events,
title. Listing (`listSessions`) carries the header (no title field — titles ride the log); the UI
reads events, not headers, for names.

Round 24 (8/8) meanwhile closed the fork semantics: `chapters_fork` writes and reserves NOTHING
(forked child's registry state: 0 chapters, 0 reservations), links to the same parent+root, and its
notice cites byte-identical chapter paths — siblings share the archive, they do not duplicate it.


## Round 26/26b — the checklist pass, and the coexistence attribution (zero-drift findings)

**26 (13/15 then 3/3 in 26b)** executed docs/verify.md mechanically on one home: refusal-with-numbers
budgets, named overlap refusals, tamper marks flowing into a real child's notice (`⚠ modified since
archived`), idempotent retry (`numbersAfterRetry: [1, 2]`, no duplicate chapters), cross-boot registry,
cross-boot resume of BOTH sibling kinds, child seed shape (`notice, end-seed, permission, sandbox,
approval, title` — no parent text), creation-schedules-no-turn. The two initial FAILs were my probe
referencing `.dshdev` session ids from a `.dshdev2` boot — fixed by 26b, which is the honest way to test
a process boundary.

**Coexistence with dsh-session-fork: MOOT at this version pairing, attributed honestly.** Building the
example fresh (legacy-peer-deps; tsc+tsdown ok) and booting it beside us died with
`cannot get property "webServer" without inject` inside ITS rpc/client-connection path — and it dies the
same way ALONE (verified: chapters removed, re-booted, identical error). The example's code is rc.2-era;
the installed host is 0.1.5-rc.1 and its client-connection requires the injection the example does not
declare. Not our collision, not theirs — a version-drift casualty. Name-space disjointness stands by
inspection (tools `branch_*` vs `chapters_*`, domains, `/branch`, presets); re-run the pair-boot on a
matching host before shipping claims either way.

## Round 27/27b — first contact with the REAL target (Local llama.cpp qwen3.8-flash-next)

Hardware truth, recorded before any conclusions:
- **One small turn with the composed Chapters preset = 494s wall** — 12,563 prompt
  tokens recomputed (llama.cpp metrics agree exactly) + ~300 reasoning tokens out at
  roughly 0.2-0.6 tok/s generation. The 32768-token *configured* window is consumed ~38%
  by the header before any conversation exists. This is the pain the product targets,
  measured on the actual machine.
- **llama.cpp's prompt cache is a shared slot, and my own health-check curl evicted it**
  (second run reused only 2,048 of 12.5K). Discipline for local-hardware probes: no
  side traffic between measured turns; `prompt_tokens_total` deltas are the ground
  truth, immune to adapter usage-field mapping.
- **Manual-path 'persistence' failure — ROOT-CAUSED, probe-side, product unaffected**:
  compactSurfaceRegion flushes via `ctx.sessions.flush(session)`, and the flush threw
  `cannot get property "sessions" without inject` because the *probe* constructed the
  engine with a ctx whose `inject` omitted 'sessions' — r12's property-proxy rule biting
  in a new place (the throw is caught at `closed && options.flush`, wrapped as code
  'persistence', AFTER the transaction committed — which is why my catch-path finalization
  still wrote chapters in the failed run). `src/engine.ts` declares 'sessions' in its own
  static inject, so the shipped product never hits this. Lesson for any code constructing
  host Services: the declaring context must inject everything the inherited internals read.
- The r27 probe design itself was wrong twice over: a 44K-token "overflow" demo on a
  server with n_ctx 128K cannot overflow, and at these rates any prefill-proportional
  demo costs the whole window per turn. Sized-down, automatic-path, metrics-diffed is
  the shape that survives contact with the hardware.

## Round 28 — measured on the target hardware (Local qwen3.8-flash-next, configured 32K)

Full install (plugin + tools + acquire fix), manual path, server counters as ground truth:

| step | server recompute | cache reuse | wall |
|---|---|---|---|
| turn 1 cold (header + 12 seeds) | 16,504 tok | 0 | 648 s |
| compactNow via OUR engine | **0 tok** | 0 | <1 s, chapter file verbatim on disk |
| first turn after replacement | 14,888 tok | **0** | 580 s |
| steady-state turn | 19 tok | 14,920 | **2 s** |

- The plugin's central claim, hardware-measured: deterministic compaction costs llama.cpp ZERO prompt
  tokens where `basic`'s summarizer call would prefill the whole span (~11 more minutes per event on
  this box). The compacted session then runs at ~2 s/turn until the next replacement.
- **Local vs cloud cache behavior DIFFERS and the docs must say so**: after a head-position replacement
  the llama.cpp slot reuses NOTHING (prefix-keyed, replacement rewrites the head; T5 cacheReuse = 0)
  while the cloud provider kept ~7.4K of header cached across the same operation (r23). "Compaction
  halves the refill" is the CLOUD number; on llama.cpp the compaction win is free-compaction +
  small-steady-state, not replacement-surviving cache. Never quote one machine's number for the other.
- Counter disagreement, quantified: the harness's chars/4 heuristic over-counts this prose ~3-4x vs
  llama's BPE (my ~11K estimate = 16.5K real prompt total incl. header). Direction of error: pressure
  fires EARLY on llama-backed models (never late) — safe, but per-model threshold tuning must
  reference the heuristic-vs-BPE ratio, and any "tokens remaining" UI must label which counter it shows.
- Manual `/compact` semantics verified product-complete: zero busy-retries needed, provider tag +
  absent usage on the durable summary, 17 shadowed seqs -> one chapter with SEED-0 verbatim inside,
  registry `p28` state committed. The acquire fix (e0e67d0) is what unblocked the full-install case.

## Forensics: the user's six browser sessions (.dshdev-local, evening) — every symptom explained

Decoded from `session.v3.jsonl.zstd` (note the `.zstd` extension) in the dev home's session dir.

1. **All six sessions ran `agentPreset: "standard"`** (`agent-preset/selected` events). The web picker
   always sends an EXPLICIT preset; the profile default only governs creations that omit one. So the
   user's experience was vanilla-basic the whole time: its summary carries `provider: "local"`,
   `usage: {input: 41,553, output: 3,377}` — one compaction billed ~45K real tokens on their box.
2. **System prompts are preset-invariant**: `system/message` text between a browser-standard session
   and the chapters p28 probe is byte-identical EXCEPT the harness's own GUI URL line, which contains
   **the per-boot port** (`http://127.0.0.1:46807` vs `:34139`). Corollary — a restart rewrites the
   system prompt by a dozen characters and therefore cold-invalidates llama.cpp's prefix cache on
   EVERY first turn after a boot. dsh-chapters contributes no prompt section (verified by grep + this diff).
3. **The ranged-read behaviour is the pruner, not Chapters**: before the first `compaction/prune`
   (seq 78), 10/10 reads were full-file; after the 10 prunes, 13/16 reads carried offset/limit — the
   model chasing content whose full read-result had been replaced by head+…+tail stubs. On a 1M-window
   profile the pruner almost never fires; at 32K it fires constantly. Same preset, different window.
4. **"Regeneration outside compaction events" is precisely those prunes**: each prune breaks the
   surface prefix at its seq; the next request recomputes from there — and prunes render as ordinary
   (changed) tool results, not as an obvious compaction in the transcript. The prompt cache itself is
   healthy (r28 turn-6 reused 14,920 tokens on an unchanged prefix).
5. **Server facts from HTTP alone** (`/props`, `/slots`, `/metrics` — no docker needed): `n_ctx: 65536`
   (my earlier ≥128K inference from `n_tokens_max` was wrong), `--parallel 1`, slot save/clear
   endpoints unsupported (no `--slot-save-path`). Slot 0 carries an abandoned task (50,790 prompt
   tokens, processed 0) — cosmetic, not blocking. Log access route: have the user run
   `docker compose logs --tail 60 qwen-flash-next > ../dsh-chapters/var/model-server.log`, or tee the
   server's stderr into a bind-mounted file in compose.yml.

## Forensics-2: the user's Chapters sessions — engine flawless, pruner hostile; preset made dormant

The "second Describe" (session-ecf4353f): OUR compaction — `provider dsh-chapters, model deterministic,
usage None`, 34 events shadowed, chapter `001-describe-this-project...md` on disk. Same in the first
(19780692). The engine demonstrably works in the user's real browser workflow on the real model.
But the same session recorded 11 prunes / 35,589 chars and 19/29 ranged reads — the standard pruner
(8,192-char default) is the entire cache-cliff + line-chasing complaint, and it was inherited verbatim
by our preset copy. Minimal's cleanliness is simply "no compaction group at all" (and no relief valve
either). Fix: `presets/chapters/agent.cordis.yml` mounts the pruner with `thresholdChars: 1000000` —
dormant insurance, not a participant — because Chapters defers oversized results at ARCHIVE time
(verbatim chapters + artifact references) at zero surface cost between compactions. Installed preset
deleted from .dshdev-local; next boot re-copies. The default-pruner story also explains why the user
saw ranged reads chasing stubs: the pruner's replacement text teaches exactly that.

## Forensics-3: shrink VERIFIED server-side, and the user had already moved to 64K

Session-ecf4353f step-by-step usage (server-reported): pre-compaction surface peaked at
**56,661** prompt tokens (step 10: 3,456 + 53,205 cache); our compaction committed at seq 146
(zero tokens); **step 11's request: 31,587 total, cache 0** — a real 44% shrink; the swap's
one-time refill cliff, then steps 12-17 reused 32-39K each with only ~1-2K new. The user's
meter observation was right twice over: the turn kept running 7 more steps back up to ~41.5K
(65% of window), so the meter never LOOKED reset; and the window was **64000, not my 32768 —
the user had edited .dshdev-local/settings.yaml at 16:54** (mtime + diff proved it), and the
threshold math confirms the engine honoured their edit (0.9 x 64000 = 57,600; fired exactly
there). Policy decision from the user, now canon: 32K too small for coding/deep-research
(header alone 13-15K); **64K is the minimum supported window**; template and bootstrap updated
(write-if-missing settings so user tunables survive re-bootstrap; --force to overwrite).
