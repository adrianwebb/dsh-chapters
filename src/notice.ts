/**
 * The TOC notice: the single synthetic `user/message` that seeds a continuation.
 *
 * This module exists because of the 66-log lesson from `dsh-session-fork`
 * (docs/development.md § L1): a message source outside the kernel's accepted
 * vocabulary is not a cosmetic bug — stored logs that fail replay refuse to
 * load, retroactively. The kernel's seed validator is not published as a
 * callable, so the vocabulary here is pinned two ways and guarded by
 * test/notice.test.ts:
 *
 *  1. Behaviorally, from the Phase 0 seed probes — every rejection and
 *     acceptance recorded in spikes/probe/FINDINGS.md § The seed contract
 *     (an object `source` with a non-empty string `kind`; `role: 'user'`; a
 *     non-empty string `id`; array `content`; contiguous seq from 0).
 *  2. Structurally, from the installed host's published types —
 *     `@deepseek-ai/dsh-llm/lib/types/message.d.ts` `MessageSourceMap` (kinds
 *     `user | plugin | model | tool`, merge-extensible) and `ContextForm`
 *     (`instructions | catalog | notice | relay | recall | snapshot`), plus
 *     `@deepseek-ai/dsh-session`'s `assertMessageEventShape`
 *     (lib/index.js:927-957 in 0.1.5-rc.1-era builds) for the seed-time checks.
 *
 * `plugin: 'dsh-chapters'` + `form: 'snapshot'` mirrors how
 * `@deepseek-ai/dsh-system-prompt` delivers assembled context in real logs:
 * attributable to its producer, and rendered by whatever the UI already does
 * for snapshots. INVARIANT 2: exactly one event, at seq 0. Never a slice of
 * the parent's log.
 */
import type { SessionEventLike } from './types.ts'

/** Our bundle id as it appears in `source.plugin`. Changing this orphans every already-seeded continuation. */
export const NOTICE_PLUGIN = 'dsh-chapters'

/** The section name our TOC rides under inside the snapshot. */
export const NOTICE_SECTION = 'chapters:toc'

/**
 * Message source kinds the base vocabulary accepts (installed host,
 * `dsh-llm/lib/types/message.d.ts` `MessageSourceMap`). The map is
 * merge-extensible — other plugins add kinds (`agent-instructions`,
 * `skill-catalog` were observed in production logs) — but WE may only emit
 * kinds from this list, and only via the local validator.
 */
export const ACCEPTED_SOURCE_KINDS = ['user', 'plugin', 'model', 'tool'] as const

/** `ContextForm` values, exactly as published (semantic, never visual). */
export const ACCEPTED_CONTEXT_FORMS = [
  'instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall',
] as const

export interface TocNoticeOptions {
  /** Fresh unique id per notice — the kernel rejects a seed message without one. */
  newId: () => string
  time?: number
}

/**
 * Build the one seed event for a continuation. Throws rather than emit an
 * event the kernel would reject at seed time — a refusal here is cheap, a
 * bricked log is not.
 */
export function buildTocNotice(tocText: string, opts: TocNoticeOptions): SessionEventLike {
  if (tocText.trim().length === 0) throw new Error('chapters: TOC notice text must not be empty')
  const id = opts.newId()
  if (id.length === 0) throw new Error('chapters: notice message needs a non-empty id ("lacks an identified message")')
  const event: SessionEventLike = {
    type: 'user/message',
    seq: 0, // seeds must be contiguous from 0 (FINDINGS: a seq-3 seed is rejected)
    time: opts.time ?? Date.now(),
    surfaceOp: 'append',
    data: {
      id,
      role: 'user',
      source: {
        kind: 'plugin' as const,
        plugin: NOTICE_PLUGIN,
        form: 'snapshot' as const,
        sections: [{ name: NOTICE_SECTION, text: tocText }],
      },
      // content mirrors sections[0].text byte-identically: the model reads
      // `content`; the UI and attribution read `source`. One text, two faces.
      content: [{ type: 'text' as const, text: tocText }],
    },
  }
  assertKernelAcceptedUserMessage(event)
  return event
}

/**
 * Transcription of the kernel's seed-time checks (assertMessageEventShape +
 * the recorded rejections). Kept as an exported predicate so tests pin our
 * output against the same rules the host applies, and any future notice
 * variant fails HERE, at the boundary of authorship.
 */
export function assertKernelAcceptedUserMessage(event: SessionEventLike): void {
  if (event.type !== 'user/message') throw new Error(`chapters: unexpected notice event type ${event.type}`)
  const data = event.data as
    | { id?: unknown; role?: unknown; source?: unknown; content?: unknown }
    | undefined
  if (data === undefined || typeof data !== 'object') throw new Error('chapters: notice event needs data')
  if (typeof data.id !== 'string' || data.id.length === 0) {
    throw new Error('chapters: seed user/message lacks an identified message')
  }
  if (data.role !== 'user') throw new Error('chapters: seed message must have role "user"')
  const source = data.source as { kind?: unknown; plugin?: unknown; form?: unknown } | undefined
  if (source === undefined || typeof source !== 'object' || typeof source.kind !== 'string' || source.kind.length === 0) {
    throw new Error('chapters: seed message has invalid source (object with non-empty string kind required)')
  }
  if (!(ACCEPTED_SOURCE_KINDS as readonly string[]).includes(source.kind)) {
    throw new Error(`chapters: source kind "${source.kind}" is outside the pinned vocabulary`)
  }
  if (source.kind === 'plugin' && (typeof source.plugin !== 'string' || source.plugin.length === 0)) {
    throw new Error('chapters: plugin source must name its producer')
  }
  if (source.form !== undefined && !(ACCEPTED_CONTEXT_FORMS as readonly string[]).includes(source.form as string)) {
    throw new Error(`chapters: context form "${String(source.form)}" is outside the published ContextForm union`)
  }
  if (!Array.isArray(data.content) || data.content.length === 0) {
    throw new Error('chapters: seed message has invalid content')
  }
}
