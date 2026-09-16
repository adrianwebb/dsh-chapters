# DSH Plugin Contract

Verified against `examples/deepseek-harness` and the reference plugins. Every claim here cites a file
so it can be re-checked after an upgrade. **Nothing in this file is inferred.**

## Three Schema Systems

Conflating these is the top time-waster in this project.

| Declaring | Format | Import |
|---|---|---|
| Plugin `Config` | `Schema.object({...})` | `import Schema from '@deepseek-ai/schemastery'` — **default** |
| Tool `parameters` | plain declarative spec (`ParameterSchemaSpec`) | none; `defineTool` from `@deepseek-ai/dsh-tools` |
| Storage-domain records | zod | `import { z } from 'zod'` |

Plain objects are *required* for tool parameters and *rejected* for plugin config.

`import { z } from '@deepseek-ai/schemastery'` **does not exist** — 0 occurrences upstream versus 128
default imports. Copying the named form fails to build.

## Config

Shape copied from `examples/dsh-compact/src/index.ts:15,26-37`.

```ts
import Schema from '@deepseek-ai/schemastery'

export interface Config {
  continuationBudgetRatio: number
  chapterTokenTarget: number
  toolResultDeferFloorTokens: number
  artifactStoreRoot: string
  tocBulletBudgetTokens: number
  pressureSuggestionRatio: number
}

export const Config: Schema<Config> = Schema.object({
  continuationBudgetRatio: Schema.number().default(0.25),      // of the window REMAINING after the header
  chapterTokenTarget: Schema.number().default(8000),
  toolResultDeferFloorTokens: Schema.number().default(200),    // a floor, not the policy — see below
  artifactStoreRoot: Schema.string().default('.dsh-chapters'),
  tocBulletBudgetTokens: Schema.number().default(2000),
  pressureSuggestionRatio: Schema.number().default(0.75),
})
```

Three notes on these defaults, so nobody trusts them as settled:

- `continuationBudgetRatio` is a share of **(window − system prompt tokens)**, never of the whole window.
  See `docs/architecture.md § Budgets`. Measure the header once per process generation and cache it.
- `toolResultDeferFloorTokens` is **a floor, not the policy.** The keep/defer decision belongs to the model
  (`toolResultOverrides` below); the floor exists only so trivial results stay inline without being
  itemized, keeping the chapter's narrative readable and the exception list sparse. The number is a guess
  to calibrate in Phase 1 — too high and meaningful short outputs get deferred, too low and chapters bloat.
- There is deliberately **no maximum.** Deferral is a judgement with a size floor; over-sized output is
  caught by the continuation budget and by the chapter split signal, both of which refuse or report rather
  than silently clip.

Note `forkThresholdRatio` from earlier drafts is renamed to `pressureSuggestionRatio`: with the reordered
plan it gates a *suggestion*, not an action.

## Entry Point

```ts
export const name = 'dsh-chapters'          // must match package.json and cordis.patch.yml
export const inject = [/* service names */]
export const Config: Schema<Config> = …
export function apply(ctx: Context, config: Config) { … }
```

## Services (`inject`)

`dsh-session-fork/src/index.ts:161` shows the full menu: `commands`, `storageDomain`, `sessions`,
`sessionPersistence`, `sessionQuery`, `agents`, `tokenMeter`, `llm`, `sessionController`, `connection`,
`tools`, `systemPrompt`.

Ours, minimal and honest:

```ts
export const inject = [
  'sessions', 'sessionPersistence', 'sessionQuery', 'storageDomain',
  'agents', 'tokenMeter', 'llm', 'tools',
]
```

- `agents` — `ctx.agents.create`, the continuation primitive. **The load-bearing one.**
- `storageDomain` — chain registry.
- `sessionQuery` — `observeSession` for the calling agent's own log and preset projection.
- `tokenMeter` — pressure math and the continuation budget preflight.
- **`systemPrompt` is excluded on purpose** (invariant 3).
- Add `commands` at the UI/CLI trigger phase; `connection` / `sessionController` only if a create path
  turns out to need the client RPC round-trip.

Declare only what you use — `dsh-compact` gets by on `inject = ["commands"]`.

