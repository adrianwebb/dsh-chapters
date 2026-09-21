/**
 * P3 S2 — the /chapters-rule command family (record §7.2), as a pure-ish
 * module so the lifecycle is testable without a commands service.
 *
 *   /chapters-rule add <category> <text…>
 *   /chapters-rule list [--all | --proposed | --category <c>]
 *   /chapters-rule approve <id> | revoke <id>
 *
 * Identity: '<harnessId>/<NNN>'. Files are write-once; status is a per-machine
 * curation fact (§15 amendment) appended to the mirror's own edits/<harness>/
 * curation.jsonl and pushed immediately (offline-safe: the local commit still
 * happens; push coalesces later). Commands never enter the model context.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  renderRuleFile, rulePath, collectMirrorRules, appendRuleStatusFact,
  type RuleRecord, type RuleStatus,
} from './rules.ts'
import type { ProjectRecord } from './sync.ts'

export interface RulesIo {
  cwd(): string
  storeRoot: string
  harnessId: string
  store: {
    rules(): IterableIterator<[string, RuleRecord]>
    getRule(id: string): RuleRecord | undefined
    putRule(id: string, value: RuleRecord): Promise<void>
  }
  projectFor(cwd: string): ProjectRecord | undefined
  mirrorDir(cwd: string): string
  /** arm an immediate sync so facts and files travel (never throws) */
  syncNow(cwd: string): Promise<void>
  now: () => Date
}

export interface RulesReply { kind: 'success' | 'error'; text: string }

const HELP = 'usage: /chapters-rule add <category> <text> | list [--all|--proposed|--category <c>] | approve <id> | revoke <id>'

export async function rulesCommand(io: RulesIo, args: string): Promise<RulesReply> {
  const parts = args.trim().split(/\s+/).filter((p) => p.length > 0)
  const verb = parts[0] ?? 'help'
  const cwd = io.cwd()
  const project = io.projectFor(cwd)
  if (project === undefined) {
    return { kind: 'error', text: 'no knowledge repository is linked for this workspace — link one with /chapters-link first (rules are shared state)' }
  }
  const mirror = io.mirrorDir(cwd)

  // every rule known to THIS machine: mirror files (all authors) ∪ own domain records (pre-sync)
  const known = () => {
    const byId = new Map<string, { id: string; category: string; title: string; status: RuleStatus; sourceSession: string }>()
    for (const r of collectMirrorRules(mirror, project.projectKey, io.harnessId)) {
      byId.set(r.id, { id: r.id, category: r.category, title: r.title, status: r.status, sourceSession: '' })
    }
    for (const [, rec] of io.store.rules()) {
      if (rec.projectKey !== project.projectKey) continue
      const prev = byId.get(rec.id)
      byId.set(rec.id, { id: rec.id, category: rec.category, title: rec.title, status: prev?.status ?? 'proposed', sourceSession: rec.sourceSession })
    }
    return [...byId.values()].sort((a, b) => a.id < b.id ? -1 : 1)
  }

  if (verb === 'add') {
    const category = parts[1]
    const body = parts.slice(2).join(' ')
    if (category === undefined || body.length < 10) {
      return { kind: 'error', text: `add needs a category and at least a sentence of rule text. ${HELP}` }
    }
    let number = 1
    for (const [id] of io.store.rules()) {
      const m = new RegExp(`^${io.harnessId}/(\\d{3})$`).exec(id)
      if (m !== null) number = Math.max(number, Number(m[1]) + 1)
    }
    const title = body.split(/[.!?\n]/)[0]!.trim().slice(0, 60)
    const rel = rulePath(io.storeRoot, io.harnessId, number, category, title)
    const abs = path.join(cwd, rel)
    if (fs.existsSync(abs)) return { kind: 'error', text: `refusing to overwrite ${rel} (rule files are write-once)` }
    const id = `${io.harnessId}/${String(number).padStart(3, '0')}`
    const rec: RuleRecord = {
      id, projectKey: project.projectKey, number, path: rel,
      category: category.toLowerCase(), title, sourceSession: 'manual', at: io.now().toISOString(),
    }
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, renderRuleFile({ number, category: rec.category, title, sourceSession: rec.sourceSession, at: rec.at, body: body + '\n' }))
      await io.store.putRule(id, rec)
    } catch (error) {
      return { kind: 'error', text: `rule add failed: ${String((error as Error)?.message ?? error).slice(0, 160)}` }
    }
    await io.syncNow(cwd)
    return { kind: 'success', text: `rule ${id} proposed (category ${rec.category}) — approve it into this machine's core set with: /chapters-rule approve ${id}` }
  }

  if (verb === 'list') {
    const all = parts.includes('--all')
    const proposedOnly = parts.includes('--proposed')
    const catIdx = parts.indexOf('--category')
    const cat = catIdx > -1 ? (parts[catIdx + 1] ?? '').toLowerCase() : ''
    let rows = known()
    if (cat !== '') rows = rows.filter((r) => r.category === cat)
    if (!all && !proposedOnly) rows = rows.filter((r) => r.status !== 'revoked')
    if (proposedOnly) rows = rows.filter((r) => r.status === 'proposed')
    if (rows.length === 0) return { kind: 'success', text: 'no rules match' }
    const text = rows.map((r) => `${r.id.padEnd(12)} ${r.status.padEnd(9)} ${r.category.padEnd(14)} ${r.title}`).join('\n')
    return { kind: 'success', text: `id           status    category       title\n${text}` }
  }

  if (verb === 'approve' || verb === 'revoke') {
    let id = parts[1] ?? ''
    if (id === '') return { kind: 'error', text: `${verb} needs a rule id (see /chapters-rule list)` }
    if (!id.includes('/')) id = `${io.harnessId}/${id.padStart(3, '0')}`
    const exists = known().some((r) => r.id === id)
    if (!exists) return { kind: 'error', text: `no rule ${id} in project ${project.slug} — unknown id (list shows what exists)` }
    try {
      // 'approve' is the verb; 'core' is the status — conflating them writes a
// fact no resolver recognizes (caught by unit test)
      appendRuleStatusFact(mirror, io.harnessId, { rule: id, status: verb === 'approve' ? 'core' : 'revoked', at: io.now().toISOString() })
    } catch (error) {
      return { kind: 'error', text: `${verb} failed: ${String((error as Error)?.message ?? error).slice(0, 160)}` }
    }
    await io.syncNow(cwd)
    return { kind: 'success', text: verb === 'approve'
      ? `rule ${id} is CORE on THIS machine (other machines approve independently) — it will render into continuations from this workspace`
      : `rule ${id} revoked on this machine (out of the notice, still in the repo)` }
  }

  return { kind: 'success', text: HELP }
}
