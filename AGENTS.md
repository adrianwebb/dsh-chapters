This file provides context for an agent building the `dsh-chapter-fork` plugin. The agent has limited context (32K–128K) and must work efficiently. **The architectural constraint is absolute: never modify the prefix of an existing session.** The 98% cache hit rate depends on append-only prefix stability.

## What This Project Is

`dsh-chapter-fork` is a DeepSeek Harness (DSH) plugin that performs **manual, topic-triggered session forking with chaptered compaction**. When a conversation reaches a context pressure threshold (or the user manually triggers it), the plugin:

1. Segments the existing conversation into topic chapters, combining the new chapters with any previous chapters that started the current conversation
2. Writes each new chapter as a Markdown file in a **shared chapter store** for the conversation chain
3. Creates a **new forked session** whose first message is a cumulative Table of Contents (TOC) referencing all chapter files in the chain
4. Preserves the original session untouched

The TOC is **cumulative across the chain**. Each fork's TOC contains the previous fork's TOC bullets plus the newly written chapters. The chapter files themselves are **shared across the chain** — a chapter written in fork 0 is the same file the agent reads in fork 7.

The model can `read` any chapter file to reload its full content. The original session remains available as a branch ancestor. This is **forking, not rewriting** — the cache-hostile operation of replacing a span in the current session is forbidden.

## Why Forking, Not In-Place Compaction

The critical difference from in-place compaction: **a fork creates a new session with a new session log**. The original session's prefix is never mutated. If the original session continues to be used, its cache remains valid. If the fork's session grows, it builds its own cache from scratch — but the cost is paid once at fork time, not repeatedly.

In-place compaction via `SurfaceManager.replaceGeneration` **rebuilds the message derivation cache** and appears as a cache-read drop on the next step. Any prefix modification is catastrophic for hardware with slow prefill.

## The Branch-Head Chain Model

The chain of forks is the fundamental data structure. Each fork is a new **branch head** that points back to its predecessor through the cumulative TOC and the shared chapter store. The agent works against the current head. Older heads are ancestors, reachable by name if needed, but not loaded into context by default.

The TOC is the interface between heads. Its bullets reference chapter files, and those files are the durable record of what each ancestor head decided, learned, or did. Reloading a chapter is conceptually "consulting an ancestor branch."

Because each fork starts fresh, the **current head's context stays bounded** regardless of chain length. Ten forks deep, the current head still sees only its system prompt, its cumulative TOC, and whatever chapters the model has explicitly reloaded.

Because the parent is never mutated, **every ancestor's cache stays valid**. If the agent ever needs to continue an older branch head directly, that session still has its original cache.

## Directory Layout

```
dsh-chapter-fork/
├── src/
│   ├── index.ts           # plugin entry (name, inject, apply)
│   ├── chapter-store.ts   # shared chapter store read/write via ctx.fs
│   ├── toc.ts             # cumulative TOC generation
│   ├── segmenter.ts       # topic boundary detection (LLM call)
│   └── fork.ts            # session fork orchestration
├── examples/              # cloned reference repositories (see below)
├── cordis.patch.yml
├── package.json
└── tsconfig.json
```

## Shared Chapter Store

Chapters are stored in a **single store per conversation chain**, keyed by a chain identifier — not by session. All forks in the chain read from and write to the same store. This is what makes the cumulative TOC work: a chapter written in fork 0 is the identical file read in fork 7.

```
~/.dsh/chapters/<chain-id>/<NNN>-<title-slug>.md
```

The `<chain-id>` is established by the first fork in the chain and inherited by every subsequent fork. The `<NNN>` prefix is derived by scanning the directory, so the scheme is restart-safe and append-only.

**Never copy or rewrite an existing chapter into a new fork's directory.** The store is append-only. New chapters get new numbers. Existing chapters are referenced by their original paths.

## Chapter Reorganization

Chapters that grow beyond a configured token threshold may be split into two or more smaller chapters. Reorganization is **only applied at fork boundaries** — never mid-session. This preserves the immutability of every live session's prefix.

When a chapter is split at fork time:

