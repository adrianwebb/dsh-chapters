# Knowledge Repository Design Record

The governing design for the **git-based shared knowledge pool**: multiple DSH harness instances,
on multiple machines, feeding and searching one private per-project repository of past
conversations — chapters, artifacts, a topic index, and rules — while keeping every individual
session's context small. Written to *govern*: implementation plans derive from this file, and
amendments are human decisions recorded in git history (see **Amendments** below).

Status: **agreed 2026-09-17, pre-implementation.** Phased build in §13.

## 0. What this is, and what it is not

**What it is:** the plugin's existing artifacts (chapters, deferred tool results, the TOC
continuation mechanic) become the contents of a private git repository per project, synced across
every harness the user connects to it. Compaction and forking remain the *knowledge generators*;
the repo is the *transport and the shared corpus*. Agents gain one new capability: search and
load of past work across their own and other machines' sessions, plus a bounded set of
human-approved rules to live by.

**What it is not:**

- Not a general vector store or embedding search. Scoring is deterministic and inspectable (§8).
- Not a system-prompt injection channel. Rules enter context only through the continuation
  notice (§7) — per-continuation, budgeted, append-only — never as a contributed header section
  (invariant 3, `AGENTS.md`).
- Not a rewrite of what shipped. The MVP loop (engine, registry, TOC continuation, fork button)
  is the foundation this record extends; §1 lists the invariants that must survive the extension.
- Not real-time collaboration. Sync points are deliberate (§5); the repo is a pool, not a shared
  live document.

## 1. Invariants the extension must not erode

Carried from `AGENTS.md` and this project's measured history, restated because the knowledge
layer tempts each one:

1. **The compaction/fork critical path stays zero-model-token.** Model enrichment is strictly
   post-archive, async, optional (§6). A fork must remain instant even when the model is down,
   busy, or slow — the deterministic path is the product; enrichment is garnish.
2. **Refuse with numbers, never truncate.** Applies to the rules core set rendered into the
   notice (§7) and to search output packing (§8): over budget → refuse/explain with the
   measured numbers, or the user curates; silent clipping is banned.
3. **The local store is append-only.** Chapters are never renumbered, rewritten, or
   re-chaptered after archive. Composition must be right at archive time (§4); enrichment can
   relabel, never re-chapter.
4. **Model proposes, plugin commits — extended.** The model proposes topics, summaries, and
   rule text. The plugin owns the canonical vocabulary, the index, and rule status (§6, §7).
   The model never writes to the repo directly; the plugin is the only writer.
5. **Per-machine write namespaces.** Two machines never write the same file. Zero merge
   conflicts by construction, not by hope (§3.3).
6. **Budget the added context, never the corpus.** Continuation notices stay O(1) in corpus
   size (§7.3). The corpus grows without bound; the head it pays does not.
7. **Verbatim stays verbatim** except the redaction carve-out (§9) — and the carve-out is
   credentials-only, marked, and deterministic.

## 2. The knowledge repository

### 2.1 One private repo per project, user-created

The user creates a private git repository per project and registers it with
`/chapters-link` (three modes, live): **no args** shows the upstream + mirror state,
**a local path** binds a directory upstream, **a URL + token** binds a network upstream.
Profile config (`knowledgeRemote`) supplies the same URL as a lazy default; it never
creates anything by itself. A personal cross-project repo is the *user's* choice of an
additional project entry, not a built-in mode.

Per-harness credentials are **scoped, revocable tokens limited to that repository** —
deliberately better than SSH deploy keys: revocable, per-repo, no shell access.
**Credentials are mandatory for network upstreams** (loopback exempt, so local test
forges work) and **never needed for local-path upstreams**. Storage is under the DSH
home — `<DSH_HOME>/dsh-chapters/credentials/<projectKey>`, 0600 — never the project
tree: the workspace is the agent's reading room and only the plugin touches the token
(a same-uid hygiene boundary, not a cryptographic one; the hard guarantee is that no
code path ever echoes it into a context).

Why per-project: natural secret boundary (§9), natural permission boundary, and the
`projectKey` (§2.3) is what keeps a small model's session from wading into a foreign corpus by
accident.

### 2.2 Repository layout

