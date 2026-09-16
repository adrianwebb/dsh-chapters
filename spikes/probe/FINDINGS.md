# Phase 0 — Measured Findings

Five probe boots against a throwaway harness (`DSH_HOME=$PWD/.dshdev`, `--port 0`), each process killed
and re-started for the last one. Round sources: `lib/index.round1.js` (results.json), `round2.js`
(results-2.json), `round3.js`, `round4.js`, `round5.js`. Nothing here is inferred; every line is output.

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
