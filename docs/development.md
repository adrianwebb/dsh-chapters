# Development and Test Loop

The problem is real: **this repository is edited from inside a running DeepSeek Harness, and a plugin
only takes effect after that host restarts.** Restarting it would kill the session doing the work. So
the loop has to be built so that it never touches the host it runs in. Everything below was verified on
this machine, not assumed.

## Environment Facts (checked, not inferred)

| Thing | Value |
|---|---|
| Host serving this session | global npm install, `/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`, **0.1.5-rc.1**, listening on `127.0.0.1:3080` |
| Profile root | `~/.dsh` (`DSH_HOME` default) — `profiles/`, `sessions/`, `storages/`, `.credentials.yaml` |
| Sandbox effect | `~/.dsh` is **read-only** from the agent sandbox: `dsh web --help` died with `EROFS: read-only file system, open '/home/adrian/.dsh/profiles/web/cordis.yml'` |
| Dev fork | `~/Projects/deepseek-harness` — git `fb2c4b9e69` (2026-09-10), **0.1.5-rc.2**, pnpm workspace, `node_modules` installed |
| `/app/checkout` | **does not exist on this machine.** It appeared in my *session context* as a presumed harness checkout, not in this repository's docs — I checked, and no file here references it. The real fork is the row above |

Two consequences worth stating plainly:

1. **The sandbox is an ally, not an obstacle.** Because `~/.dsh` is read-only to an agent shell, the
   accidental self-destruct path — installing into the live profile and restarting the host running the
   work — is *structurally unavailable*. The dev loop is the only loop available.
2. **The fork is newer than the host** (rc.2 vs rc.1), and `examples/deepseek-harness` is a third
   snapshot. Line numbers in `docs/contract.md` come from the `examples/` copy. Treat any of the three as
   truth only for the question you asked it; resolve real behaviour against the version you are actually
   booting.

## The Isolation Mechanism: `DSH_HOME`

`dsh --help` documents profiles as "the profile under `$DSH_HOME/profiles` to boot", and `DSH_HOME`
relocates the entire root — profiles, sessions, storages, credentials. Verified:

```bash
mkdir -p .dshdev
DSH_HOME=$PWD/.dshdev dsh web --port 0 --no-open
# → dsh web: http://127.0.0.1:32869/?token=…
```

A **fresh, fully isolated instance** booted: it created its own `profiles/web` under `.dshdev`, chose a
free port, minted its own token, and left `~/.dsh` and the `:3080` host untouched. `--port 0` means the OS
picks, so nothing conflicts. This is the whole answer: we get a disposable harness.

`.dshdev/` is gitignored. Never point `DSH_HOME` at `~/.dsh`, and never run `dsh plugin --profile web add`
without it — that is the command that mutates the profile this session is living in.

### Safe default guard

Prefix every harness command with `DSH_HOME=$PWD/.dshdev` — or do not type it at all:
**`scripts/dsh-scratch.sh` is that wrapper** (`--home .dshdev2` for a parallel profile; it refuses any
resolved home under the real `~/.dsh` and execs `dsh` with `DSH_HOME` exported).

This stopped being advice the hard way: during Stage 0 a bare `dsh plugin --profile web add ...` (no
`DSH_HOME`) targeted the LIVE profile — the sandbox's read-only `~/.dsh` turned it into a harmless
`pnpm failed` and the live `package.json` mtime proved nothing was touched, but "the sandbox protects us"
is not a guard rail. Any future command form that can reach `~/.dsh` must route through the wrapper.

## Test Layers

Adopted from how the reference plugins actually iterate (they mostly *avoid* restarting the host):
`dsh-session-fork` has ~8,000 lines across 28 `bun test` files and **every test file header says "no
cordis"** — logic takes an injected `Ports` interface and only `makePorts(ctx)` touches the kernel. Copy
that shape, and fix its one gap (§L1).

### L0 — Pure logic, no cordis, no harness

Ranges validation, the chapter renderer, TOC assembly, budget math, slug/number allocation. Fast, CI-able,
no DSH at all. Structure for it from day one:

