# TreeDX spike findings — measured against the real service

Facts are marked **[measured]** (verified on this machine this round), **[doc]** (from
`examples/treedx` documentation), or superseded by **§LIVE MEASURED** below — the dev
container booted on 2026-09-21 and the live suite ran against it.

## Environment (this machine, re-checked 2026-09-21)

- **[measured]** docker CLI 29.8.0; the HOST daemon runs fine for the user (systemd, up since
  Sep 13 — the first "daemon DOWN" reading was the sandbox's view, not the machine's).
  **The agent sandbox cannot drive docker**: its process has the `docker` supplementary
  group (972, which `adrian` belongs to on the host) stripped to nogroup, sudo is blocked
  by no-new-privileges, the socket is shadowed then permission-denied even under
  escalation. **The published HTTP port IS reachable from the sandbox** — so containers
  booted by a human are fully testable from here, and that is the loop that ran today.
  `scripts/treedx-local.sh` gates accordingly: `up/down/logs` need the docker CLI,
  `status/token/smoke` need only the HTTP endpoint.
- **[measured]** boot-to-healthy with the image build: ~2.5 minutes (warm layer cache;
  the container compiles the Rust NIF on first run into the cargo-target volume).
- **[measured]** the bundled `examples/treedx/compose.yaml` is Treeseed-platform-bound
  (external network `platform`, `TREEDX_AUTH_MODE=connected`, JWKS + credential broker at
  host.docker.internal:3000) — it does not boot standalone. Hence `dev/treedx.compose.yaml`
  (dev target, `TREEDX_AUTH_MODE=dev`, loopback-only `127.0.0.1:4000`, named volumes, no
  external networks). Dev-mode seeded actor: `actor_demo`/`tenant_demo`, broad grants.

## API surface our provider codes against — [doc], pinned by the stub

- Auth: `POST /api/v1/auth/dev-token` `{actorId,tenantId,expiresInSeconds}` → `accessToken`
  (dev mode only). Bearer header `authorization: Bearer <tok>`. Error envelope
  `{ok:false,error:{code,message,details}}`; 401/403/404/409/413/422 documented.
- Repo lifecycle: `POST /api/v1/repos` `{repositoryName, source:{type:'empty'},
  placement:{mode:'local'}}`; `GET /api/v1/repos`; repository names canonical lowercase,
  unique per node catalog. `GET /repos/:id/refs` (`git:read`).
