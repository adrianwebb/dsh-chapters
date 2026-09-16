# The Host Compaction Seam — and Why It Shrinks the MVP

Found in Phase 0b by reading `examples/deepseek-harness/packages/compaction/`, before writing any plugin
code. The plan in `docs/architecture.md § Phases` assumed we would build pressure detection, surface
replacement, and a TOC-delivery mechanism. **The harness already has all three.** Cited so this can be
re-verified on upgrade.

## What already exists

| Capability | Where | Consequence for us |
|---|---|---|
| Automatic pressure compaction with a configurable ratio | `compaction-basic/src/index.ts:126` `if (this.config.auto) this._registerAutomaticCompaction()`; `thresholdRatio` default **0.8**, `retainRatio` **0.16** | Do not build `pressure.ts`. **Delete it from the plan.** We set `thresholdRatio: 0.9` in config. |
| **Provider-confirmed context-overflow recovery** | `index.ts:220-221` (`context overflow recovery`), `maxOverflowRetries`, returns `{ kind: 'retry' }` | The user's "compact when it runs out in the current conversation" is already implemented, including retry. |
| Between-step trigger, replayed at step boundaries | `_registerAutomaticCompaction`, `compactIfNeeded` "dynamically dispatched so subclass overrides are honored" | Correct trigger timing is inherited, and safe: never mid-step. |
| Per-model policies | `modelPolicies: z.array(modelPolicy)`, `resolveTargetPolicy(config, target)` | 32K models get their own ratios without code. |
| **One sanctioned extension hook** | `index.ts:215-217`: "`summarize()` is the **sole subclass customization hook**; the replay and durable mutation strategy stays fixed" | Our entire integration surface: subclass `BasicCompactionEngine` (exported, `export default BasicCompactionEngine`, `:434`) and override `summarize()`. |
| Cache-aware auxiliary call shape | `:224-227`: the summary call's "prefix reuses the conversation's own system prompt, tools, and messages so the provider's KV cache is not invalidated" | The pattern to imitate if we ever need a model call — already solved for us. |
| Transactional result contract | `ManualCompactionError` codes `busy / cancelled / changed / summary / commit / persistence` (`summary` = shrink floor refused; observed live in r12); `compaction/summary` event records summary inputs, route, model, usage, `shadowedSeqs`, `shadowedRange` | Real failure semantics to render, not to invent. `changed` = history moved under us; `commit` = partial application is a documented state. |
| **Tool-result pruning** | `compaction-tool-result-pruner` — "replay-safe, model-free", `PRUNE_MARKER`, shadow-price event | Overlaps our deferral idea. Ours differs by writing a **retrievable file and a path reference**; its pruning replaces content with a marker. Verify they compose before assuming. |
| Image offload | `compaction-image-offload` (`agents`, `sessions`) | Precedent for exactly the "attachments leave the body" pattern. |

## The correction this forces on our founding premise

`compaction/types.ts:3` describes `compaction/*` events as **"log-only, no surface events"**, and a
separate replacement `user/message` carries the summary while `result.shadowedSeqs` names the hidden
surface nodes.

So DSH's compaction **shadows surface nodes; it does not delete the durable log.** Every claim in
`README.md` and `AGENTS.md` that in-place compaction destroys the raw text is therefore **wrong about the
record** — the text stays in the log. What is actually lost is *model accessibility*: the content is
hidden from the projection and there is no addressable handle the agent can use to get it back.

That is a smaller and more honest claim, and it redefines our value:

> dsh-chapters does not prevent data loss the harness would otherwise cause. It makes compacted content
> **addressable and re-loadable by the model** — topic-named chapter files with stable paths, an index the
> model can consult, and a decision about which oversized tool results are worth carrying — plus branching.

Everything in both docs that says "the raw conversation is gone" must be rewritten to say "the model can no
longer see it." *(Done — README §the two costs and AGENTS.md invariant 1 now phrase it as loss of
accessibility, with the check-2 qualification from Phase 0b.)*

## Revised MVP (much smaller than the approved plan)

1. **`ChaptersCompactionEngine extends BasicCompactionEngine`**, overriding only `summarize()`. Instead of
   returning an LLM summary it returns **deterministic TOC blocks** over chapters written to disk — **zero
   summarization tokens spent**, which also means no `summarizationProvider`/`summarizationModel` config,
   no extra call, no summary-accuracy risk.
2. **Archive module**: `render` (ranges → Markdown + frontmatter), artifact deferral
   (content-addressed, dedup), `budget` check. Mount (corrected by Phase 0b — see "closed" section):
   a **shipped user-root preset** whose compaction group names `dsh-chapters` instead of
   `compaction-basic` (the web profile already ships the host rows `disabled: true`; the live engine
   sits in the agent-preset realm), plus `agents.create({ setup: ctx => agentPresets.mount(ctx, id) })`
   for continuations. The kernel refuses double-provision of `compaction` on one plane at boot.