```
<knowledge-repo>/
  project.yml                  # projectKey, slug, created-by, created-at  (plugin-maintained)
  chapters/
    <projectKey>/
      <sessionId>/
        <chapter-file>.md      # frontmatter + verbatim body (today's format, §2.4)
  artifacts/
    <projectKey>/
      <sha256-prefix>/<sha256> # deferred tool results, content-addressed (today's format)
  collections/
    <projectKey>/
      <sessionId>.jsonl        # per-turn signatures, one line per completed turn (§4.1)
  index/                       # LAYER 2 — derived, plugin-built, do not hand-edit (§10.2)
    <topic-shard>.md           # one shard per canonical topic, alphabetical
    manifest.json              # build manifest: file hash → last processed state (§10.2)
  edits/
    <harness-id>/
      curation.jsonl           # LAYER 1 — per-machine editable index facts (§10.1)
  rules/
    <projectKey>/
      <rule-file>.md           # rules-as-chapters: kind: rule (§7)
  topics/
    vocabulary.json            # plugin-owned canonical vocabulary + aliases (§6.3)
```

Machine-specific and derived state lives in machine-namespaced or manifest-tracked files (§10);
human-meaningful content (chapters, rules, vocabulary) is globally readable and git-diffable so
the user can see what any harness decided and revert it.

### 2.3 `projectKey`: UUIDv5 over the normalized remote

The key must be **identical on every machine** for the same project — that is the whole point,
since local paths differ (`/Users/adrian/repo` vs `/home/adrian/Projects/repo`).

Canonicalization, exact:

1. Take the project's git remote URL (`origin`, first if several).
2. Lowercase.
3. Normalize form: strip `https://` and `ssh://` schemes; convert `git@host:org/repo` →
   `host/org/repo`; strip trailing `/` and `.git`.
4. **Keep the host.** Two hosts, same path = different projects.
5. `projectKey = UUIDv5(NAMESPACE_OID, canonical-string)` — standards-based, deterministic,
   name-derived; the same canonical string always yields the same key, anywhere.

Fallbacks, all recorded in `project.yml` and the notice so they are visible:

- **Non-git workspace:** UUIDv5 over the absolute path, flagged `path-derived` (unstable across
  machines — the notice says so).
- **User override:** a `projectKey:` line in config wins, for monorepo subdirectories and
  multi-remote situations.

### 2.4 Chapter frontmatter (extended)

Today's frontmatter (title, summary, ranges, sha, …) gains:

```yaml
projectKey: 1c3f…          # §2.3 — every chapter carries its project
kind: chapter              # chapter | rule (§7)
harnessId: adrian-mbp      # writing machine, human-readable
topics: [auth, middleware] # deterministic signature topics at archive time (§4);
                           # model-enrichment may later add semantic topics
generated:                 # provenance per field class (user-confirmed, §6)
  title:   {by: deterministic}
  summary: {by: model, model: qwen3.8-flash-next, at: 2026-09-17T…}   # or {by: deterministic}
  topics:  {by: deterministic}
```

Provenance is load-bearing: it is what makes the emergent vocabulary auditable and enrichment
re-runnable (§6).

## 3. Storage vs transport

### 3.1 The store stays in the workspace; the clone is a mirror

Chapters must remain reachable by the existing `read` tool — a property proven load-bearing in
the r22 read-back test, and one the agent sandbox may gate for outside-workspace paths.
Therefore:

- **Storage** stays exactly where it is: `.dsh-chapters/<rootSessionId>/…` in the workspace.
- **Transport** is a git clone in the same workspace: `.dsh-knowledge/` (hidden; the plugin
  writes/updates a gitignore hint in the project on first sync so the project's own repo
  ignores it).
- Sync = copy-out (store → clone, commit, push) and copy-in (clone → store, new files only).
  The clone is *transport*, never the read path's source of truth for the live session.

Failure domains stay separate: a broken remote never breaks compaction/fork (sync is
best-effort, §5.3), and a broken clone never corrupts the store.

### 3.2 Git client: pure-JS SDK, not the executable

