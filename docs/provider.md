# Knowledge Transport Providers

The sync layer's transport is pluggable (governing record: `knowledge-repo.md` §3.2 extended by
Amendment 2026-09-21). One project record picks one provider; nothing else knows the difference.
This file is the contract: what a provider must do, which invariants it inherits, and how each
backend fills them.

## The seam

`runSync`'s transport surface is exactly six verbs — a provider is those, plus identity:

```ts
interface SyncProvider extends GitDriver {          // src/provider.ts
  readonly kind: 'git' | 'treedx'
  describe(project: ProjectRecord): string          // one honest status line
  ensureClone(dir, remote, opts?)   // make the mirror exist and reflect the remote
  initLocal(dir, remote?, opts?)    // offline mirror (§5.3)
  removeMirror(dir)                 // destroy transport (the store is truth, §3.1)
  stageAllAndCommit(dir, message, author)  // LOCAL diff workdir-vs-known-baseline
  pullFastForward(dir, remote, opts?)      // converge; failure classes diverged|network|auth
  push(dir, remote, opts?)                 // ship the staged delta
}
```

Rules a provider must honor (all inherited from the record, restated at the seam):

1. **The mirror directory exists in every mode.** The workspace store is the read path's truth
   (§3.1); the mirror under `.dsh-knowledge/` is materialized content — search (`loadCorpus`),
   rules (`collectMirrorRules`), the index build, and the notice layers consume it unchanged.
   A provider that skips materialization breaks all of them.
2. **Every failure is a value.** `{ok:false, code}` — the machine-readable classes drive
   runSync's branching: `network` (degrade to local-only), `diverged` (rebuild the mirror from
   the store and re-push), `rejected` (pull-and-retry once), `origin-mismatch` (rebuild; never
   sync into the wrong pool), `auth` (surface the re-link instruction with the detail). Providers
   branch on status + code, **never on prose** (r35).
3. **ff-only, append-only.** Divergence is never merge-resolved; it is rebuilt
   (§5.2). A provider never rewrites remote content.
4. **Nothing throws into the conversation path**, and no token bytes appear in any `detail`
   string (§2.1).
5. **Provider selection is scheme-first, policy-strict.** `treedx+<url>/<repo>` → TreeDX;
   anything else → git. `knowledgeProvider: 'git'|'treedx'` forces one and REFUSES a
   contradiction rather than falling back — a wrong pool is a data-privacy failure, not a
   config convenience (`providerKindFor`).

## Backend truth table

| Verb | git (`gitops.ts`) | TreeDX (`treedx/provider.ts`) |
|---|---|---|
| ensureClone | clone (or adopt existing repo + origin sentinel) | resolve repo in the catalog; fetch refs + `paths/list` (no extension filter — the mirror must be faithful) + `files/read`/`blobs/read`; materialize; write `.treedx-state.json` |
| initLocal | `git init` + origin | state file with `offline: true` (publish/commit/index/search keep working) |
| stageAllAndCommit | workdir-vs-HEAD content diff → git commit objects | workdir-vs-baseline diff → staged path list in the state file (baseline advances at stage time: restaging identical bytes says 'nothing to commit', the git parity) |
| pullFastForward | fetch, ancestor checks, ff; non-ff ⇒ `diverged` | head compare vs state. Unmoved ⇒ up to date. Moved, nothing staged ⇒ refetch (ff). Moved with staged work ⇒ `diverged` — a merge could leave derived files (index/, topics/) built against a stale corpus; the rebuild re-derives |
| push | git push (rejected ⇒ pull-retry) | workspace-create (`refs/heads/main`, one writable lease per branch) → write each staged path (UTF-8 File API; binary via Blob API) → commit. 409 with head unmoved ⇒ `rejected` (lease), bounded retry; 409 after the head moved ⇒ `diverged`; 401 ⇒ `auth` |
| offline recovery | remote returns → pull diverged → rebuild | `state.offline` + reachable ⇒ `diverged` (same rebuild-from-store path) |
| origin drift | `.git/DSH-ORIGIN` sentinel | `state.origin` vs the record's remote ⇒ `origin-mismatch` |

## State: `.treedx-state.json` (the TreeDX mirror's `.git/`)

`{origin, head, baseline: {path → sha256}, staged: {message, author, paths} | null, offline, repoId?}`
— lives inside the mirror, starts with a dot so it never walks into any commit, and is the
provider's memory across verbs (provider instances stay stateless per call, safe to share).

## Identity and credentials (§2.1/§2.3, one rule for both providers)

`projectKey = UUIDv5(NAMESPACE_OID, "treedx/" + canonicalize(baseUrl/repoName))` for TreeDX;
the unchanged `canonicalize(remote)` for git. The `treedx/` namespace keeps a service whose URL
happens to canonicalize like a git remote from stealing another's pool. Credentials ride the
same DSH-home store (`credentials/<projectKey>`, 0600); for TreeDX the token is ALWAYS required
(no loopback exemption: TreeDX answers 401, and a service URL without auth is a config bug,
not a local file).

## What a provider may NOT touch

The workspace store, the registry domain, chapter rendering, redaction, the injection screen
(`src/injections.ts`), composition, budgets, notice assembly, and the rules-approval gate. The
approval (§15 amendment: per-machine curation fact) is the trust boundary shared state passes
through a human on the local machine — a server (TreeDX included, federation included) cannot
pre-approve anything, because the fact file lives under `edits/<harness-id>/` and the effective
status is computed locally.

## TreeDX API surface consumed (spikes/treedx/FINDINGS.md carries the pinning)

`GET /health`, `POST /auth/dev-token` (dev), `GET|POST /repos`, `GET /repos/:id/refs`,
`POST /repos/:id/paths/list`, `POST /repos/:id/files/read`, `POST /repos/:id/blobs/read`,
`POST /repos/:id/workspaces`, `PUT|DELETE /workspaces/:id/files`, `POST /workspaces/:id/blobs/write`,
`POST /workspaces/:id/commit`. Server-side search/graph/context (`files/search`, `graph/*`,
`context/build`) and federation are Phase F: the plugin codes to one ingress URL and federation
needs no client change.

## Failure semantics summary (§5.3, per backend)

| Condition | git | TreeDX |
|---|---|---|
| remote down | offline mirror init; push deferred | offline state; push deferred; pull probes recovery → diverged → rebuild |
| credential bad/revoked | 401 as network class + detail | `auth` class: status says "re-link the token with /chapters-link", conversation untouched |
| repo missing | GitHub creates on first push for scoped tokens (config'd) | link command creates it; sync-time absence ⇒ `not_found`, degraded with the name in the detail |
| oversized file | n/a (packs stream) | File API 413 ⇒ refuse-with-numbers detail (§1.2), never truncate; >1 MiB belongs in multipart (Phase F) |
| lease busy (two machines at once) | push rejected → pull → retry | create/commit 409 → bounded provider retry → `rejected` → runSync's pull-and-retry |