3. **Registry** (storage domain `dsh_chapters`): chapter records, ranges, hashes, per-session index.
4. **`chapters_fork`** tool for branching/related conversations (Phase 0 already proved the mechanics), plus
   `chapters_segment` if model-assisted ranges prove better than deterministic chunking.
5. **Config**: `thresholdRatio: 0.9`, `retainRatio` tuned so the retained tail plus TOC fits a 32K window
   after the measured ~12K header.

Dropped from the plan: `pressure.ts`, `compact.ts`, custom surface mutation, custom trigger wiring,
`chapters_compact` as our own command (`/compact` already exists via `command-compact`), and the summarizer.

## Phase 0b closed — all five items measured (rounds 12-17)

Full evidence in [spikes/probe/FINDINGS.md § Phase 0b](../spikes/probe/FINDINGS.md). One-liners:

1. **Engine replacement: PROVEN.** Subclass + host-mounted service + `/compact` resolution + the
   automatic `agent/pre-step` path all dispatch into our override, manual and automatic transactions
   commit real durable records, zero provider calls (r12/r13). Double-provision on one plane fails boot
   loudly (`service "compaction" has been registered at <BasicCompactionEngine>`, r14). The live mount
   point is the **preset realm** — the web profile disables host rows and the `standard` preset mounts
   the engine inside an `isolate: { compaction: true }` cordis group; a user-root preset naming our
   package works end-to-end (r17, 6/6). New founding fact: **`agents.create` composes no preset** —
   `meta.agentPreset` is a label; without `setup: agentCtx => agentPresets.mount(agentCtx, id)` a child
   is a tool-less agent (974-token bare head, no `read`), with it the head is the real ~13.3K header
   (27 tools; r16). This lands on invariant 2.
2. **Shadowed content reachability:** no default model path exists (the web profile mounts no session
   query tool; the sqlite index ships `openAt: never`), **but** an opt-in package
   (`dsh-tool-session-query`, five tools incl. `session_event_read` = full unabridged event JSON)
   already ships in rc.2 — mounting it costs five schemas + fixed guidance per request. Differentiation
   survives as *readable topic-named files + zero-token index + forking*; the README wording was
   tightened in the same change.
3. **Prefix-cache sharing — CLOSED by r23:** cross-session sharing is ~one leading block (1,024 of
   13.7K on a cold start with siblings warm; r10/11 stand). In-place compaction across a head-position
   replacement: `cacheReadTokens` HELD (7,424 on both post-compaction turns) while uncached refill
   halved (13,658 → ~7,000, stable) — the header survives replacement, "refill halves" is the honest
   phrase, "fully cached" is not. So the cache story favors the engine as designed: the engine is the
   relief mechanism; `chapters_continue` is for branching and topic resets (it pays one full cold
   ~13.3-15K head).
4. **Pruner × deferral: compose**, given one rule — render chapter bodies from the **durable log**
   following each replacement's `sourceEventSeqs` (the pruner only shadows surface nodes; originals are
   untouched), never from `summarize()`'s input, which already shows `PRUNE_MARKER` truncations.
5. **Vocabulary: pinned** — `src/notice.ts` + `test/notice.test.ts` (kernel-measured rejections
   reproduced; published `MessageSourceMap`/`ContextForm` constants; installed-`.d.ts` drift guard).

### Also true, learned late (fix on contact)

- `summarize()` receives no seqs; the manual path bypasses `compactRegion` dispatch; correlation is
  post-commit via `CompactionResult.shadowedSeqs` / the `compaction/summary` event.
- `compactIfNeeded` no-ops until the session has a durable routed request — the first step can never
  compact (index.ts:260).
- `retainRatio ∈ (0, 1]`; zero-tail tests use `retainTokens: 0`.
- Subclassing inherits `static inject` — extend it or `ctx.agents` throws `cannot get property "agents"
  without inject`.
- Host consumers do `instanceof` against THEIR copy of `ManualCompactionError`; our engine's throws are
  a different class when mounted from a different tree — pair `command-compact` with us in one tree or
  ship our own command (r12 section J observed the raw-throw degradation).

## Verification delta

Landed as `docs/verify.md § Engine-Path Checks` (E1-E6): after automatic compaction, assert (a) the
header prefix stays cached — **E3 still OPEN, never measured on a composed session**; (b) the
durable log length **never decreased** (shadowing, not deletion — r12 proved the host honors this);
(c) a compacted session can still answer a question whose answer lives only in a chapter it chooses to
`read`; (d) the summary call cost is **zero** tokens, since our `summarize()` is deterministic —
proved with the r12 stub (no `usage` field), must re-prove with the real TOC.
