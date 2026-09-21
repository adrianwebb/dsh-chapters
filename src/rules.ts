/**
 * P3 — rules are chapters of a different kind (record §7.1): same file
 * format, same sync, searched like anything else; this module adds ONLY the
 * lifecycle-shaped parts:
 *
 *   - the rule file (written ONCE, status: proposed, immutable thereafter),
 *   - the per-machine status resolution (§15 amendment 2026-09-20): effective
 *     status comes from the APPROVING MACHINE's own curation facts
 *     (edits/<harnessId>/curation.jsonl, `rule-status` entries), never from a
 *     file rewrite — authorship stays partitioned, and a rule proposed on one
 *     machine affects no other machine's notice until a human there approves,
 *   - the notice section (§7.3): core rules verbatim + a category index,
 *     budgeted, refuse-with-numbers on overflow, and — load-bearing for the
 *     tape corpus — BYTE-IDENTICAL NOTHING when there are no rules: an empty
 *     project renders no section at all.
 */
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { estimateTokens, sha256 } from './render.ts'
import { parseCuration } from './indexing.ts'
import { parseChapterFile } from './enrich-store.ts'

export const RULE_STATUS = ['proposed', 'core', 'revoked'] as const
export type RuleStatus = (typeof RULE_STATUS)[number]

export interface RuleRecord {
  id: string // '<harnessId>/<NNN>' — globally unique, human-typable tail
  projectKey: string
  number: number
  path: string // workspace-relative authored path
  category: string
  title: string
  sourceSession: string
  at: string
}

export const ruleRecordSchema = z.object({
  id: z.string().min(3),
  projectKey: z.string().min(1),
  number: z.number().int().positive(),
  path: z.string().min(1),
  category: z.string().min(1),
  title: z.string(),
  sourceSession: z.string(),
  at: z.string(),
})

export const ruleSlug = (category: string, title: string): string => {
  const s = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return `${s(category) || 'rule'}-${s(title) || 'untitled'}`
}

export const rulePath = (storeRoot: string, harnessId: string, number: number, category: string, title: string): string =>
  path.posix.join(storeRoot, 'rules', harnessId, `${String(number).padStart(3, '0')}-${ruleSlug(category, title)}.md`)

/** one write, ever: rules are proposed by their author and never rewritten (status rides facts) */
export function renderRuleFile(input: {
  number: number
  category: string
  title: string
  sourceSession: string
  at: string
  body: string
}): string {
  return [
    '---',
    `number: ${input.number}`,
    'kind: rule',
    `category: ${JSON.stringify(input.category)}`,
    `title: ${JSON.stringify(input.title)}`,
    'status: proposed',
    `sourceSession: ${JSON.stringify(input.sourceSession)}`,
    `authoredAt: ${JSON.stringify(input.at)}`,
    `sha256: ${sha256(input.body)}`,
    '---',
    input.body,
  ].join('\n')
}

export interface ParsedRule {
  number: number
  category: string
  title: string
  fileStatus: RuleStatus
  sourceSession: string
  body: string
}

export function parseRuleFile(text: string): ParsedRule | null {
  try {
    const doc = parseChapterFile(text)
    const fm = new Map<string, string>()
    for (const line of doc.fmLines) {
      const m = /^([A-Za-z][\w]*):\s*(.*)$/.exec(line)
      if (m !== null) fm.set(m[1]!, m[2]!.trim())
    }
    if (fm.get('kind') !== 'rule') return null
    const unq = (v: string | undefined, d: string): string => (v ?? d).replace(/^"|"$/g, '')
    const rawStatus = unq(fm.get('status'), 'proposed')
    return {
      number: Number(fm.get('number') ?? '0'),
      category: unq(fm.get('category'), 'general'),
      title: unq(fm.get('title'), ''),
      fileStatus: (RULE_STATUS as readonly string[]).includes(rawStatus) ? rawStatus as RuleStatus : 'proposed',
      sourceSession: unq(fm.get('sourceSession'), ''),
      body: doc.body,
    }
  } catch {
    return null
  }
}

export interface RuleStatusFact {
  rule: string
  status: RuleStatus
  at: string
}

/** the machine's own facts, last-write-wins per rule (append-only file order) */
export function loadRuleStatusFacts(mirrorDir: string, harnessId: string): Map<string, RuleStatusFact> {
  const out = new Map<string, RuleStatusFact>()
  const file = path.join(mirrorDir, 'edits', harnessId, 'curation.jsonl')
  if (!fs.existsSync(file)) return out
  for (const f of parseCuration(fs.readFileSync(file, 'utf8'))) {
    if (f.type !== 'rule-status') continue
    const f2 = f as unknown as { rule?: string; status?: string; at?: string }
    if (typeof f2.rule !== 'string' || typeof f2.status !== 'string') continue
    if (!(RULE_STATUS as readonly string[]).includes(f2.status)) continue
    out.set(f2.rule, { rule: f2.rule, status: f2.status as RuleStatus, at: f2.at ?? '' })
  }
  return out
}