1. The original chapter file is **left in place** (the store is append-only).
2. New split chapters are written with new numbers.
3. The new fork's TOC reflects the split; the previous fork's TOC still references the original.

This means reorganization takes effect going forward only. It never invalidates anything in a live session.

## Reference Repositories (in examples/)

Clone these into `examples/` before starting. Use the **first** one that answers your question; do not read all of them.

### `deepseek-harness` — Official source

**When to read:** When you need authoritative answers about core code behavior, the plugin contract, the session fork API, the filesystem service (`ctx.fs`), the tool registration API (`ctx.tools.register`), or any "how does the harness actually do X" question.

This is the official source of the DeepSeek Harness. It is the ground truth for all core behavior. When the other references disagree or are ambiguous, this wins.

**Key areas to consult:**
- The plugin loader and contract enforcement
- The session lifecycle and fork primitives
- The `ctx.fs` service implementation (for chapter file writes)
- The `ctx.llm` service (for segmentation calls)
- The compaction seam, to confirm what you are *avoiding*

### `dsh-plugin-dev-kb` — Documentation plugin reference

**When to read:** When you need to understand how a plugin can contribute documentation content, or when you want to see a complete plugin that integrates with the skills/docs ecosystem rather than the agent loop.

This plugin adds documentation to the Harness. It demonstrates:
- How a plugin contributes structured content to the UI
- How plugin-provided documentation is surfaced to the user
- A complete, working plugin structure that is not session- or agent-loop-focused

**Use this when:** You need a reference for the plugin structure that is *not* about intercepting agent turns. It is the cleanest example of "a plugin that adds a feature" without the complexity of session manipulation.

### `dsh-session-fork` — Primary reference for fork orchestration

**When to read:** Before writing any session-level forking logic, branch naming, or ancestry tracking. This is the core architectural precedent.

Key patterns:
- **`fork` as the ancestry primitive** — creates a new session with lineage information
- **Branch operations** give every session a name, ancestry, and index
- **`send_message_by_branch`** enables communication between sessions across branches
- **The main branch stays your dispatcher** — child branches report only compressed context back

**Read this early.** The fork operation you need is a hardened version of DSH's native `fork`, extended with chapter persistence.

**Concrete API to look for:** the specific service method used to create a forked session (e.g. something like `ctx.sessions.fork(...)` or an equivalent). Do not guess — confirm the exact call in this repository or in `deepseek-harness`.

### `dsh-compact` — Secondary reference for chapter content generation

**When to read:** Only when implementing the chapter content generation and summary writing logic.

This plugin shows:
- The `ctx.llm` call pattern for generating structured summaries
- How to hook into context pressure detection
- How a complete compaction plugin is structured in DSH

**Use sparingly.** The fork orchestration is the core work. Chapter content generation is secondary. Read only the summarization and config sections.

## Core Implementation Pattern

### The `chapter_fork` Tool

Register a tool named `chapter_fork` with these parameters:

```
chapter_fork(
  title: string,          // name for the forked session
  chapters: Array<{
    title: string,        // chapter title (used for filename slug)
    summary: string,      // TOC bullet text
    content: string       // the actual chapter Markdown content
  }>
)
```

The tool's `execute` function should:

1. **Resolve the chain ID.** If the current session is the first fork in a chain, generate a new chain ID. If it already has one, inherit it. The chain ID must be available as session metadata.

2. **Write each new chapter** via `ctx.fs.writeText` to:
   ```
   ~/.dsh/chapters/<chain-id>/<NNN>-<title-slug>.md
   ```
   where `NNN` is derived by scanning the directory (restart-safe). Existing chapters are never copied, never rewritten.

3. **Build the cumulative TOC** by combining the previous session's TOC bullets (if any) with the new chapters' bullets.

4. **Create a forked session** using the concrete session fork API from the reference repositories. The new session inherits the parent's system prompt and tool schemas unchanged.

5. **Inject the cumulative TOC** as the first message in the forked session:
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

6. **Return** the fork session ID, chain ID, and the paths of the newly written chapters.

### The `segment_chapters` Tool

Register a separate tool named `segment_chapters` that the agent calls *before* `chapter_fork`. This keeps the segmentation LLM call within the agent's normal turn, which is cache-friendly.