**Decision (user-directed):** no dependency on a `git` binary. A pure-JS client
(isomorphic-git-class) over **HTTPS** — which is what makes the scoped-token credential model
of §2.1 possible. Logged risks: pure-JS fetch/push is slower than native git (mitigation: the
knowledge repo is small relative to source repos; lazy-clone on first use); the repo grows a
dependency to own. Fallback, config-gated and documented: the CLI, for hosts where the SDK
chokes. SSH-only remotes are a known gap in this decision (HTTPS tokens are the supported path).

**Local-path upstreams bypass HTTP entirely** (`/chapters-link <path>`, added with the
P1 close-out): the pool is a directory (bare repo created on first sync if absent) and
transfer is isomorphic-git's own pack layer — `packObjects` fed an **explicitly computed
reachability closure** (commits → trees → blobs; packObjects packs exactly what it is
given, measured) written straight into the target's `objects/pack/` and `indexPack`ed,
then refs moved under the same ff-only rule. Zero network, zero credentials, still zero
git-binary. Two machines converging through one shared path — including a real fork
resolved by mirror rebuild — is covered by `tests/integration/sync-local-upstream.test.ts`.

### 3.3 The no-conflict rule

Two machines never write the same file:

- `chapters/`, `artifacts/`, `collections/` are partitioned by **sessionId** (UUID — collision-free)
  under the project key; a session belongs to exactly one machine.
- `edits/<harness-id>/` is partitioned by **harness id** — one writer per file, ever.
- `index/`, `topics/vocabulary.json`, `project.yml` are **plugin-derived, single-consumer
  writes**: built by the syncing machine from append-only inputs. If a pull ever finds a
  divergent derived file, the plugin **rebuilds it locally and commits the rebuild** — never
  merge-resolves it (§10.2). Merge conflicts are structurally impossible for content and
  structurally repaired for derived state.

## 4. Chapter composition: topic-sequential, deterministic

The user requirement: **consecutive message collections that reference the same task merge into
one chapter; a chapter splits only when the task changes or the chapter outgrows a configured
limit.** This replaces size-only splitting as the primary axis and is the load-bearing new
algorithm of the whole record.

### 4.1 Collection and signature

- **Collection = one completed turn**: the user message(s) of the turn, its assistant
  messages, and its `turn/end`. (The "user + first + last assistant" slice is the *enrichment
  input*, §6.1; composition works on the whole collection.)
- **At `turn/end`, synchronously** (millisecond-scale, no queue), the plugin extracts the
  collection's **deterministic signature** and appends one line to
  `collections/<projectKey>/<sessionId>.jsonl`:

```json
{"seqs":[41,42,43,44,45],"paths":["src/auth/middleware.ts","src/auth/token.ts"],
 "commands":["npm test","git diff"],"terms":["auth","refresh","jwt","middleware"],
 "size":1830,"by":"deterministic","at":"2026-09-17T…"}
```

  - `paths`: file paths mentioned in tool calls/results (highest-signal source in coding
    sessions).
  - `commands`: command/argv tokens, normalized.
  - `terms`: stopword-filtered keyword frequency, top-N.
  - `size`: estimated tokens (cross-machine heuristic — fine for composition, not for
    display; the TOC shows message counts, not tokens, §7.3, because tokenization is not
    comparable across models).

  Because the signature is computed *when the turn completes*, **no compaction or fork ever
  needs unprocessed material**: every completed collection is already signed, and an
  unfinished collection (the in-flight turn) is never in scope — the host compacts at
  `agent/pre-step` only, never mid-step (measured r13/r17), and its retained tail always
  contains the current turn. This is the answer to "compaction can happen at any step."

### 4.2 Composition (at archive time)

When a compaction or fork archives a span of completed collections, chapters are composed by a
**greedy sequential merge**, deterministic and O(collections in span):

1. Open chapter 1 at collection 1; accumulate its running signature (union, with
   per-collection weighting).
2. For each next collection: **merge** if
   `overlap(collection, running) ≥ τ` **or** `primaryMatch(collection, running)` — **and**
   `chapterSize < chapterLimit` — otherwise **close the chapter and open a new one**
   at this collection.
