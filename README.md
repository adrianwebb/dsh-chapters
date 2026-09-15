# dsh-chapter-fork

A DeepSeek Harness plugin for **topic-chaptered conversation forking with lossless compaction**.

`dsh-chapter-fork` lets a long conversation fork into a fresh session that carries a compact, cumulative Table of Contents (TOC) instead of the full history. Each topic from the parent conversation becomes a Markdown chapter file in a shared store. The new session's first message is the TOC, with bullets referencing those chapter files. The model can `read` any chapter to reload its full content on demand.

The original session is never modified. This is **forking, not rewriting** — which preserves prompt cache stability on the parent session and makes the operation safe to trigger at any time.

---

## Why This Exists

Long conversations hit context limits. The conventional solution — in-place compaction — replaces a span of the conversation with a summary. This works, but it has two serious costs:

1. **It breaks prompt caching.** Any modification to the prefix of the request invalidates the provider-side cache. On hardware with slow prefill, the resulting cache miss can cost tens of minutes of re-processing for a large context.
2. **It is lossy.** The raw conversation is gone, replaced by a summary. The model cannot recover details it needs later.

`dsh-chapter-fork` takes a different approach. Instead of rewriting the current session, it **forks** a new one. The parent session's prefix is untouched, so its cache stays valid. The forked session starts with a cumulative TOC that indexes chapters stored on disk. Nothing is lost — the full text of every chapter remains available for the model to reload if it chooses.

This design is built for users who:
- Run local models with small context windows (32K–128K)
- Depend on high prompt cache hit rates because prefill is slow
- Want compaction to be lossless and reversible
- Want to branch a conversation across topics without losing the original

---

## The Branch-Head Chain

The core concept is a **chain of branch heads**. Each fork creates a new session that points back to its predecessor through the cumulative TOC and a shared chapter store.

```
Fork 0 (root)          Fork 1                 Fork 2 (current head)
  │                      │                      │
  ├─ chapter 001         ├─ chapter 001         ├─ chapter 001
  ├─ chapter 002         ├─ chapter 002         ├─ chapter 002
  │                      ├─ chapter 003 (new)   ├─ chapter 003
  │                      │                      ├─ chapter 004 (new)
  │                      │                      │
  └─ TOC (1,2)           └─ TOC (1,2,3)         └─ TOC (1,2,3,4)
```

Three properties follow from this model:

- **The current head's context stays bounded.** Ten forks deep, the head still sees only its system prompt, its cumulative TOC, and whatever chapters the model has explicitly reloaded.
- **Every ancestor's cache stays valid.** The parent is never mutated, so continuing an older branch head directly still hits its original cache.
- **The chapter store is append-only.** A chapter written in fork 0 is the same file read in fork 7. Chapters are never copied or rewritten.

---

## How It Works

### The `segment_chapters` tool

The agent calls `segment_chapters` on the current conversation. It returns a proposed list of topic chapters with titles, one-line summaries, and start/end anchors. The agent can edit the proposal.

### The `chapter_fork` tool

The agent (or the user, via a UI button) calls `chapter_fork` with the final chapter list. The tool:

1. **Writes each new chapter** to the shared store:
   ```
   ~/.dsh/chapters/<chain-id>/<NNN>-<title-slug>.md
   ```

2. **Builds the cumulative TOC** by combining the previous session's TOC bullets with the new chapters' bullets.

3. **Creates a forked session** that inherits the parent's system prompt and tool schemas unchanged.

4. **Injects the cumulative TOC** as the forked session's first message:

   ```markdown
   ## Conversation TOC

   This session continues a chain of previous conversations. The following
   chapters contain the full history. Use the `read` tool on any chapter path
   to reload its full content.

   ### Earlier chapters
   - [Chapter: Project Setup](~/.dsh/chapters/chain-abc/001-project-setup.md) — Initial repo scaffolding and dependency choices.
   - [Chapter: Auth Debugging](~/.dsh/chapters/chain-abc/002-auth-debugging.md) — Resolved CORS and token refresh issues.

   ### This fork
   - [Chapter: Database Schema](~/.dsh/chapters/chain-abc/003-database-schema.md) — Designed the user table and migration.
   ```

5. **Returns** the new session ID, chain ID, and the paths of the newly written chapters.

### Reloading a chapter

Because chapters are ordinary Markdown files in DSH file storage, the model can reload any of them at any time using the standard `read` tool. Progressive disclosure: the TOC stays in context, and full chapter content is fetched only when needed.

---

## Architecture

```
dsh-chapter-fork/
├── src/
│   ├── index.ts           # plugin entry (name, inject, apply)
│   ├── chapter-store.ts   # shared chapter store read/write via ctx.fs
│   ├── toc.ts             # cumulative TOC generation
│   ├── segmenter.ts       # topic boundary detection (LLM call)
│   └── fork.ts            # session fork orchestration
├── examples/              # cloned reference repositories
├── cordis.patch.yml
├── package.json
└── tsconfig.json
```

### Design constraint: never modify the prefix

The single most important rule in this codebase: **the plugin must never modify the prefix of an existing session**. No `compactRegion`, no `SurfaceManager.replaceGeneration`, no in-place rewriting. If you find yourself reaching for a span-replacement API, stop — that is the exact operation this plugin exists to avoid.

### Design constraint: fork sessions inherit the header

A forked session inherits the same system prompt and tool schemas as its parent, unchanged. Introducing a header change on fork would invalidate the fork's cache on every subsequent turn. Inherit by default; diverge only on explicit user action.

### Design constraint: the chapter store is append-only