```ts
// src/continue.ts — no cordis import anywhere in this module
export interface ContinuePorts {
  readSession(id: string): Promise<SourceLog | null>
  createContinuation(opts: { sessionId: string; seed: readonly SessionEvent[]; cwd?: string }): Promise<void>
  reserveNumbers(key: string, count: number): Promise<number[]>
  putRegistry(state: SessionState): Promise<void>
}
export async function runContinue(ports: ContinuePorts, args: ContinueArgs): Promise<ContinueResult>
```

`src/index.ts` is then the **only** cordis-facing file — a thin adapter, deliberately untested.

### L1 — A *stateful* seed fake (where the reference plugin fell short)

`dsh-session-fork`'s `createChildFromSeed` fake records `cut` as a number and validates nothing: it proves
*which* port calls happened in *what* order, never what the kernel does with a seed. Our seed is one
synthetic event, so a ~30-line fake can close that hole cheaply — **materialize** the seed and assert:

- seqs contiguous from `0`, our notice at `seq = 0`
- `surfaceOp: 'append'`
- `inheritedEventCount` equals `seed.length`
- the message source we emit is inside the kernel's accepted vocabulary

That last bullet is `dsh-session-fork`'s most expensive lesson: a retired message source **bricked 66
stored logs** which then refused to load, and they now pin the rule in a `format-watch` test because the
validator isn't published. Our TOC is a synthetic `user/message` — pin the vocabulary test *first*, not
after a chain of corrupted session files. Their `replaySurface()` idea (re-fold the durable log, assert it
equals the live surface) is the right invariant to steal wholesale.

### L2 — Boot-time probe in an isolated profile → **this is how Phase 0 runs**

No LLM, no tokens, no HTTP driving, no restart of anything:

1. Write the probe as a minimal plugin whose `apply()` runs the experiment during boot and writes JSON
   facts to a file in the workspace.
2. Install into the **scratch** profile. `dsh plugin add` runs pnpm and may reach for the network; if it
   does, bypass it by symlinking the package into `.dshdev/profiles/web/node_modules/` and adding its id
   via a `--patch` overlay (`dsh --patch <file>` applies an extra patch layer at boot).
3. `DSH_HOME=$PWD/.dshdev dsh web --port 0 --no-open`, let it boot, read the JSON.

Phase 0 questions it answers: is an unseeded/one-event-seeded `agents.create` durable, listed, and
resumable; does `Session.create` accept the seed; does workspace attach work; does the child's header match.

### L3 — Headless one-shot with a real model (only when a measurement needs it)

`dsh --profile headless "…"` boots a profile, answers one task, prints, and exits — scriptable. The
headless bundle emits JSON with `usage.cacheReadTokens`, which is the only way to get the cache numbers
G1–G3 in `docs/verify.md` without a browser.

Costs real model tokens and needs credentials: `$DSH_HOME/.credentials.yaml` is *inside* the relocated
root, so a scratch home starts unauthenticated. **Copying the user's credentials into a scratch root is
their call — ask before doing it, and ask before spending tokens on a measured run.** Prefer L0/L1 for
correctness and reserve L3 for the few numeric assertions.

### L4 — Upstream drift pins

The habit that lets you iterate against a moving host without booting it: text-pin what you depend on in
the *installed* bundles and fail loudly on drift.

- `parity`-style: run the real published package against any vendored copy of its logic.
- `upstream-watch`-style: assert literal call sites still look the way our assumption says (e.g. that
  `session.fork` still seeds with `events.slice(0, cut)` — the fact invariant 2 rests on).
- `vendor`-style: pin `file:line` + SHA markers in a header comment and assert they still exist.

On failure, the procedure is *re-read upstream and re-anchor*, never "relax the assertion".

## Speed Notes — What Made This Fast

Learned while running eleven probe boots. Each is a concrete loop improvement, not a preference.

**One env var is the whole isolation story.** `DSH_HOME=$PWD/.dshdev` cost nothing to adopt and removed
the restart problem entirely. Every harness command in this repo should carry it — wrap them in
`scripts/` or a `Makefile` so the bare form never appears in a doc or a shell history.

**Failures before the provider are free.** Round 10's every turn errored on `{{model}}` assembly and
spent **zero** tokens. A probe that fails early costs a boot, not a bill — which means it is cheap to
probe aggressively and wrong. Prefer a probe that might error over reading five more source files.