- Workspace (the transport's write unit): `POST /repos/:id/workspaces` `{baseRef,
  branchName, mode:'writable', ttlSeconds}` → `workspaceId`, `baseCommitSha`
  (base-commit snapshot). **One active writable lease per repository branch** — the
  contention model Phase C maps onto runSync's `rejected` retry.
  `PUT /workspaces/:id/files?path=…` `{encoding:'utf8',content}`; binary-safe
  `POST /workspaces/:id/blobs/write` for non-UTF-8. `POST /workspaces/:id/commit`
  `{message,author:{name,email}}` → commit; workspace `committed`, lease released.
  TreeDX's own guidance says fail closed on moved refs → commit-conflict is a 409 class
  the provider maps to `diverged` (runSync's rebuild path, unchanged semantics).
- Corpus reads: `POST /repos/:id/paths/list` `{ref, paths[], extensions[]}`;
  `POST /repos/:id/files/read` `{ref, path, parseFrontmatter}` → document with
  `content/frontmatter/body` (Markdown frontmatter parsing is native — chapters keep
  their exact shape). `files/search` + `query` exist server-side (Phase F: route
  `chapters_search` through them).
- Limits: `TREEDX_MAX_FILE_BYTES` default **1 MiB** per UTF-8 file (chapters/artifacts are
  far under; provider refuses-with-numbers above — the record §1.2 shape), blobs single
  request 10 MiB, multipart uploads 512 MiB. Protected-path rejection (.git/**, .env*, …)
  never touches the mirror layout (§2.2 content only).
- Path policy: repository-relative POSIX; rejects absolute, encoded/decoded `..`,
  backslashes, NUL — our repo-relative mapping (`planStoreToRepo`) satisfies it.

## Design decisions taken from this reading (governing Phase C)

1. **Transport verbs map as**: `ensureClone` = resolve repo + full corpus pull + write
   `.treedx-state.json`; `stageAllAndCommit` = LOCAL workdir-vs-baseline diff (records the
   staged path list; the network happens in `push` — mirrors git's local-commit semantics);
   `pullFastForward` = head compare vs state; moved-with-staged-work → `diverged` (rebuild),
   moved-without → ff refetch; `push` = workspace-create → overlay writes → commit;
   `initLocal` = offline state file; `removeMirror` = rm -rf (mirror is transport).
2. **State lives in the mirror** (`.treedx-state.json`: origin, head, baseline hashes,
   staged list) — the provider stays stateless per process; host and realm planes remain
   safe side by side via the existing sync lock, exactly as in git mode.
3. **Divergence = rebuild, same as git mode.** Never partial-merge derived files; the
   index/vocabulary rebuild inside the existing diverged-rebuild path already re-derives
   against the fresh corpus.
4. **Identity**: `treedx+<url>/<repo>` → projectKey over the canonical `host[:port]/repo`
   (§2.3's "keep the host" honored); a same-string git remote is a DIFFERENT pool (tested).
5. **Lease contention** maps to `rejected` → runSync's existing pull-and-retry.

## LIVE MEASURED (2026-09-21) — the container ran; this section closes the [LIVE-GATED] list

Measured against the real dev-auth service (direct probes, the full live test suite,
the smoke walk). Every shape below is now mirrored by `treedx-stub-server.ts`, which
is the standing contract pin; anything marked [doc] above that this section
contradicts is SUPERSEDED. The first live run broke three parsers before these
facts were pinned — that is the whole argument for this file existing.

- **Response envelopes** (key names mattered everywhere):
  - `POST /repos` → `{ok:true, repo:{name, repoId, repositoryName, defaultRef,
    status:'registered'}, placement}` — id field **`repoId`** (`repo_<16-hex>`).
  - `GET /repos` → `{ok:true, repos:[…]}` — key `repos`, not `repositories`.
  - `GET /repos/:id/refs` → `{ok:true, repo, refs:[{kind:'branch', name, target}]}` —
    sha field **`target`**; repo routes address by **repoId** (bare-name refs 404s;
    name→repoId resolution goes through the catalog list).
  - `POST /repos/:id/paths/list` → `{ok:true, ref, resolvedRef, repoId,
    entries:[{path, kind:'blob'|'tree', objectId, size, …}], page}` — **`entries`
    including tree rows** (not a `paths` array); the provider filters to blobs.
     **PAGINATION IS REAL (caught live 2026-09-23, a day after the first live
     suite passed):** `page = {limit: 100, hasMore, nextCursor}` — cursor is
     base64 JSON `{"offset":N}`, echoed back in the request body. Reading ONE
     page silently truncates at 100 entries: with the shared dev repo past that
     line, machine B “cloned fine” while missing real files (the live
     `second publish advances the head` test caught it — the corpus grew past
     a page mid-session). `corpusPaths` now loops until `hasMore:false`.
  - `POST /repos/:id/files/read` → `{ok:true, file:{path, content, encoding,
    objectId, …}}`; binary ⇒ **415 `unsupported_media_type`**; miss ⇒ 404 `not_found`.
  - `POST /repos/:id/blobs/read` → `{ok:true, blob:{contentBase64, byteLength, …}}`.
  - `POST /workspaces/:id/blobs/write` → body `{path, contentBase64}` — an
    `{encoding, content}` body is a **422 "contentBase64 is required."** (the
    smoke-time catch).
  - workspace create → `{ok:true, status:'ready', workspaceId, …}` (top level);
    commit → `{ok:true, status:'committed', commitSha, changedPaths, …}`.
  - 401 → `{error:{code:'authentication_required'}}` (missing bearer) / `invalid_token`.
- **Managed repositories are BORN with `refs/heads/main`** — a seeding commit
  holding `.treedxkeep` (26 bytes). Implemented consequence: corpus listing excludes
  dot-paths from the mirror AND the baseline; otherwise the stage-diff reports a
  phantom deletion every pass and a push would delete the service's own
  bookkeeping file (ff-only violation; unit-pinned in `treedx-provider.test.ts`).
- **Leases**: one writable lease per repo+branch; busy create ⇒ 409 `conflict`
  ("writable lease already exists for <repoId> <branch>"). **A lease survives its
  ttl until commit or explicit close** — measured: `expiresAt` had passed, create
  still 409'd; `POST /workspaces/:id/close` released it. Implemented consequence:
  every failed push path closes its workspace (otherwise one broken push poisons
  the branch for every machine until an operator intervenes). Commit-on-success
  releases; commit with empty overlay ⇒ 422 "no workspace changes to commit.";
  moved base ⇒ 409 fail-closed (never observed racing naturally in the run;
  fault-injected through the stub).
- **Dev token**: `expiresInSeconds: 2592000` (30 days) minted without complaint;
  no ceiling hit. Format `treedx_dev_…`; stored by the link command at 0600.
- **A diagnostic fix the live run forced**: a 401 at clone time was being degraded
  into the generic "remote unreachable at clone time" status wording — auth reasons
  now ride through the offline fallback (`runSync` detail carries the clone
  failure's own message; live-asserted by the bad-token test).
- `POST /repos` with `source:{type:'empty'}` + `placement:{mode:'local'}` works;
  duplicate name ⇒ 409 `conflict` (the link treats it as success).
- **Unconfirmed, still open**: `files/read` batching (corpus pull remains N+1
  requests — fine at per-project corpus sizes, snapshot API is the Phase-F
  optimization if it ever isn't).

## How to run the live loop (for the human)

```bash
sudo systemctl start docker            # or your daemon of choice
scripts/treedx-local.sh up             # first boot compiles Rust NIF inside the container: minutes
scripts/treedx-local.sh token          # writes var/treedx-dev.env (gitignored, 0600)
scripts/treedx-local.sh smoke          # the six-step walk
node --test tests/integration/treedx-live.test.ts   # the exit criterion, over HTTP
```