3. `overlap` is a normalized term overlap: shared paths (heavy weight — same file is
   near-probably same task), shared command families, shared terms, over the union.
   `τ` (merge threshold) and `chapterLimit` are config (§12), both in the same
   "no hardcoded tunables" register as `chapterTokenTarget`.
4. `primaryMatch`: the first path of either running member (`paths[0]` — the file a
   turn is *about*, by causal order of touch) names the same file as the incoming
   collection's primary, with a spelling tolerance (`src/render` = `src/render.ts`).
   **Amendment r28 (2026-09-18, measured live):** the first real topic test — five
   research turns on this repo — showed overlap ALONE never reaches τ for legitimate
   same-topic pairs: real turns touch 5–6 files, one shared path dilutes in a union
   of ~10 (measured 0.077 vs τ 0.3), while cross-topic pairs score 0.0–0.02. The
   intent of rule 3's "same file is near-probably same task" is thus carried
   explicitly: a shared primary is a first-class merge signal, not a diluted weight.
   τ and the size cap are unchanged; every decision still logs the rule that fired.

Boundary, measured live (r29/r36): the host's pressure selection ends at
tool-pair balance points, blind to turn boundaries — shallow repairs slice
collections, and the completeness guard then correctly falls back to legacy
single-chapter fragments. Topic-sequential composition therefore governs the
turn-aligned archive moments (fork/continue, where the span is anchored at a
`turn/end`); the engine wiring (r29) is the opportunistic upgrade for deep
selections (first breach of a heavily-over window), never a fragment
regression. If engine-path merges ever need to be reliable under steady
pressure, the fix is cross-chapter collection stitching in the index (P2),
not selection tuning.

Honest quality bar: strong for coding sessions (files and commands leave loud signatures),
degrading to time/size splitting for pure-prose conversations — never worse than today's
behavior, never blocking.

### 4.3 The completeness guard

Chapters include **only collections with a `turn/end`** inside the span. If a compaction
boundary ever lands mid-collection (the manual-`/compact` edge case — the automatic path
cannot produce one, §4.1), the composition clamps to the last completed collection and the
TOC notes the clamp. The unfinished collection stays in the live context, per the user
requirement, and composes at the next archive.

### 4.4 Consequence: composition is archive-time-only

Because chapters are append-only (invariant 3), the merge threshold must be right *when the
archive happens*. The per-collection signature is stored with provenance (§4.1) precisely so
any merge or split is **inspectable after the fact** — and so `τ` can be tuned for future
archives without pretending to rewrite old ones. Enrichment (§6) may later *relabel* a
chapter's topics but may never re-chapter it.

## 5. The sync loop

### 5.1 Points

| Event | Action |
|---|---|
| New chapters-preset session created | **pull** (fresh corpus before the first turn; §5.2 ordering) |
| Fork (button or command) | **pull → compose/archive → push** |
| Compaction finalization | **push** (debounced — see 5.2) |
| Idle (debounce expired after the last archive) | **push** |
| Pull failure / push failure | log, surface via `/chapters-status`, **never fail the archive** |
| `/chapters-link <path>` | binds a directory upstream (bare repo materialized on first sync); no credentials |

Compaction and fork are simultaneously push points *and* the right refresh points — the loop
is pull → archive new span → push, so a fork point always sees a current index.

### 5.2 Ordering and serialization

- A **per-repo writer lock** serializes (a) store transactions (reserve → write → commit) and
  (b) clone operations. A pull never lands mid-archive-write and a push never ships a
  half-committed store.
- Push = `copy-out → commit → fetch → if diverged: rebase-apply (append-only ⇒ fast-forward
  safe) → push`, with bounded retry. All git calls run with no TTY prompt (
  `GIT_TERMINAL_PROMPT=0` equivalent in the SDK), hard timeouts, and network treated as
  best-effort.
  **Implementation note (r35, via §15):** divergence is resolved by REBUILDING the mirror,
  not rebasing it — `remove → fresh clone → re-publish from the store → push`. Same
  semantics (the local backlog reaches the remote without force; append-only content merges
  trivially), fewer moving parts, and no rebase primitive needed (isomorphic-git 1.42 has
  none). The rebuild is safe only because the mirror is transport (§3.1) — the workspace
  store is the truth it re-publishes from. Diverged-vs-network is a machine-readable
  failure CODE, not prose matching: a network error's message once contained the word
  "diverge" and falsely triggered this path (caught by the real-HTTP test).
