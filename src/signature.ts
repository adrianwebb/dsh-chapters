/**
 * Per-turn deterministic signatures (knowledge-repo.md §4.1).
 *
 * Extracted at `turn/end`, synchronously, with no model: file paths, command
 * argv, and a stopword-filtered keyword top-N — the "loud signatures" coding
 * sessions leave behind. The composition step (src/compose.ts) merges
 * consecutive collections by signature overlap; the async model enrichment
 * (P2) may later relabel, never replace, what this produces at archive time.
 *
 * Pure module: SessionEventLike in, `CollectionSignature` out. The engine
 * listener (src/engine.ts) is the only thing that calls this per session.
 */
import { estimateTokens } from './render.ts'
import type { SessionEventLike } from './types.ts'

export interface CollectionSignature {
  /** The collection's event seqs, ascending (user messages through turn/end). */
  seqs: number[]
  /** File paths mentioned in tool-call arguments — the strongest topic signal. */
  paths: string[]
  /** Command argv prefixes (shell tools) and non-shell tool names. */
  commands: string[]
  /** Stopword-filtered keyword top-N across the turn's text. */
  terms: string[]
  /** Estimated tokens of the collection's text (chars/4 — the project's one estimator). */
  size: number
  /** Always `deterministic` today; P2 enrichment adds model-authored fields elsewhere. */
  by: 'deterministic'
}

/** Stoplist: English function words + code scaffolding that carries no topic. */
const STOP = new Set([
  'the','a','an','and','or','of','to','in','on','for','with','is','are','was','were','be','been','being',
  'it','its','this','that','these','those','i','we','you','he','she','they','him','her','them','his','their','our','your','my','me','us',
  'as','at','by','do','does','did','done','will','would','can','could','should','shall','may','might','must',
  'just','also','then','than','so','if','else','not','no','yes','but','all','any','each','more','most','some','such','only','own','same','too','very',
  'about','into','over','under','again','further','once','here','there','when','where','why','how','what','which','who','whom',
  'get','got','let','make','made','use','used','using','run','ran','need','needs','want','wants','look','looked','see','saw','take','took','give','gave',
  'const','let','var','function','return','import','from','export','async','await','new','class','type','interface','extends','implements',
  'true','false','null','undefined','void','number','string','boolean','any','never','unknown','this','self','that','then','else','elif','while','for','do','try','catch','finally','throw','raise','def','fn','pub','use','match','end','begin',
  'file','line','code','test','tests','error','warning','info','note','fix','add','added','remove','removed','update','updated','change','changed','create','created','delete','deleted','set','get','list','show','print','echo','cd','ls','cp','mv','rm','cat','git','npm','npx','node','python','bash','sh','cd','mkdir','touch','grep','sed','awk',
])

const PATH_TOKEN = /((?:[A-Za-z0-9_.\-]+\/)+[A-Za-z0-9_.\-]+|\.{1,2}\/[A-Za-z0-9_.\-\/]+|[A-Za-z0-9_\-]+\.(?:ts|tsx|js|jsx|py|md|json|ya?ml|toml|sh|go|rs|c|cc|cpp|h|java|css|html|lock|txt|env|cfg|ini))/g
const SHELL_TOOLS = new Set(['bash', 'shell', 'exec', 'run_command', 'execute', 'command', 'run'])

/**
 * The events of the turn that just ended: from (exclusive) the previous
 * `turn/end` (or the log start) through this `turn/end` inclusive.
 */
export function turnSpanOf(events: readonly SessionEventLike[], endSeq: number): SessionEventLike[] {
  const idx = events.findIndex((e) => e.type === 'turn/end' && e.seq === endSeq)
  if (idx === -1) return []
  let start = 0
  for (let i = idx - 1; i >= 0; i -= 1) {
    if (events[i]!.type === 'turn/end') { start = events[i]!.seq + 1; break }
  }
  return events.filter((e) => e.seq >= start && e.seq <= endSeq)
}

const textBlocks = (data: Record<string, unknown>): string => {
  const message = (data.message ?? data) as Record<string, unknown>
  const content = Array.isArray(message.content) ? message.content as { type?: string; text?: string }[] : []
  return content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
}

/** Extract the deterministic signature for one completed turn's events. */
export function extractSignature(events: readonly SessionEventLike[], topTerms = 8): CollectionSignature {
  const seqs = events.map((e) => e.seq).sort((a, b) => a - b)
  const paths: string[] = []
  const commands: string[] = []
  const push = (arr: string[], v: string) => { if (v !== '' && !arr.includes(v)) arr.push(v) }

  let size = 0
  const termCounts = new Map<string, number>()
  for (const ev of events) {
    const data = (ev.data ?? {}) as Record<string, unknown>
    if (ev.type === 'user/message' || ev.type === 'assistant/message') {
      const text = textBlocks(data)
      size += estimateTokens(text)
      // Paths mentioned in PROSE are task signal too ("fix src/auth/x.ts") —
      // same extractor as tool args, unioned.
      for (const m of text.matchAll(PATH_TOKEN)) push(paths, m[1]!)
      for (const tok of text.toLowerCase().split(/[^a-z0-9_]+/)) {
        if (tok.length < 3 || tok.length > 28 || STOP.has(tok) || /^\d+$/.test(tok)) continue
        termCounts.set(tok, (termCounts.get(tok) ?? 0) + 1)
      }
    } else if (ev.type === 'tool/call') {
      const name = String(data.name ?? '')
      const args = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {})
      size += estimateTokens(args)
      for (const m of args.matchAll(PATH_TOKEN)) push(paths, m[1]!)
      if (SHELL_TOOLS.has(name.toLowerCase())) {
        // argv prefix: first three non-flag tokens of the command string
        const argv = args.replace(/^["'\s]+|["'\s]+$/g, '').split(/\s+/).filter((t) => !t.startsWith('-')).slice(0, 3)
        if (argv.length > 0) push(commands, argv.join(' '))
      } else if (name !== '') {
        push(commands, name)
      }
    }
  }
  const terms = [...termCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topTerms)
    .map(([t]) => t)

  return { seqs, paths, commands, terms, size, by: 'deterministic' }
}
