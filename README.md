# dsh-chapters

**A [DeepSeek Harness](https://www.deepseek.com) plugin for lossless context relief and a shared
project knowledge layer.** Published on npm as [`@treeseed/dsh-chapters`](https://www.npmjs.com/package/@treeseed/dsh-chapters);
source lives at [treeseed-ai/dsh-chapters](https://github.com/treeseed-ai/dsh-chapters).

When a long conversation gets expensive, dsh-chapters archives it as **verbatim Markdown chapters** in
a project store and opens a **new session whose entire content is a Table of Contents** of that
archive. The model reloads any chapter on demand with the ordinary `read` tool. The original
conversation is never rewritten, its prompt cache stays intact, and the index costs **zero model
tokens** — chapters are written from the session log (a file copy), not summarized by an LLM.

Archived knowledge is not stranded per-machine: link the store to a shared upstream — a **git pool**
or a **TreeDX** service — and every linked workspace gets a two-layer derived index, topic
vocabulary, cross-machine search (`chapters_search`), and a per-machine rules ledger.

---

## Purpose — what it fixes, and what it does not claim

The two things that actually hurt on long sessions, especially with local models and slow prefill:

1. **Lossy memory.** A compaction summary drops the exact flag, the line number, the error text —
   and leaves the model no handle to go get them back.
2. **The summarization tax.** Producing a summary prefills the whole history into one auxiliary
   call — minutes of wall-clock on local hardware, *again every time the window fills*.

dsh-chapters removes the summarization step from the critical path entirely. Measured on a
32K-capped model: ~102 tokens of index where the equivalent transcript ran ~2,476, and zero
inference spent producing it.

**Be clear about what this does not buy you:** it is not cheaper caching. The continuation session
pays one cold prefill (system prompt + TOC + handoff note), the same cost class a post-compaction
request pays. What you gain instead is *verbatim* archive (a reload returns real text, not a
paraphrase), an *untouched* parent session that keeps its cache and stays usable, reversibility
(abandon the child, keep working in the parent), and branchable history.

**This is not a fork.** DSH's native fork copies the parent's log into the child; this plugin does
the opposite — it creates an *unseeded* session that cites an archive. The whole design discipline
traces back to that distinction.

## Architecture

```
agent turn ──► chapters_segment ──► chapter ranges (the model picks ranges; never writes bodies)
                                          │
              chapters_continue(title, handoffNote, chapters[])
                                          │
        ┌─────────────────────────────────┼──────────────────────────────┐
        ▼                                 ▼                              ▼
 render bodies from log          defer oversized tool results     preflight the budget
 (verbatim, per range)           to content-addressed             TOC + note vs remainder
 artifacts/ files                        │                                 │
        └─────────────► chapter .md files ◄───────────────────────────────┘
                                          │ refuse loudly if over budget
                                          ▼
      new session seeded with ONE message: the cumulative Table of Contents
```

The four rules the design never breaks:

- **Never rewrite the durable session log.** Append-only; nothing is edited or deleted, ever.
- **Never seed a continuation from the parent's events.** The child starts from one synthetic TOC
  notice; history grows by citation, never by copying.
- **Never contribute to the shared system prompt.** Per-continuation notices only — enabling the
  plugin changes what *your sessions* can do, not what every other session in the profile sees.
- **Never let the model author chapter bodies.** The model chooses ranges; the plugin renders the
  text from the log. Model-typed "lossless" is the failure mode this design exists to avoid.

Supporting machinery, each with a chapter in [docs/architecture.md](docs/architecture.md):

- **Oversized tool results** (file reads, command output) are deferred to a content-addressed
  `artifacts/` store and referenced from the chapter — the model can still pull them back via the
  `chapters_artifact` tool (toc / search / read modes). Hence the honest guarantee: **every byte
  remains retrievable**, not "every byte is in the chapter".
- **Continuation budget, not a handoff cap:** TOC + note must fit a share of the window *remaining
  after the header*; over budget the plugin **refuses with the numbers** — it never clips a handoff
  note.
- **Ancestry is a DAG, flattened for the model:** the child's notice lists every chapter on the
  ancestor path chronologically, with explicit back-links. Reading order is causal order; the model
  never traverses a graph.
- **The compaction seam:** when the `chapters` agent preset is mounted, in-place compaction (manual
  `/compact` and automatic pressure) runs through the plugin's deterministic engine — the same
  log-only, zero-summarization discipline inside a session rather than across sessions.
- **Enrichment (P2)**: after pushes, an idle/deferred ladder annotates archived chapters (topics,
  summaries) — with validation before commit and a body-hash guard making enrichment the *only*
  sanctioned mutation of a chapter file, and even that provenance-chained.
- **Rules (P3)**: a write-once ledger of proposed project rules; approval is a **per-machine
  curation fact** (never a shared-file rewrite), and the active core rules ride verbatim into every
  continuation notice within a budget that refuses rather than clips.

Storage map: chapter bodies and artifacts live **in the workspace** under `.dsh-chapters/<root>/…`
(so the `read` tool reaches them); ancestry, numbering and hashes live in the harness's durable
storage domain (`dsh_chapters`); your upstream credentials live under the **DSH home** with 0600
permissions — never inside the project directory, never committed, never pushed.

## Installation (users)

Node ≥ 24 and a DSH host you install plugins into. From npm:

```
dsh plugin add @treeseed/dsh-chapters
```

(or pin the version: `@treeseed/dsh-chapters@0.1.1`). Restart your `dsh web` afterwards so the
bundle, presets and client plane reload. What activating the plugin does:

- **Registers the model tools** (`chapters_segment`, `chapters_continue`, `chapters_fork`,
  `chapters_search`, `chapters_artifact`, `chapters_rule_propose`) — available to agents.
- **Registers the composer commands** listed below — available to you.
- **Adds a "Fork with chapters" action** to every assistant message in the web UI.
- **Installs the `chapters` agent preset** into your DSH home at boot (`.agent-presets/`;
  write-once — your edits are never clobbered). Pick it in the agent-preset menu to get the
  chapter-form compaction engine; the plugin's own `fallbackPreset` covers children it creates.

Configure it from your profile's plugin entry. The **complete key reference with defaults is the
comment header of the shipped `cordis.patch.yml`** (`node_modules/@treeseed/dsh-chapters/cordis.patch.yml`)
— it mirrors the live config schema, which is enforced. The knobs users reach for most:

| Key | What it governs |
|---|---|
| `harnessId` | this machine's identity in the shared knowledge (author of edits, rule approvals) |
| `knowledgeRemote` | pre-bind an upstream at config time (else `/chapters-link`) |
| `syncDebounceMs` | how quickly archives push upstream (default 30000) |
| `enrichmentEnabled` / `enrichmentModel` | the P2 annotator (off = pure no-op) |
| `vocabApply` | shadow (default) vs git-visible topic-alias curation |
| `coreRulesBudgetTokens` / `rulesCoreBonus` | the rules block in notices and its search bonus |
| `toolResultDeferFloorTokens` | the archive-time inline/defer floor |
| `continuationBudgetRatio` | how much of the remaining window a continuation may add |

## Supported commands

Typed in the composer **inside a session** (a brand-new draft screen sends text as a message, not a
command — start the session first). Every command answers with honest numbers; nothing degrades
silently.

| Command | Meaning |
|---|---|
| `/chapters-link` | show the current upstream and mirror state |
| `/chapters-link <local-path>` | bind a shared local git repo (bare or worktree) — needs no credentials |
| `/chapters-link <https-url> <token>` | bind a networked git pool over smart-HTTP; token stored 0600 under the DSH home |
| `/chapters-link treedx+<url>/<repo> <token>` | bind a TreeDX service (token required — it is a bearer API) |
| `/chapters-status` | last sync with its steps: cloned / published n new / index / pushed, or the local-only reason |
| `/chapters-enrich run` \| `model <provider/model \| clear>` \| `report` | drive the enrichment ladder and choose its model (default: the conversation route) |
| `/chapters-rule add <category> <text>` \| `list [--all \| --proposed \| --category <c>]` \| `approve <id>` \| `revoke <id>` | the rules ledger; approve/revoke are per-machine facts |
| `/compact` (host command) | with the `chapters` preset mounted, this routes through the deterministic chapter engine |

The agent-side tools you'll see in transcripts: **`chapters_segment`** (propose archive ranges),
**`chapters_continue`** (open the TOC-seeded continuation), **`chapters_fork`** (same machinery,
mid-conversation branch), **`chapters_search`** (query the shared index), **`chapters_artifact`**
(retrieve deferred tool results), **`chapters_rule_propose`** (submit a rule candidate). The
**Fork with chapters** button on an assistant message performs the archive-and-continue in one
click and switches the UI to the new session.

## Backend providers

Transport is a **provider seam** (design record: [docs/knowledge-repo.md](docs/knowledge-repo.md) §15;
contract: [docs/provider.md](docs/provider.md)): six verbs — clone/pull/push/commit/list/fetch — and
two shipped backends. Search, rules and the index all read the materialized **mirror**; they are
identical under either provider.

|  | **`git` (default)** | **`treedx`** |
|---|---|---|
| Address form | `https://…/pool.git` (+ token) or a local path | `treedx+<url>/<repo>` (+ bearer token) |
| Transport | git smart-HTTP via isomorphic-git; plain repositories, browsable with any git client | TreeDX service API: workspace → overlay writes → commit, lease-managed |
| Credentials | per-project token in the DSH home (0600); local paths need none | bearer token, same home treatment |
| Contention | push rejected → ff-pull retry → divergence routes through **rebuild-from-the-store** | lease contention maps onto the same rejected→pull→diverged ladder |
| Mirror memory | cloned mirror directory under the workspace store | `.treedx-state.json` remembers the served head |
| Layout on the wire | identical: `chapters/`, `artifacts/`, `rules/`, derived `index/`, `collections/`, `topics/vocabulary.json` | identical (the service stores the same tree) |

Shared honesty rules both backends implement (measured, pinned by tests): every sync-path failure
**degrades to `local-only` with the reason**, never a silent loss — the mirror stays current and the
push lands when the remote returns; an unreachable-vs-auth-rejected distinction survives into the
status; divergence resolves by rebuilding from the store (the store is the truth, transport is
expendable); corpus listings page to the end. `kind` defaults to `git` for every record written
before providers existed — upgrading is zero migration.

## Development process

Everything runs from a clone with plain **npm** (this is a single package, not a monorepo):

```
npm ci
npm run typecheck && npm run build
npm test                      # unit + integration
npm run coverage:ci           # c8 gate: ≥85% statements/branches/functions/lines
```

The browser acceptance suite runs against **model tapes** — recorded LLM exchanges replayed by a
local proxy, so it needs no model, no key and no GPU, and passes or fails *loudly* on a miss:

```
npm ci --prefix dev/dsh-host-lock           # the pinned, hermetic DSH host for e2e boots
export PATH="$PWD/dev/dsh-host-lock/node_modules/.bin:$PATH"
npm run test:e2e:replay                     # all seven segments, ~6 min
bash scripts/bootstrap-dev-profile.sh --home .dshdev-local   # scratch dev home, built via npm
```

Tapes live in `tests/fixtures/model-tape/<project>/`; `E2E_MODEL=record` distills them against a
local llama.cpp endpoint (dev-only — CI never touches the model). When **product prompts change**
(persona, tool descriptions, notice text, thresholds) re-record the affected projects; documentation
edits are free. Agent-facing rules (the four invariants, the tape discipline, the coverage ledgers)
live in [AGENTS.md](AGENTS.md); the workflow loop in [docs/development.md](docs/development.md);
verification checklists in [docs/verify.md](docs/verify.md). Hosted CI
(`.github/workflows/ci.yml`) runs the gate plus the full tape-replay chain on every push;
releases publish automatically from a bare-semver tag via **npm trusted publishing (OIDC)** with
provenance attestations — no deploy secrets.

## Contributing

- **Start with an issue** for anything that changes behavior; the design record in
  `docs/knowledge-repo.md` explains *why* things are shaped as they are, and amendments are human
  decisions recorded in git.
- **Keep the four invariants inviolable** (never rewrite the log; never seed from the parent's
  events; never touch the shared system prompt; never let the model author bodies). A PR that
  trades one of these for convenience will be closed, not merged.
- **CI defines "done"**: deterministic suite green, coverage gate green, and — if your change moves
  a model-visible prompt — the tape-replay chain re-recorded and green. Refuse-with-numbers beats
  silent fallback everywhere in this codebase; follow that doctrine in new code too.
- **Test what you touch, and say how**: measured claims (this README's numbers are measured),
  cited failure modes, no speculative generality.
- **Never commit credentials** or machine paths into fixtures; tokens belong to the DSH home only.
- Releases are maintainer-driven: bump `version`, land to `main`, push the tag — CI publishes.

License: see [LICENSE](LICENSE) (Copyright 2026 Fractal Synapse Labs).

> **On the name.** The package ships as `@treeseed/dsh-chapters` (npm scope `treeseed`; the GitHub
> org is `treeseed-ai`). Earlier candidates — `dsh-chapter-fork`, anything with "compact" — were
> rejected because they claimed something false: in DSH, *fork* means copying the parent's history,
> the one operation this plugin must never perform. The name names the artifact instead. Reasoning:
> [docs/architecture.md § Naming](docs/architecture.md#naming).