- Debounce: consecutive archive events within the configured window coalesce into one push.
  The triggers live in both planes: the host plugin pulls before, and schedules after,
  fork/continue archives; the realm engine schedules after compaction finalization and
  pulls at each session's first `turn/start` (the "new session" refresh point, read
  process-scoped). The file lock is what makes the two schedulers safe side by side.

### 5.3 Failure semantics

Remote down, token revoked, clone corrupted — each degrades to *local-only mode*: the store
keeps working, pending sync accumulates, `/chapters-status` says so with numbers. Nothing in
the conversation path waits on the network.

## 6. Model enrichment: async, provenance-tagged, re-runnable

### 6.1 The pass

For each archived chapter, one structured call whose input is the cheap slice the user
specified — **the user request(s) plus first and last assistant message**, each capped, plus
the first ~200 tokens of the chapter body for grounding — and whose output is validated JSON:

```json
{"title": "…one sentence…", "summary": "…short…", "topics": ["…up to 10…"]}
```

- **Validation before commit:** schema-check; on failure, retry once; on second failure, keep
  the deterministic values (title from the existing derivation, excerpt-labeled summary,
  signature topics). A slow or failing model never blocks or blanks a chapter.
- **Thinking models:** the pass runs at low reasoning effort and tight `maxTokens`; on the
  local server this is the only model work this feature ever forces, and it is batched,
  below.
- **Topics are proposals:** they enter the chapter's frontmatter only through the
  canonicalizer (§6.3) — unknown labels pass as `unvetted`.

### 6.2 When it runs: idle-batched, never per-turn

**Measured constraint (r29-era):** the local server is **single-slot**
(`maxConcurrent: 1`). Per-turn model work would queue against the user's own conversation
turns. Therefore:

- **Per turn:** deterministic signature only (§4.1) — free, synchronous, no model.
- **Model enrichment:** batched at natural idle points — after a compaction/fork push
  completes, or on an idle debounce — processing *archived* chapters only. It can be
  disabled per-harness in config; a harness on a contended machine can run
  signatures-only and still contribute a fully functional corpus.
- **Re-runnable:** a command re-annotates a chapter (or the whole project) with a newer model
  or corrected vocabulary, overwriting only the model-owned fields (frontmatter provenance
  records each overwrite). The verbatim body is never touched.

### 6.3 Self-bootstrapping vocabulary (no seed list, no hand-editing)

Per the user requirement, the vocabulary is **plugin-owned and emergent** — the user neither
authors a seed list nor edits files:

1. **First runs:** no canonical vocabulary. Topic labels are raw deterministic candidates;
   enrichment topics enter flagged `unvetted`.
2. **Merge signals**, watched by the plugin against its own corpus:
   - two labels **co-occur** in the same chapter repeatedly;
   - two labels share **high normalized token overlap** across chapters;
   - **alias patterns** (substring/singular-plural: `auth` ⊂ `authentication`).
   Past threshold, the plugin writes a **curation entry** into `edits/<harness-id>/`
   (Layer 1, §10.1): `author: plugin`, `reason: <signal + counts>`, `merge: {from, to}`.
3. The derived index and `topics/vocabulary.json` reflect curation entries on the next build;
   the vocabulary file stays **diffable and git-revertable** — the user can see every
   decision the plugin made, and undo one, without ever having to make one.
4. Escape hatch (P3, optional): `/chapters-topic merge <a> <b>` — the same curation entry,
   human-authored.

Provenance in frontmatter (§2.4) is what makes all of this auditable: any label on any
chapter traces to a deterministic pass, a specific model run, or a specific curation entry.

## 7. Rules: chapters of a different kind

### 7.1 Model