/** append-only, like every other curation write */
export function appendRuleStatusFact(mirrorDir: string, harnessId: string, fact: RuleStatusFact): void {
  const dir = path.join(mirrorDir, 'edits', harnessId)
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(path.join(dir, 'curation.jsonl'), JSON.stringify({ type: 'rule-status', ...fact }) + '\n')
}

export function effectiveStatus(ruleId: string, facts: Map<string, RuleStatusFact>, fileStatus: RuleStatus): RuleStatus {
  return facts.get(ruleId)?.status ?? fileStatus
}

export interface MirrorRule {
  id: string // '<harness>/<NNN>' as authored
  relPath: string
  status: RuleStatus
  category: string
  title: string
  body: string
  bodyTokens: number
}

/** every rule file the mirror knows for one project, with THIS machine's effective status */
export function collectMirrorRules(mirrorDir: string, projectKey: string, harnessId: string): MirrorRule[] {
  const root = path.join(mirrorDir, 'rules', projectKey)
  if (!fs.existsSync(root)) return []
  const facts = loadRuleStatusFacts(mirrorDir, harnessId)
  const out: MirrorRule[] = []
  const walk = (dir: string, rel: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p, rel === '' ? e.name : path.join(rel, e.name)); continue }
      if (!e.name.endsWith('.md')) continue
      const relPath = path.posix.join('rules', projectKey, rel === '' ? e.name : `${rel}/${e.name}`)
      const rule = parseRuleFile(fs.readFileSync(p, 'utf8'))
      if (rule === null) continue
      const harness = e.name === '' ? harnessId : path.basename(path.dirname(p))
      const id = `${harness}/${String(rule.number).padStart(3, '0')}`
      const status = effectiveStatus(id, facts, rule.fileStatus)
      out.push({ id, relPath, status, category: rule.category, title: rule.title, body: rule.body.trim(), bodyTokens: estimateTokens(rule.body.trim()) })
    }
  }
  walk(root, '')
  return out.sort((a, b) => a.category < b.category ? -1 : a.category > b.category ? 1 : a.id < b.id ? -1 : 1)
}

export type RulesSectionResult =
  | { kind: 'none' }
  | { kind: 'ok'; text: string; tokens: number }
  | { kind: 'refusal'; reason: string; perRule: Array<{ id: string; tokens: number }>; cap: number; total: number }

/**
 * §7.3: the notice's rules block. `kind: 'none'` (empty rules or no corpus)
 * MUST produce zero injected bytes at the call site — the existing tape
 * corpus depends on it. Overflow refuses with per-rule numbers, never clips.
 */
export function buildRulesSection(
  mirrorDir: string,
  opts: { projectKey: string; harnessId: string; budgetTokens: number },
): RulesSectionResult {
  const rules = collectMirrorRules(mirrorDir, opts.projectKey, opts.harnessId)
  const core = rules.filter((r) => r.status === 'core')
  const categories = new Map<string, { count: number; essence: string; samplePath: string }>()
  for (const r of rules) {
    if (r.status === 'revoked') continue
    const prev = categories.get(r.category)
    categories.set(r.category, {
      count: (prev?.count ?? 0) + 1,
      essence: prev?.essence ?? r.title,
      samplePath: prev?.samplePath ?? r.relPath,
    })
  }
  if (core.length === 0 && categories.size === 0) return { kind: 'none' }
  const lines: string[] = []
  if (core.length > 0) {
    lines.push('## CORE RULES (approved for this project — follow them)')
    let total = 0
    for (const r of core) total += r.bodyTokens
    if (total > opts.budgetTokens) {
      return {
        kind: 'refusal',
        reason: `core rules exceed their budget: ${total} tokens over a cap of ${opts.budgetTokens}. Revoke one ("/chapters-rule revoke <id>") or split a category — the notice never clips rules.`,
        perRule: core.map((r) => ({ id: r.id, tokens: r.bodyTokens })),
        cap: opts.budgetTokens,
        total,
      }
    }
    for (const r of core) lines.push(`[${r.id}] (${r.category}) ${r.body}`, '')
  }
  if (categories.size > 0) {
    lines.push('Rule categories (load a category from the repo when this session\u2019s topics overlap it):')
    for (const [cat, m] of [...categories.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
      lines.push(`- ${cat} (${m.count}): ${m.essence} — e.g. ${m.samplePath}`)
    }
  }
  const text = lines.join('\n').trimEnd()
  return { kind: 'ok', text, tokens: estimateTokens(text) }
}