**Plain `.js` probes beat a build step.** The spike needed no TypeScript, no `tsc`, no `lib/` output:
write `lib/roundN.js`, point `package.json` `main` at it, boot, read JSON. Ten seconds of edit-build-test
with no compile errors to fight. Keep the *real* plugin in TypeScript; keep the *spike* in JS.

**Reading the host's own session logs is the fastest source of truth.** `~/.dsh/sessions/<projectKey>/<id>/session.v3.jsonl.zstd`
shows exactly what a real `user/message` looks like, which `source.kind` values are in play, and how large a
request header actually is — all without a model call. Two gotchas that each cost a cycle:

- `zstd -dc <path>` **fails** on these paths: they begin `--home-…` and are parsed as flags. Use
  `zstd -dc -- <path>`.
- Paths are bucketed by `projectKey(cwd)` (`session-persistence-jsonl/src/format.ts:224`), so a project
  directory is encoded with `-` separators, e.g. `--home-adrian-Projects-dsh-chapter-fork--`.

**`Function.prototype.toString` is useless on the bundled host** — service methods report
`function () { [native code] }`. Do not plan to discover signatures by introspection; grep the
`examples/deepseek-harness` checkout instead. Three signatures cost one wasted boot each when guessed:
`listSessions(signal?)` is **positional**, `agents.resume({ resumeSessionId })` is an **options object**,
and `create` needs `agentOptions` plus a preset.

**TypeScript tests run with zero install and zero build — use this before reaching for vitest.**
`node --test test/*.test.ts` executes `.ts` directly on Node 24 via type stripping, so the pure core
(`src/render.ts`, `src/types.ts`) is covered by 15 tests in ~135 ms with **no `node_modules` at all**. That
keeps the L0/L1 layer free: no dependency resolution, no bundler, no config, and it works inside the agent
sandbox where an install may not. `npm test` is wired to it.

Reserve the vitest/bun decision for when kernel-facing mocks need more than Node's runner gives, and note
that `npm run typecheck` **does** need `typescript` + `@types/node` installed — a separate step from
testing, deliberately not taken yet.

**Keep probe turns tiny.** `Reply with exactly: ALPHA. No explanation.` finishes in one step and a few
tokens, so a measurement that needs five real turns still costs pocket change.

**Instrument the metric, not just the code.** The cache numbers only became readable once the formula was
pinned: `totalPrompt = inputTokens + cacheReadTokens`, `hit = cacheReadTokens / totalPrompt`. Dividing by
the uncached delta instead produces values like 1721% and quietly wrong conclusions — which is exactly what
happened in these notes before it was caught.

## Implementation Status (kept current)

| Layer | State |
|---|---|
| `src/types.ts`, `src/render.ts` — pure chapter renderer, ranges, fence safety, artifact deferral | **done**, 15 tests |
| `src/archive.ts` — reserve→write→verify ordering, dedup, idempotent retry, coverage, tamper detection | **done**, 11 tests |
| `src/notice.ts` + `test/notice.test.ts` — TOC-notice builder, kernel-rejection reproduction, vocabulary pins + drift guard (Phase 0b check 5) | **done**, 10 tests |
| `src/registry.ts` + `src/store.ts` — pure numbering/ancestry/plan state; zod domain spec, storage-domain + node-fs adapters | **done**, 13 + 7 tests; durability witness passed |
| `src/engine-core.ts` + `src/engine.ts` — ChaptersCompactionEngine | **done & boot-proven** (r18/r19: realm subpath row mounts; real cascade finalizes; catch-path fix — FINDINGS § Phase 1) |
| `presets/chapters/` + copy-on-boot install | **done & boot-proven** (r21; `!!js` has no `require`, so copying is the delivery mechanism — r20) |
| `node --test test/*.test.ts` | **82 passing, ~150 ms, no build step** (pure tests import no `@deepseek-ai/*`; store.test.ts touches only zod + local code) |
| 20-check verify.md pass | **r26/26b**: 18 mechanical on `.dshdev2` (refusals with numbers, tamper marks, idempotent retry, cross-boot registry + resume); human rows per verify.md evidence map |
| dsh-session-fork coexistence | boot-pair **blocked by the fork's own rc.2-vs-rc.1 `webServer` inject drift** (fails alone identically, r26) — assumed-neutral until a version-matched pair-boot |
| `scripts/dsh-scratch.sh` | **done** — refuses any DSH_HOME under the live `~/.dsh`; the near-miss is in FINDINGS |
| `chapters_segment` / `chapters_continue` / `chapters_fork` tools (`src/tools.ts` → `continue-core.ts`) | **done & boot-proven** (r22 9/9 full loop incl. child read-back; r24 fork siblings reserve nothing; r25 durable title; r26/26b checklist pass) |
| E3: header cache across a compaction | **measured (r23): cacheReadTokens held 7,424 across post-compaction turns; uncached refill 13,658 → ~7,000** |
| `npm run typecheck` / `npm run build` | **working** — typescript 5.9 + @types/node + host packages as devDeps; `.ts`-import convention kept via `rewriteRelativeImportExtensions` |

