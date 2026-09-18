/**
 * Chapter renderer: durable events in a seq range → one Markdown file, deterministically.
 *
 * This module is pure and cordis-free. The model never writes chapter text (invariant 4 in AGENTS.md) — it
 * supplies ranges, and every byte of the body comes from the log. So correctness here IS the "retrievable
 * memory" promise.
 *
 * Two hazards this file exists to handle:
 *
 * 1. **Fence collision.** Conversation text routinely contains ``` blocks. A Markdown file that embeds a
 *    triple-backtick fence inside a triple-backtick fence terminates early and silently truncates the rest
 *    of the chapter. `longerFence()` solves this by measuring the longest backtick run in the payload and
 *    using one longer. Verified by test, because the failure is invisible by eye.
 * 2. **Silent holes.** An event that renders to nothing must never vanish quietly — it is recorded in
 *    `stats.unrenderedSeqs` so a gap becomes a visible assertion rather than lost history.
 */
import { createHash } from 'node:crypto'
import { DEFAULT_REDACTIONS, redactText } from './redact.ts'
import type {
  ArtifactRef, ChapterRange, ContentBlock, RenderConfig, RenderedChapter,
  SessionEventLike, ToolResultCandidate, ToolResultOverride,
} from './types.ts'

/** chars/4 until the host tokenMeter is wired in. Labelled an estimate everywhere it surfaces. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

/**
 * A fence strictly longer than any backtick run inside `body`, so embedded code blocks cannot close it.
 * Markdown requires the closing fence to be at least as long as the opening one.
 */
export function longerFence(body: string): string {
  let max = 0
  for (const match of body.matchAll(/`+/g)) max = Math.max(max, match[0].length)
  return '`'.repeat(Math.max(3, max + 1))
}

/** Wrapped in a fence long enough to survive any content, including nested fences. */
export function fenced(content: string, info = ''): string {
  const fence = longerFence(content)
  return `${fence}${info}\n${content}\n${fence}`
}

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** `artifacts/8f/8f3a1c9d….txt` — sharded so one directory never holds the whole subtree. */
export const artifactPath = (hash: string): string => `artifacts/${hash.slice(0, 2)}/${hash}.txt`

export function artifactRef(
  text: string,
  opts: { toolName: string; sourceSeq: number; inlined: boolean },
): ArtifactRef {
  const hash = sha256(text)
  return {
    sha256: hash,
    path: artifactPath(hash),
    bytes: Buffer.byteLength(text, 'utf8'),
    content: text,
    inlined: opts.inlined,
    toolName: opts.toolName,
    sourceSeq: opts.sourceSeq,
  }
}

const blocksOf = (value: unknown): ContentBlock[] =>
  Array.isArray(value) ? value as ContentBlock[] : []

const textOf = (value: unknown): string =>
  blocksOf(value)
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text?: string }).text ?? '')
    .join('\n')

/** Flatten a tool-result payload, which nests a content array inside a tool-result block. */
function toolResultText(data: Record<string, unknown>): string {
  const message = data.message as Record<string, unknown> | undefined
  const inner = blocksOf(message?.content ?? data.content)
  const parts: string[] = []
  for (const block of inner) {
    if (block.type === 'text') parts.push((block as { text?: string }).text ?? '')
    else if (block.type === 'tool-result') {
      const nested = (block as { content?: unknown }).content
      parts.push(typeof nested === 'string' ? nested : textOf(nested))
    }
  }
  return parts.filter((p) => p.length > 0).join('\n')
}

/**
 * Validate model-supplied ranges. Never trust them (hard rule): an overlap duplicates archived text and a
 * gap silently drops history, so both are errors here rather than data that quietly goes missing.
 */