## Tools

`defineTool` at `packages/core/tools/src/schema.ts:545`:
`defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(...)`.

**`output` is mandatory** on every `ToolDefinition` — the `O` — and needs `{ schema, render }`. Idiom
from `dsh-session-fork/src/tools.ts:110-121`:

```ts
function jsonOutput<T>(schema: ValueSchemaSpec) {
  return { schema, render: (_args: unknown, value: T) => [{ type: 'text', text: JSON.stringify(value) }] }
}
```

Definitions (names pending the rename decision — see `docs/architecture.md § Naming`):

```ts
const chaptersContinue = defineTool({
  name: 'chapters_continue',
  description:
    'Archive this conversation as Markdown chapters and open a new session that starts from their '
    + 'table of contents. This session is left untouched. Supply event ranges, not text.',
  parameters: {
    title:       { type: 'string', required: true, description: 'Name for the continued session.' },
    handoffNote: { type: 'string', required: true, description: 'State of play: what was in progress, decisions held, next step. As long as it needs to be — it is budget-checked, not truncated.' },
    chapters: {
      type: 'array', required: true,
      description: 'Ranges ascending by startSeq, non-overlapping, all <= archiveCeiling, covering every event below the ceiling.',
    },
  },
  output: jsonOutput(CHAPTERS_CONTINUE_RESULT),
  async execute(args, exec) {
    // caller agent from `exec`; refuse cleanly when absent
  },
})
```

Register host-side: `ctx.tools.register(tool)`. Call-site precedent:
`dsh-session-fork/src/index.ts:786`.

## LLM Calls

Segmentation and summaries go through **`ctx.llm.stream()`** — the concrete method, not `ctx.llm`
generically. Window sizes via `ctx.llm.resolveModelInfo(provider, model, signal)`.

The cache-friendly pattern — a stream call reusing the conversation's own system prompt as its prefix —
is at `packages/compaction/compaction-basic/src/index.ts:225,290`. Copy that for segmentation so the
pass is served from cache.

## Session Creation

**Never** `ctx.sessions.fork(...)`. *(Corrected by Phase 0 measurement — an earlier draft of this file
claimed the method was client-only. It is not.)* `ctx.sessions` does expose `fork`, `_forkSeed` and
`_resolveForkSource` host-side; calling `fork` from a plugin is refused:

> `session fork is owned by session-controller; ambient plugin access is denied`

So the prohibition holds for a better reason than we stated: the copy-the-log path is capability-gated
away from plugins, and the kernel handler seeds with
`commands.ts:260` → `seed: source.events.slice(0, cut)` (invariant 2). Do not go looking for a way
through the gate — `agents.create` is the sanctioned seam.

Ours — `seed` is optional per `packages/core/agent/src/index.ts:95`
(`readonly seed?: readonly SessionEvent[]`), and upstream callers already do
`ctx.agents.create({ sessionId })` with no seed:

```ts
ctx.agents.create({ sessionId: newId, seed: [tocNoticeEvent], meta: { cwd: parentCwd } })
// then attach to the parent's workspace
```

Carry over from `dsh-session-fork`: workspace attach and preset composition
(`src/vendor/fork.ts`: `forkWorkspace`, `composeAgent`, `readSessionState`). `branch.ts:10-14` warns that
kernel `SessionStore.fork` yields fiber-scoped sessions which are evicted and broadcast
`session-removed`, vanishing from the sidebar — `agents.create` is the only durable, listed, resumable
route. **Whether that holds for an empty seed is the Phase 0 spike.**

Keep `anchoredBoundaryOf` (`vendor/fork.ts:213`) with its role changed: it yields the **archive ceiling**
(`boundarySeq`, `cut`) for *what to render*, never for seeding.

Notice event shape — reuse `forkSeedNoticeEvent` construction (`src/branch.ts:154`): one
`user/message`, `surfaceOp: 'append'`, at `seq = 0` for us (`cut` for them). Continuity validation in
`Session.create` requires the seq to be the next contiguous seed position.

## Lineage: Kernel Fields We Must Not Lean On