Two bugs the pure tests caught that would have been expensive later, which is the argument for this order:

1. `coverage()` started its cursor at the first chapter, so a chapter set that skipped the **opening** of a
   conversation reported no gap — silent history loss, exactly the failure the plugin exists to prevent.
2. Substring assertions against `/chapters/` matched the store root `.dsh-chapters/` first. Worth knowing
   as a general hazard: **the default store root name contains the word `chapters`**, so any path matching
   in real code must anchor on the separator.

## Unavoidably Manual

Say it rather than pretend the suite covers it:

| Needs a human | Why |
|---|---|
| Sidebar listing and visual resume of a continuation | no client-side harness reaches the real module loader contract |
| Cache/prefill economics across process generations | inherently multi-process; a restart recomposes every header |
| TOC readability and whether the model actually reloads chapters | judgement about prose and behaviour |
| The Phase 0 verdict itself, read from probe output | L2 produces the facts; a human confirms the interpretation |

## Command Reference

```bash
# disposable instance — prefer the wrapper (DSH_HOME is its problem, not yours):
#   NOTE: .dshdev mounts dsh-chapters-probe, whose rounds process.exit when done — fine for
#   scripted one-shot boots, WRONG for an interactive test (the server dies seconds after the
#   URL prints). Manual testing belongs to .dshdev2 (plugin only; probe removed 2026-09-17).
scripts/dsh-scratch.sh web --port 0 --no-open                    # .dshdev (probe home)
scripts/dsh-scratch.sh --home .dshdev2 web --port 0 --no-open    # clean home for the real plugin

# manual form, if the wrapper is unavailable:
mkdir -p .dshdev
DSH_HOME=$PWD/.dshdev dsh web --port 0 --no-open

# inspect the composed bundle tree of a profile without booting it
DSH_HOME=$PWD/.dshdev dsh --profile web --dump-config | head

# add our plugin to the SCRATCH profile only
scripts/dsh-scratch.sh --home .dshdev2 plugin --profile web add "link:$(pwd)"

# one-shot headless run (needs credentials in the scratch root; costs tokens)
DSH_HOME=$PWD/.dshdev dsh --profile headless "list your tools"

# unit tests
bun test        # or vitest — decide in Phase 0, see docs/architecture.md § Open Questions
```

**Never** run `dsh plugin --profile web add` or `dsh web` without `DSH_HOME=` set to the scratch root:
that is the profile and port this session is running on.

## Correction to Earlier Claims in This Repo

Two things I asserted before checking, now that they are checkable:

1. **"`dsh web` runs in a tmux pane on the dev fork at `/app/checkout`"** — wrong for this machine. There
   is no `tmux` binary and no `/app/checkout`; the harness serving this session is the global npm install
   on `:3080`. The dev fork is `~/Projects/deepseek-harness`.
2. **An isolated instance's port.** I first reported `34159` from a garbled read; the actual boot printed
   `32869`. The curl to `34159` failing was the tell — it was my number, not the server's.

Both are worth recording rather than quietly fixing, since the whole point of this file is that its
commands were *verified*.

## Suggested Additions to the Other Docs

`docs/contract.md`'s file:line citations are from the `examples/` snapshot (rc.1-era), not the rc.2 fork —
re-anchor them against whichever version a test actually boots.