export function validateRanges(
  chapters: ChapterRange[],
  archiveCeiling: number,
): ChapterRange[] {
  if (chapters.length === 0) throw new Error('no chapters supplied')
  chapters.forEach((c, i) => {
    if (c.startSeq > c.endSeq) {
      throw new Error(`chapter ${i} ("${c.title}") has startSeq ${c.startSeq} above endSeq ${c.endSeq}`)
    }
    if (c.endSeq > archiveCeiling) {
      throw new Error(
        `chapter ${i} ("${c.title}") ends at seq ${c.endSeq}, past the archive ceiling ${archiveCeiling}`,
      )
    }
    if (i > 0) {
      const prev = chapters[i - 1]!
      if (c.startSeq <= prev.startSeq) {
        throw new Error(`chapter ${i} ("${c.title}") descends: starts ${c.startSeq} after ${prev.startSeq}`)
      }
      if (c.startSeq <= prev.endSeq) {
        throw new Error(
          `chapter ${i} ("${c.title}") overlaps "${prev.title}": ${c.startSeq}-${prev.endSeq} in both`,
        )
      }
    }
  })
  return chapters
}

/** Enumerate tool results in a range so the model can decide keep/defer against real sizes. */
export function toolResultCandidates(
  events: SessionEventLike[],
  range: ChapterRange,
): ToolResultCandidate[] {
  const out: ToolResultCandidate[] = []
  for (const ev of events) {
    if (ev.type !== 'tool/result' || ev.seq < range.startSeq || ev.seq > range.endSeq) continue
    const text = toolResultText(ev.data ?? {})
    const call = events.find((c) => c.type === 'tool/call' && c.seq < ev.seq && sameCall(c, ev))
    out.push({
      seq: ev.seq,
      toolName: String((call?.data as Record<string, unknown> | undefined)?.name ?? (ev.data as Record<string, unknown> | undefined)?.toolName ?? 'tool'),
      bytes: Buffer.byteLength(text, 'utf8'),
      estimatedTokens: estimateTokens(text),
      excerpt: text.slice(0, 160),
    })
  }
  return out
}

