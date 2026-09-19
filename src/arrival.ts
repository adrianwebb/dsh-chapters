/**
 * Arrival-time artifacting (record architecture.md amendment, 2026-09-19):
 * tool results at or above the floor never get to become context. The blob
 * goes to the content-addressed artifact store; the surface node is replaced
 * IN PLACE (the pruner's proven single-node form: a shadowing event + a
 * replacement append carrying `surfaceOp: replace`) with a stub that cites
 * the path and the query tool. Runs at the head of compactIfNeeded/compactNow,
 * i.e. inside the awaited `agent/pre-step` chain, BEFORE the next request is
 * composed — so the blob is prefilled zero times, ever.
 *
 * A plain factory over structural shims, per house rule (the r28 lesson:
 * the LOGIC must be L0-testable against the real host Session shape).
 */
import { artifactPath, sha256 } from './render.ts'
import fs from 'node:fs/promises'
import path from 'node:path'

export interface ArrivalSessionShim {
  surface: { nodes: number[] }
  eventAt(seq: number): { type: string; data: unknown } | undefined | null
  append(type: string, data: unknown, opts?: unknown): unknown
}

export const ARRIVAL_MARKER = '[dsh:artifact'

export interface ArrivalOpts {
  cwd: string
  storeRoot: string
  floorTokens: number
  /** message → estimated tokens (host tokenMeter injected; tests use chars/4). */
  estimate: (message: unknown) => number
}

export interface ArrivalResult {
  stubbed: number
  detail?: string
}

const kb = (n: number): string => n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`

export async function applyArrivalStubs(session: ArrivalSessionShim, opts: ArrivalOpts): Promise<ArrivalResult> {
  let stubbed = 0
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq)
    if (event?.type !== 'tool/result') continue
    const data = event.data as {
      message: { content?: { type?: string; text?: string }[] } & Record<string, unknown>
    } | undefined
    if (data?.message === undefined) continue
    // REAL shape (measured e2e, 2026-09-19): message.content blocks are
    // { type: 'tool-result', toolCallId, isError, content: [{type:'text',text}] }
    // — the text is nested one level below the wrapper. A unit fixture that
    // invented a flat shape hid this for a whole run; the fake mirrors the
    // real from now on.
    const blocks = Array.isArray(data.message.content) ? data.message.content : []
    const wrappers = blocks.filter((b: any) => b.type === 'tool-result')
    if (wrappers.length === 0) continue
    const textOf = (w: any): string => Array.isArray(w.content)
      ? w.content.filter((c: any) => c.type === 'text').map((c: any) => c.text ?? '').join('')
      : typeof w.content === 'string' ? w.content : ''
    const text = wrappers.map(textOf).join('')
    if (text.length === 0 || text.includes(ARRIVAL_MARKER)) continue
    const tokens = opts.estimate(data.message)
    if (tokens < opts.floorTokens) continue
    const hash = sha256(text)
    const rel = artifactPath(hash)
    const abs = path.join(opts.cwd, opts.storeRoot, rel)
    try {
      await fs.mkdir(path.dirname(abs), { recursive: true, mode: 0o700 })
      // content-addressed: rewriting identical bytes is a no-op by definition
      await fs.writeFile(abs, text, 'utf8')
    } catch (error) {
      // the blob stays inline — arrival artifacting is an optimization, and a
      // disk problem must never eat the conversation (loud via detail).
      return { stubbed, detail: `artifact write failed (${String((error as Error)?.message ?? error)}); ${stubbed} node(s) stubbed before the failure` }
    }
    const stub = `${ARRIVAL_MARKER} ${hash.slice(0, 12)}] ${kb(text.length)} ≈ ${tokens} tok stored at ${rel} — query it with chapters_artifact (path '${rel}' or the sha): action 'toc' for the heading map with line numbers, 'search' for term hits as small blocks, 'read' for exact line ranges. The full result is NOT elsewhere in this context; re-running the original tool only recreates it.`
    const stubbedWrappers = wrappers.map((w: any, i: number) => ({
      ...w, content: [{ type: 'text', text: i === 0 ? stub : '' }],
    }))
    const message = {
      ...data.message,
      content: [...blocks.filter((b: any) => b.type !== 'tool-result'), ...stubbedWrappers],
    }
    try {
      session.append('compaction/prune', {
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount: tokens,
        by: 'dsh-chapters-arrival',
      })
      session.append('tool/result', { ...data, message }, {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
        sourceEventSeqs: [seq],
      })
      stubbed++
    } catch (error) {
      return { stubbed, detail: `surface replace refused at seq ${seq} (${String((error as Error)?.message ?? error)})` }
    }
  }
  return { stubbed }
}