Chapters are never copied, rewritten, or renumbered. Reorganization (splitting oversized chapters) takes effect only at fork boundaries and writes *new* chapters alongside the old ones. This keeps every live session's prefix immutable.

### Trigger model

The **manual** trigger is the MVP. A button in the conversation title bar (or the assistant-message actions slot) lets the user decide when to fork. This is the cache-safe path.

**Automatic** triggering is a later addition. If implemented, it fires **only at turn boundaries, never mid-step**. The safe formulation is: check context pressure when a turn completes. If pressure exceeds the threshold, that is the natural moment to fork before the next turn begins.

---

## Reference Repositories

The following repositories are cloned into `examples/`.

| Repository | Role | When to read |
|---|---|---|
| **`deepseek-harness`** | Official source | Ground truth for core behavior, the plugin contract, the session fork API, and the `ctx.fs` / `ctx.tools` services. |
| **`dsh-plugin-dev-kb`** | Documentation plugin reference | When you need a complete plugin structure that isn't about intercepting agent turns. |
| **`dsh-session-fork`** | Primary fork precedent | Start here for fork orchestration, branch naming, and ancestry tracking. |
| **`dsh-compact`** | Secondary content-gen reference | Only when implementing summarization and the `ctx.llm` call pattern. |

A contributor should start with `dsh-session-fork` for the core fork primitive, consult `deepseek-harness` when a behavior needs authoritative confirmation, and read `dsh-compact` only when implementing the summarization logic.

---

## Planning

The project is scoped in phases so that the cache-critical path is proven before anything is built on top of it.

**Phase 1 — Fork with static chapters (MVP)**
- Register the `chapter_fork` tool
- Write chapters to the shared store via `ctx.fs.writeText`
- Create a forked session with the cumulative TOC as its first message
- Manual trigger only
- No chapter reorganization yet

**Phase 2 — Segmentation assistance**
- Add the `segment_chapters` tool so the agent can propose chapter boundaries
- Keep segmentation within the agent's normal turn

**Phase 3 — Chapter reorganization**
- Split chapters that exceed the configured token target
- Apply splits only at fork boundaries
- Update the TOC to reflect splits going forward

**Phase 4 — UI trigger**
- Add a "Fork with Chapters" button to the conversation title bar
- Wire it to the same `chapter_fork` entry point

**Phase 5 — Automatic trigger**
- Fire at turn boundaries only, never mid-step
- Respect a configurable pressure threshold

Explicitly out of scope: in-place span compaction, any operation that rewrites an existing session's prefix, and any change that alters the header of a forked session.

---

## Development

### Prerequisites

- A working DeepSeek Harness installation
- The four reference repositories cloned into `examples/`

### Installing for development

From the plugin repository root:

```bash
dsh plugin --profile web add "link:$(pwd)"
```

Then restart the Harness web service (`dsh web`) and refresh the page.

> A bundle `add` alone does not activate the plugin. Bundle layers compose at boot, so a restart is required after any change to the plugin bundle.

### Trying it out

Once installed and restarted:

1. Start a conversation in the web UI and have a few exchanges on a couple of different topics.
2. Ask the agent to call `segment_chapters`. Review the proposed chapters.
3. Ask the agent to call `chapter_fork` with the approved list.
4. The UI switches to a new session. Its first message is the cumulative TOC.
5. In the new session, ask the agent to `read` one of the chapter paths. Confirm it can retrieve the full content of the ancestor conversation.

### Verifying a build

1. `dsh plugin --profile web add "link:$(pwd)"` installs without error
2. After restart, `chapter_fork` and `segment_chapters` appear in the agent's tool list
3. A manual `chapter_fork` call writes chapter files and creates a forked session
4. The forked session's first message contains the cumulative TOC with chapter paths
5. The model can `read` a chapter file by its path in the forked session
6. **The parent session's cache hit rate is unaffected** — continue the parent and confirm `usage.cacheReadTokens` on the next step
7. **The forked session builds a stable cache on its second turn** — send a second message in the fork and confirm `usage.cacheReadTokens` is high on that step
8. **A second fork produces a cumulative TOC** — chapters from the first fork still appear under "Earlier chapters"

Steps 6 and 7 are not optional. They are the whole point of the design.

### Removing the plugin

```bash
dsh plugin --profile web remove dsh-chapter-fork
```

---

## Contributing

Contributions are welcome. Before opening a pull request, please review the constraints below — they are not stylistic preferences, they are the reason the plugin exists.

### Hard rules

- **Never modify the prefix of an existing session.** No span replacement, no in-place rewriting. Fork instead.
- **Never change the header of a forked session.** Inherit the parent's system prompt and tool schemas unchanged.
- **Never copy or rewrite an existing chapter.** The chapter store is append-only across the chain.
- **Never reorganize chapters mid-session.** Reorganization takes effect only at fork boundaries.
- **Never fire the automatic trigger mid-step.** Only at turn boundaries.
- **Use `SchemasterySchema<Config>` for configuration.** Plain objects are not accepted by the plugin contract.
- **Call `next()` in waterfall listeners** unless you are deliberately short-circuiting, and document why when you do.
- **Put tunable parameters in config.** If `cordis.yml` can change it, it does not belong in code.

### Reporting a bug

Include the parent session ID, the forked session ID, the chain ID, the chapter paths written, and the `usage.cacheReadTokens` values on the parent session's steps immediately before and after the fork, plus the forked session's first two steps. Cache behavior is the plugin's core promise, and a regression there is the most important class of bug.

---

## License

Apache 2.0