`SessionHeader` (`packages/core/session/src/types.ts:93-122`) carries `version`, `id`, `createdAt`,
`cwd`, `parentSession`, `isSeeded`, `origin`, `delegationDepth` — and **no system prompt or tool
schemas**.

- `isSeeded` means "contains a fork-inherited event prefix"; our one-event synthetic seed is not that.
- `parentSession` is documented as *seed lineage*. Setting it to fake a relationship would be a misuse.
- Therefore **our storage-domain registry is the sole authority on ancestry**, and the web UI's branch
  graph will show our child as an unrelated root. A chain/manifest view is this plugin's job.
- The header being composed per request from the preset plus plugin contributions is *why* invariant 3
  holds, and why cache validity is per-process-generation: a restart or config edit recomposes it for
  everyone.

## Storage Domain Registry

Precedent verbatim: `examples/dsh-session-fork/src/store.ts:36-43`.

```ts
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

const chapterRecord = z.object({
  id: z.string(),                     // `${authorSession}/${n}`
  authorSession: z.string(),          // keying by creator, not by a linear chain
  path: z.string(),
  startSeq: z.number().int().nonnegative(),
  endSeq: z.number().int().nonnegative(),
  sha256: z.string(),                 // integrity: verified before citing
  tokens: z.number().int().nonnegative(),
  summary: z.string(),
  createdAt: z.string(),
})

const sessionState = z.object({
  parentSession: z.string().nullable(),
  rootSession: z.string(),
  nextChapterNumber: z.number().int().nonnegative(),
  chapters: z.array(chapterRecord),
})

export const chapterDomainSpec = defineDomain({
  name: 'dsh_chapters',
  version: 0,
  tables: { sessions: domainTable<string, SessionState>(sessionState) },
})
```

Open with `ctx.storageDomain.open(spec)` → `table(name).get/put/entries/size`. `put` reaches backend
durability before resolving, so a resolved save survives restart. Backend is JSON under
`~/.dsh/storages`.

## Chapter File Format: Markdown + Frontmatter, Not XML

Decision with reasoning in `docs/architecture.md § File Format`. Short form: `.md` with YAML frontmatter.

```markdown
---
chapter: "003-database-schema"
title: "Database Schema"
session: 01HTZ6Q8K3
root: 01HTAB12CD7
seqRange: [184, 231]
sha256: 6d59…
tokens: 7420
generatedAt: 2026-09-15T17:22:04Z
artifacts: 2
---

# Database Schema

**User:** Let's design the user table…
```

Frontmatter carries every machine-queriable fact a parser would want. The body stays token-dense prose.
The `read` tool returns both; the harness's own skill loader uses this same frontmatter-plus-body idiom,
so it is an established convention here. **Do not convert chapters to XML** — see
`docs/architecture.md § File Format` for the full rationale and the one case that would reopen it.

## Packaging

`cordis.patch.yml` is required for the bundle to mount — a one-entry list that `insert`s the package by
name (compare `examples/dsh-session-fork/cordis.patch.yml`). Its `name` must match `package.json`. In
`package.json` the patch appears in **three** places:

```jsonc
"main": "lib/index.js",
"exports": { ".": {…}, "./cordis.patch.yml": "./cordis.patch.yml", "./package.json": "./package.json" },
"files": ["lib", "cordis.patch.yml"],
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

Entry `apply(ctx, config)`. Build with `tsc -p tsconfig.json` and **build before installing**. A client
UI (later phase) additionally needs `dsh.client` and a `tsdown.client.config.ts` — see
`dsh-session-fork/package.json` for the shape.

## Trigger Constraints

- Manual is MVP. The button path cannot supply model-authored titles or ranges, so segmentation must be
  a plain function callable **without an agent turn** — build that seam in Phase 1, not Phase 5, or the
  UI and automatic paths both force a rewrite.
- Automatic fires **only at `turn/end`**. Never `agent/pre-step`: it fires mid-turn and breaks the user's
  in-flight request. Note the wrinkle to design around — at a `turn/end` there is no agent turn in which
  to call the segment tool, so the automatic path runs segmentation itself.
- The archive ceiling is a completed `turn/end` by construction, so mid-turn cut points are not merely
  unsafe, they are not representable.
