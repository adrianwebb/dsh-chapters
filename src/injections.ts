/**
 * The one boundary that decides which bytes of the durable log are CONVERSATION
 * and which are host-injected context (knowledge-repo.md §15 amendment,
 * "host-injected context is not conversation").
 *
 * Why this exists: the harness injects project context — workspace instruction
 * files (whatever a given project's AGENTS.md holds), the runtime-context
 * snapshot, the skill catalog — and injected events arrive in the log either as
 * their own `user/message` (source.kind `agent-instructions`, `plugin`, …) or
 * riding INSIDE human messages as `<system-reminder>` spans. A target project's
 * instruction text is that project's business: it must not be archived into the
 * shared knowledge corpus, searched by other workspaces, re-quoted into
 * enrichment input, or bloating a child's re-archive of its own TOC notice
 * generation after generation.
 *
 * Precedents this rule follows, not invents:
 * - `signature.ts` (r28) already excluded these events from per-turn topic
 *   signatures after measuring their poison: every signature gained the
 *   injected filenames and drowned the real topic signal.
 * - `tests/e2e/model-proxy.ts` (user decision 2026-09-20, AGENTS-BLIND) already
 *   masks the same classes for tape matching, on the same reasoning:
 *   development artifacts, every real project ships its own.
 *
 * What is NOT touched: the durable session log (invariant: append-only, always —
 * the originals live on in the parent session), and genuine conversation bytes
 * (a human typing the words "AGENTS.md" in prose is conversation and stays
 * verbatim; only the structural injected forms are removed).
 *
 * Pure module: no cordis, no fs, no network.
 */

/** A user/message is human-authored when it carries no source, or source.kind
 * 'user' (unlabelled keeps working for seeded fixtures — same rule the
 * signature layer has used since r28). Everything else — 'agent-instructions',
 * 'plugin' (the TOC notice, runtime snapshots), 'tool', 'system' — is injected
 * context, not conversation. Exported so signature.ts imports the SAME
 * predicate; the two layers must never drift on what counts as a turn. */
export function isHumanAuthored(data: Record<string, unknown>): boolean {
  const source = data.source as { kind?: string } | undefined
  return source?.kind === undefined || source.kind === 'user'
}

/** Label for the omission marker: kind, plus plugin name when the source
 * carries one (so `plugin:dsh-chapters` is recognizable in a chapter). */
export function sourceLabel(data: Record<string, unknown>): string {
  const source = data.source as { kind?: string; plugin?: string } | undefined
  if (source === undefined) return 'unlabelled'
  return source.kind === 'plugin' && typeof source.plugin === 'string'
    ? `plugin:${source.plugin}`
    : String(source.kind ?? 'unknown')
}

/**
 * The structural injection span. Anchored on the exact harness tag, case
 * sensitive (the tape's own skill-catalog rule is case sensitive for the same
 * reason: ordinary prose quoting the tag is vanishingly rare, and the cost of a
 * false positive is a marked, countable omission — never a silent rewrite of
 * history, the original bytes stay in the session log). The unclosed-tail form
 * `[\s\S]*?(</system-reminder>|$)` mirrors the tape's masking of truncated
 * injections.
 */
const REMINDER_SPAN = /<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g

/** Strip every injected span from a message's text; deterministic, idempotent
 * (the marker we emit below cannot re-trigger this rule). */
export function stripReminderSpans(text: string): { text: string; removedChars: number } {
  const removed = text.match(REMINDER_SPAN)?.join('').length ?? 0
  if (removed === 0) return { text, removedChars: 0 }
  return { text: text.replace(REMINDER_SPAN, '').trim(), removedChars: removed }
}

/** The visible, greppable, countable marker an omission leaves behind. One
 * shape for every class so downstream assertions (and the sentinel integration
 * test) pin a single prefix. */
export const omittedMarker = (what: string, chars: number): string =>
  `⟦omitted:host-injected ${what}, ${chars} chars — project state, not conversation⟧`

/**
 * The single screen the renderer and anything else consuming conversation text
 * should use: what survives as chapter text, and what was omitted (event-level
 * for non-human sources, span-level inside otherwise-human messages).
 */
export interface Screened {
  /** Conversation text to render (human messages: span-stripped; non-human: ''). */
  text: string
  /** True when the whole event is injected context (non-human source). */
  omittedEvent: boolean
  /** Character count removed by this screen (event-level OR span-level). */
  removedChars: number
  /** Source label for the event (for the marker + tests). */
  sourceKind: string
}

export function screenConversation(data: Record<string, unknown>, rawText: string, role: 'user' | 'assistant'): Screened {
  if (role === 'user' && !isHumanAuthored(data)) {
    return { text: '', omittedEvent: true, removedChars: rawText.length, sourceKind: sourceLabel(data) }
  }
  // Assistant text is model output, but a runtime snapshot has been observed
  // appended to role user|system by the harness — screening assistant spans
  // too costs one regex and can only ever mark, never invent, text.
  const { text, removedChars } = stripReminderSpans(rawText)
  return { text, omittedEvent: false, removedChars, sourceKind: 'user' }
}