function sameCall(call: SessionEventLike, result: SessionEventLike): boolean {
  const callId = (call.data as Record<string, unknown> | undefined)?.callId
  const message = (result.data as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined
  const source = message?.source as Record<string, unknown> | undefined
  const resultCallId = source?.callId ?? (result.data as Record<string, unknown> | undefined)?.callId
  return callId !== undefined && resultCallId !== undefined && String(callId) === String(resultCallId)
}

const attribution = (data: Record<string, unknown>): string => {
  const source = data.source as Record<string, unknown> | undefined
  if (!source) return ''
  if (source.kind === 'user') return ''
  if (source.kind === 'plugin') return ` [plugin:${String(source.plugin ?? '?')}]`
  if (source.kind === 'tool') return ' [tool]'
  return ` [${String(source.kind ?? 'unknown')}]`
}

/**
 * Render one chapter. `overrides` is the model's sparse exception list; anything not named follows the
 * default rule (small results inline, large ones deferred). Either way the artifact is written, so a wrong
 * call costs a `read` and never loses data.
 */
export function renderChapter(
  events: SessionEventLike[],
  range: ChapterRange,
  config: RenderConfig,
  overrides: readonly ToolResultOverride[] = [],
): RenderedChapter {
  const inline = new Map(overrides.map((o) => [o.seq, o.inline]))
  // render → redact → write: the single chokepoint, so chapters AND the
  // deferred artifact files (whose bodies are the redacted text, via
  // ArtifactRef.content) are covered without caller changes.
  const redact = (t: string): string => redactText(t, config.redactions ?? DEFAULT_REDACTIONS).text
  const inRange = events
    .filter((e) => e.seq >= range.startSeq && e.seq <= range.endSeq)
    .sort((a, b) => a.seq - b.seq)

  const body: string[] = [`# ${range.title}`, '', `> ${range.summary}`, '']
  const artifacts: ArtifactRef[] = []
  const unrenderedSeqs: number[] = []
  let toolCalls = 0
  let inlinedCount = 0
  let deferredCount = 0

  for (const ev of inRange) {
    const data = (ev.data ?? {}) as Record<string, unknown>
    switch (ev.type) {
      case 'user/message': {
        const text = redact(textOf(data.content))
        if (text.length === 0) { unrenderedSeqs.push(ev.seq); break }
        body.push(`**User${attribution(data)}:**`, '', fenced(text), '')
        break
      }
      case 'assistant/message': {
        const message = (data.message ?? data) as Record<string, unknown>
        const text = redact(textOf(message.content))
        const reasoning = redact(blocksOf(message.content)
          .filter((b) => b.type === 'reasoning')
          .map((b) => (b as { text?: string }).text ?? '')
          .join('\n'))
        if (reasoning.length > 0) body.push('<sub>_reasoning:_</sub>', '', fenced(reasoning), '')
        if (text.length > 0) body.push(`**Assistant:**`, '', fenced(text), '')
        else unrenderedSeqs.push(ev.seq)
        break
      }
      case 'tool/call': {
        toolCalls += 1
        const name = String(data.name ?? 'unknown')
        const args = redact(typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {}))
        // Invocations always stay inline: this is the "what was attempted" half of the record.
        body.push(`- ↳ **${name}** \`${args.slice(0, 400)}\`${args.length > 400 ? ' …' : ''} (seq ${ev.seq})`)
        break
      }
      case 'tool/result': {
        const text = redact(toolResultText(data))
        const tokens = estimateTokens(text)
        const wantsInline = inline.get(ev.seq) ?? tokens <= config.toolResultDeferFloorTokens
        const priorCall = [...inRange].reverse().find((c) => c.type === 'tool/call' && c.seq < ev.seq)
        const toolName = String((priorCall?.data as Record<string, unknown> | undefined)?.name ?? 'tool')
        const ref = artifactRef(text, { toolName, sourceSeq: ev.seq, inlined: wantsInline })
        artifacts.push(ref)
        if (wantsInline) {
          inlinedCount += 1
          body.push(`  - result (seq ${ev.seq}, ${ref.bytes} B, also at \`${ref.path}\`):`, '', fenced(text), '')
        } else {
          deferredCount += 1
          body.push(`  - result: ${ref.bytes} B ≈ ${tokens} tok, \`${ref.sha256.slice(0, 7)}…\` → \`${ref.path}\``)
        }
        break
      }
      case 'turn/start':
      case 'turn/end':
      case 'step/start':
      case 'step/end':
        break // lifecycle noise: intentionally absent from the body, ranges still recorded in frontmatter
      default:
        unrenderedSeqs.push(ev.seq)
    }
  }

  const bodyText = body.join('\n')
  const estimatedTokens = estimateTokens(bodyText)
  const frontmatter = [
    '---',
    `title: ${JSON.stringify(range.title)}`,
    `seqRange: [${range.startSeq}, ${range.endSeq}]`,
    `events: ${inRange.length}`,
    `tokens: ${estimatedTokens}  # chars/4 estimate`,
    `sha256: ${sha256(bodyText)}`,
    `artifacts: ${artifacts.length}`,
    `unrenderedSeqs: [${unrenderedSeqs.join(', ')}]`,
    '---',
    '',
  ].join('\n')

  return {
    range,
    markdown: frontmatter + bodyText + '\n',
    artifacts,
    stats: {
      estimatedTokens,
      estimatedBytes: Buffer.byteLength(bodyText, 'utf8'),
      events: inRange.length,
      toolCalls,
      toolResultsInlined: inlinedCount,
      toolResultsDeferred: deferredCount,
      overTarget: estimatedTokens > config.chapterTokenTarget,
      unrenderedSeqs,
    },
  }
}

/**
 * The cumulative index that replaces compacted history. Built from registry records, never from an LLM —
 * which is the entire latency argument: no summarization call, no tokens, no paraphrase.
 */
export function renderIndex(entries: readonly { path: string; title: string; summary: string }[]): string {
  return entries
    .map((e, i) => `${i + 1}. [${e.title}](${e.path}) — ${e.summary}`)
    .join('\n')
}
