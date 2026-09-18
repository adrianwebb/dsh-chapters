/**
 * Pure data types for the chapter archive. No cordis, no DSH imports — this module is what makes the
 * archive unit-testable without booting a harness, which is the whole testing strategy in
 * docs/development.md § Test Layers.
 *
 * Event field names here were taken from real session logs read during Phase 0 (see
 * spikes/probe/FINDINGS.md), not guessed: `user/message` carries `data.{id,role,source,content}` and
 * `tool/call` carries `data.{callId,name,arguments}`. Where the shape is uncertain the renderer degrades
 * rather than throws, because a dropped detail in an archive is worse than an ugly one.
 */

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType?: string; data?: string; path?: string }
  | { type: string; [key: string]: unknown }

export interface SessionEventLike {
  type: string
  seq: number
  time?: number
  surfaceOp?: string
  data?: Record<string, unknown>
}

/** One chapter = a contiguous, closed range of durable event seqs. Integers, never text anchors. */
export interface ChapterRange {
  title: string
  summary: string
  startSeq: number
  endSeq: number
}

/** The model's sparse exceptions about tool results. Absence means "use the default rule". */
export interface ToolResultOverride {
  seq: number
  inline: boolean
}

export interface RenderConfig {
  /** Below this estimated token count a tool result stays inline without needing a model override. */
  toolResultDeferFloorTokens: number
  /** Chapter sizes past this are flagged for a split at the next boundary. Never truncated. */
  chapterTokenTarget: number
  /**
   * Credential redaction patterns applied at the render chokepoint (record §9).
   * Absent → the built-in conservative set. Extensible per deployment.
   */
  redactions?: readonly import('./redact.ts').RedactPattern[]
}

export interface ArtifactRef {
  /** Content hash; the artifact path is derived from it, so identical results dedupe across a subtree. */
  sha256: string
  /** Relative path from the store root, as it will be printed in the chapter and read back. */
  path: string
  bytes: number
  /** The exact bytes to write. Written whether or not the body was also inlined. */
  content: string
  /** True when the chapter body also carries the text, i.e. the model asked to keep it visible. */
  inlined: boolean
  toolName: string
  sourceSeq: number
}

export interface RenderedChapter {
  range: ChapterRange
  /** Full Markdown file body, YAML frontmatter included. */
  markdown: string
  artifacts: ArtifactRef[]
  stats: {
    /** chars/4 estimate until tokenMeter is wired at the host boundary; labelled as an estimate. */
    estimatedTokens: number
    estimatedBytes: number
    events: number
    toolCalls: number
    toolResultsInlined: number
    toolResultsDeferred: number
    /** True when the chapter exceeds chapterTokenTarget — a split signal, never a truncation licence. */
    overTarget: boolean
    /** Events in the range that produced no rendered output, so a silent hole is visible. */
    unrenderedSeqs: number[]
  }
}

/** A candidate tool result, enumerated by the plugin so the model never guesses at sizes. */
export interface ToolResultCandidate {
  seq: number
  toolName: string
  bytes: number
  estimatedTokens: number
  excerpt: string
}

export class RangeError extends Error {
  readonly code: 'overlapping' | 'gap' | 'descending' | 'beyond-ceiling' | 'empty'
  constructor(code: RangeError['code'], message: string) {
    super(message)
    this.code = code
    this.name = 'RangeError'
  }
}