```
segment_chapters(
  // no required parameters; operates on the current session
)
```

Returns:

```
{
  chapters: Array<{
    title: string,        // proposed chapter title
    summary: string,      // one-line bullet text
    startAnchor: string,  // unique text prefix marking chapter start
    endAnchor: string     // unique text prefix marking chapter end
  }>
}
```

The agent reviews the proposal, optionally edits it, and passes the final chapter list to `chapter_fork`. Anchors are advisory — the agent is responsible for the final content of each chapter's `content` field.

### Trigger Contract

The **manual** trigger is the MVP. A button in the conversation title bar (or the assistant-message actions slot) lets the user decide when to fork. This is the cache-safe path — the user pays the fork cost only when they choose to.

**Automatic** triggering is a later addition. If implemented, it must fire **only at turn boundaries, never mid-step**. Forking during an open step would interrupt the user and could invalidate the current turn's cache. The safe formulation is: check context pressure when a turn completes. If pressure exceeds the configured threshold, that is the natural moment to fork before the next turn begins.

Do not hook the automatic trigger into `agent/pre-step`. It will fire mid-turn and break the user's in-progress request.

### Configuration

Config uses `SchemasterySchema`:

```ts
import { z } from '@deepseek-ai/schemastery'

export const Config = z.object({
  forkThresholdRatio: z.number().default(0.75),
  chapterTokenTarget: z.number().default(8000),
  chapterStoreRoot: z.string().default('~/.dsh/chapters'),
})
```

Do not use plain objects. The plugin contract rejects them.

## Efficiency Rules (for Small-Context Agents)

1. **Do not read all four repositories.** Read only the specific file that answers your current question.

2. **Start with `dsh-session-fork`'s fork implementation.** This is the core primitive. Everything else is secondary.

3. **Consult `deepseek-harness` when you need ground truth.** If a community plugin's approach is ambiguous or seems to conflict with the official contract, the official source wins.

4. **Do not implement automatic triggering in the first version.** Manual `chapter_fork` is the MVP. Add automatic triggering only after the manual path works.

5. **Use `ctx.tools.register(defineTool(...))` exactly as shown in the official source.** The `inject = ['tools']` declaration is required.

## Verification

After building, verify:

1. `dsh plugin --profile web add "link:$(pwd)"` installs without error
2. Restart the profile — `chapter_fork` and `segment_chapters` appear in the agent's tool list
3. A manual `chapter_fork` call on a test conversation writes chapter files and creates a forked session
4. The forked session's first message contains the cumulative TOC with chapter paths
5. The model can `read` a chapter file by its path in the forked session
6. **The parent session's cache hit rate is unaffected** — continue the parent and confirm `usage.cacheReadTokens` on the next step
7. **The forked session builds a stable cache on its second turn** — send a second message in the fork and confirm `usage.cacheReadTokens` is high on that step
8. **A second fork from the forked session produces a cumulative TOC** — chapters from the first fork still appear under "Earlier chapters"

## What Not to Do

- **Do not replace spans in the current session.** No `compactRegion`, no `SurfaceManager.replaceGeneration`, no in-place rewriting.
- **Do not modify the system prompt or tool schemas in a forked session.** Inherit the parent's header unchanged.
- **Do not copy or rewrite existing chapters.** The chapter store is append-only across the chain.
- **Do not reorganize chapters mid-session.** Reorganization takes effect only at fork boundaries.
- **Do not hook the automatic trigger into `agent/pre-step`.** Fire only at turn boundaries.
- **Do not use plain objects for config.** Use `SchemasterySchema<Config>`.
- **Do not register a waterfall listener without calling `next()`** unless deliberately short-circuiting.
- **Do not hardcode tunable parameters.** If `cordis.yml` can change it, it belongs in config.

## Install Command Reference

```bash
# Add plugin
dsh plugin --profile web add "link:$(pwd)"

# Restart required after bundle changes
# Stop: Ctrl-C
# Start: dsh web

# Remove plugin
dsh plugin --profile web remove dsh-chapter-fork
```

Bundle layers compose at boot. `add` alone does not activate — a restart is required.