Rules reuse the chapter machinery end-to-end — same file format, registry, budget preflight,
search, and sync. Frontmatter: `kind: rule`, plus `category`, `status`, and provenance.
**Rules are another form of chapter to search when needed** (user's framing, adopted); the
plugin's modularity is what makes this nearly free — the chapter code paths are parameterized
by `kind`, not duplicated.

### 7.2 Lifecycle: proposed → core, approved in-session

- **Proposal:** a user command (`/chapters-rule add <category> <text>`) or an agent's async
  derivation from a completed session (P3, always `status: proposed`, provenance-tagged with
  the source session).
- **Review/approve:** entirely in-session DSH commands — the user never leaves the session,
  and **command output never enters the context window** (verified 2026-09-17: command results
  persist as `command/run` / `command/done` event types — a distinct type, not
  user/assistant/tool — which are neither prefilled to the model nor priced by the compaction
  engine; 24 such pairs observed in the r29 session's durable log from the e2e suite):
  - `/chapters-rule list` (`--proposed`, `--category <name>`) — table: id, status, category,
    one-line text, provenance.
  - `/chapters-rule approve <id>` — `proposed → core`.
  - `/chapters-rule revoke <id>` — core back to the file, out of the notice.
- **`core` is the only tier that renders into the continuation notice** (§7.3). The human
  in the loop is the one who types `approve`; the git diff of the rule file is the audit
  trail. This is the trust boundary for shared state (§11.3).

### 7.3 The rules section of the continuation notice

The notice carries (all O(1), §1 invariant 6):

- **Core rules:** the `status: core` set, rendered verbatim, **size-capped** by the same
  refuse-don't-truncate rule — if core rules exceed their budget, the notice names the
  overflow with numbers and the user curates (`revoke`, or split a category). Never silent
  clipping.
- **Rules category index:** category names + one-line essence + paths, with the instruction
  *load a rule category when this session's topics overlap a category* — i.e., the agent
  reads the full category from the repo when (and only when) relevant.
- **Search instructions** for the chapters index (one paragraph, pointing at
  `chapters_search` and the shard paths).
- **`Project: <slug> · <projectKey>` — prominently near the top** (user requirement): the
  agent always knows which corpus it is in and where searches point.
- The existing sections (chapters list with single-sentence title, short summary, file link,
  **message count** — not token count, since tokenization is not comparable across models —
  and parent/fork links) unchanged.

### 7.4 Later: topic-matched auto-inclusion

When a continuation is created, the plugin can compute topic overlap between the archived
span's topics and rule categories and inline matching *category-level* rules within the same
budget. P3b; gated by the same cap-and-refuse rule.

## 8. Search: `chapters_search`

### 8.1 Contract

```
chapters_search { query: string, maxTokens?: number, topic?: string, crossProject?: boolean }
→ { matches: [...], shown: n, total: m, budget: {requested, used, remaining} }
```

- `maxTokens` is **the agent's request** (user requirement: the model knows its own window;
  the plugin measures and packs to it, the same way the continuation budget preflight does).
  Default: small (config), overridable upward by the agent.
- **Deterministic scorer** (no model, reproducible, transparent):
  - term hits on **topic (×2 weight), title, summary, category** (rules: category + text);
  - **recency** boost: exponential decay on chapter date;
  - small bonus for `kind: rule, status: core`.
- **Output lines:** `score | date | kind | title | path (topics: …)` — packed until
  `maxTokens` is spent, most-relevant first; the response reports `total` so the agent can
  re-request with a larger `maxTokens` to page (transparent, no hidden truncation).
- **`topic: <name>`** reads an entire index shard (a bounded, alphabetical file).
- **Default filter: the caller's `projectKey`** — cross-project search is an explicit
  `crossProject: true`, so a small-model session never wanders into a foreign corpus by
  accident.
- **Zero new trust surface:** every `path` returned is a plain file the existing `read` tool
  opens (chapters in `.dsh-chapters/`, shards in `.dsh-knowledge/index/`). The search tool
  adds a scorer and a formatter; it adds no new way to read.

## 9. Redaction: minimal, deterministic, marked

User position, adopted: **credentials only, deterministic patterns only, everything else
byte-identical** — the character of the conversation is historical value and stays intact.

- **Patterns (deterministic):** `AKIA…` (AWS), `sk-…` (OpenAI-shape), `ghp_/gho_/
  github_pat_`, JWT `eyJ…` shape, `Authorization: Bearer …`, `token=…` in URLs, PEM private
  key blocks. Deliberately conservative; new patterns are config additions, not magic.
- **Marker format:** `⟦redacted:credential sha256=8f3a1c2b⟧` — (a) obviously not a real value
  to any model reading the chapter, (b) **deterministic per secret** (same secret → same
  marker, so diffs and cross-chapter greps stay stable), (c) leaks nothing but a prefix hash,
  which is also what lets a user ask "which secrets touched my sessions" without exposing
  them.
- **Applied once, at the archive chokepoint** — render → redact → write — covering chapters
  *and* artifacts, so a value is redacted at the moment it leaves the session log, wherever it
  appears.
- **Honest limit:** pattern-based redaction is a speed bump, not a guarantee. The doc that
  ships with the repo (and the notice) says the corpus is **plaintext memory**: per-project,
  private, user-created, with a known-small redaction carve-out.

## 10. The two-layer index

### 10.1 Layer 1 — editable, per-machine, append-only

`edits/<harness-id>/curation.jsonl` — one JSON line per index fact, **one writer per file,
ever** (§3.3), zero conflicts by construction:

```json
{"type":"topic-alias","from":"auth","to":"authentication","author":"plugin",
 "reason":"co-occurrence in 14 chapters","session":"…","at":"…"}
{"type":"group","chapters":["…a","…b"],"label":"jwt-refresh-work","author":"user","at":"…"}
{"type":"weight","topic":"auth","weight":2,"author":"user","at":"…"}
```

Fact types: `topic-alias` (merge/rename), `topic-pin`, `group` (sibling chapters that
belong together — the semantic grouping that composition cannot do alone), `weight`,
`note`. Authors are `plugin` or `user` (user entries via commands, P3). This is the
"improve over time" layer: curation accumulates as facts, and the derived index reflects
them — performance improves without anyone hand-editing, and every fact is inspectable and
revertable in git.

### 10.2 Layer 2 — compressed, derived, incremental

`index/<topic-shard>.md` — one shard per canonical topic (alphabetical segmentation:
bounded files, and writes from different chapters usually touch different shards). Shard
content: a header line (topic, count, last-updated) then one line per chapter:
`date | title | path | (kind) | recency-hint`.

**Build is incremental** (user requirement: generation time must not scale with the corpus):
`manifest.json` records, per input file, the content hash last processed. A build touches
only (a) new chapters/artifacts/collections and (b) new curation entries since the last
build — O(delta). Because inputs are append-only, "changed" ≈ "new" in practice.

**Full rebuild stays possible** (deterministic from the tree) as the *recovery* path — a
machine with a lost manifest regenerates, and any machine can repair a divergent derived
file by rebuild-and-commit rather than merge-resolving (§3.3). Incremental is the fast path;
rebuild is the repair path.

## 11. Trust and security

### 11.1 Credentials

Scoped, revocable, per-repo, per-harness (§2.1). No SSH. A compromised harness exposes at
most one repo token, revocable in one click.

### 11.2 Data exposure

The corpus is plaintext memory (chapters are verbatim by design). Mitigations are the
boundaries, not illusion: per-project repos, private, user-created; redaction carve-out
(§9); per-harness namespacing so one machine's sessions are always attributable.

### 11.3 The blast-radius rule

Everything in the corpus that a *model* can influence and that other machines will *follow*
needs a human gate:

- **Chapters:** low blast radius — evidence, provenance-tagged, attributable. No gate.
- **Topics/vocabulary:** medium — affects search, not behavior. Plugin-autonomous with
  git-visible curation entries (§6.3).
- **Rules:** high — they are prompts by another name, shared across machines. **Human
  `approve` is mandatory** (§7.2). A proposed rule that is never approved affects nothing.

Git history + provenance makes every tier auditable and every mistake revertible.

## 12. Configuration surface

No hardcoded tunables (existing hard rule). New config, all with defaults documented in
`dev/` templates:

| Key | Meaning | Default |
|---|---|---|
| `knowledgeRemote` | the project's repo URL (or `/chapters-link`) | none (local-only) |
| `projectKeyOverride` | wins over §2.3 derivation | none |
| `mergeThreshold` (τ) | collection-merge overlap, §4.2 | tuned in P1 |
| `chapterLimit` | max chapter size (tokens, heuristic) before forced split | 8000 (today's `chapterTokenTarget`) |
| `coreRulesBudgetTokens` | cap on the notice's core-rules section | refused-with-numbers on overflow |
| `syncDebounceMs` | coalesce window for pushes | 30000 |
| `toolResultArtifactTokens` | arrival-time artifacting floor (architecture.md amendment 2026-09-19): tool results at/above this many estimated tokens are stored as artifacts and reference-stubbed BEFORE the next request composes — the blob never enters any prompt | 8000 |
| `elicitedPlot` | when a compaction region holds no model-authored `PLOT:` note, spend ONE bounded stream call (≤8K chars in, ≤220 tokens out) to mint the working plot carried into the checkpoint; the approved, config-killed exception to zero-inference | true |
| `enrichment.enabled` / `.model` | per-harness enrichment toggle + model pin | enabled, conversation model |
| `redaction.patterns` | additive to the built-in list (§9) | built-ins |
| `search.defaultMaxTokens` | default pack size for `chapters_search` | small, config |

## 13. Phasing (each phase independently useful)

**P1 — Transport + deterministic corpus (zero new inference).**
Clone/sync loop (§3, §5); `projectKey` (§2.3); per-turn signatures at `turn/end` (§4.1);
topic-sequential composition replacing size-only splitting (§4.2–4.4) for the fork path
first (compaction spans use the same composer); derived sharded index + incremental manifest
(§10.2); `chapters_search` (§8); redaction at the archive chokepoint (§9); notice v2 —
`Project:` line, message counts, search instructions (§7.3).
*Exit criterion: two machines, one repo; a fork on machine A sees machine B's chapters via
search; sync failure degrades to local-only without breaking the fork.*

**P2 — Model enrichment + emergent vocabulary.**
Idle-batched enrichment pass (§6.1–6.2) with validation/fallback; provenance frontmatter
final; self-bootstrapping vocabulary + curation entries (§6.3); Layer 1 edit types finalized.
*Exit criterion: enriching a corpus is idempotent and re-runnable; vocabulary merges are
git-visible and revertible; disabling enrichment leaves a fully working corpus.*

**P3 — Rules.**
Rules-as-chapters (`kind: rule`); the in-session command family `/chapters-rule
list|add|approve|revoke` (§7.2 — command output verified context-free); core-rules section +
category index in the notice (§7.3); agent-side rule proposals (async, always `proposed`);
`/chapters-topic` escape hatch; P3b topic-matched auto-inclusion (§7.4).
*Exit criterion: a rule proposed by a machine affects no other machine until a human types
`approve`; the core set overflows by refusing with numbers, never clipping.*

## 14. Open risks (honest register)

| Risk | State |
|---|---|
| Pure-JS git SDK performance at repo scale; SSH-only remotes | accepted (user-directed); CLI fallback config-gated |
| Deterministic topic quality on pure-prose (non-code) sessions | degrades to today's time/size behavior; enrichment improves recall later |
| Pattern redaction is a speed bump, not a guarantee | documented in-repo; patterns are config-extensible |
| Single-slot model server contention | enrichment is idle-batched and per-harness disableable; signatures are model-free |
| Cross-model topic vocabulary drift | canonicalizer + provenance + re-run (§6.3) — mitigated by design, observed in practice at P2 |
| `mergeThreshold` mis-tune at archive time (composition is archive-time-only, §4.4) | signatures are stored with provenance; tune for future archives, inspect past ones |

## 15. Amendments

This record governs implementation. An amendment is a **human decision** — discussed,
accepted, and edited in with a commit message stating the reason — because the record's value
is that every architectural fact in it was chosen, not generated. Machine-derived knowledge
lives in the *corpus* (chapters, curation entries, vocabulary with provenance); machine
opinions about *this document* do not.

---

*Cross-references: invariants and the four invariants — `AGENTS.md`; budget math —
`docs/contract.md` (continuation budget) and `docs/architecture.md` (storage); the engine
seam the composer hooks into — `docs/host-compaction-seam.md`; measured claims cited as
`rNN` — `spikes/probe/FINDINGS.md`.*
