/**
 * Mirror state for the TreeDX transport: `.treedx-state.json` inside the
 * mirror dir. The provider verbs are stateless per call; everything they must
 * remember between verbs (which commit we're based on, which content is
 * already synced, what's staged) lives HERE, in the mirror — because the
 * mirror is transport, and its state file is its equivalent of `.git/`
 * (which the TreeDX provider does not write; the hygiene test's dotfile skip
 * keeps the file out of every commit it participates in).
 *
 * Fields:
 * - origin: the bound treedx+ target (origin-mismatch detection, §3.1/§5.2)
 * - head: the commit sha this mirror's baseline describes; null = empty repo
 * - baseline: path → sha256 of synced content (the ff-only comparison surface)
 * - staged: pending commit (paths → {hash, message}) — stageAllAndCommit
 *   records, push ships (or the diverged-rebuild discards, republishing from
 *   the store, exactly as git mode does)
 * - offline: true after initLocal (push deferred; §5.3)
 */
import fs from 'node:fs'
import path from 'node:path'
import { sha256 } from '../render.ts'

export const STATE_FILE = '.treedx-state.json'

export interface TreedxState {
  origin: string
  head: string | null
  baseline: Record<string, string>
  staged: { message: string; author: { name: string; email: string }; paths: string[] } | null
  offline: boolean
  /** Catalog repo id once resolved (stable even if the name list blips). */
  repoId?: string | undefined
}

export const statePath = (dir: string): string => path.join(dir, STATE_FILE)

export function readState(dir: string): TreedxState | null {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(dir), 'utf8')) as TreedxState
    if (typeof s.origin !== 'string') return null
    return s
  } catch {
    return null
  }
}

export function writeState(dir: string, s: TreedxState): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(statePath(dir), JSON.stringify(s, null, 1))
}

export const contentHash = (bytes: Buffer | string): string =>
  sha256(typeof bytes === 'string' ? bytes : bytes.toString('base64'))

/** True when a buffer round-trips UTF-8 exactly — the file/blob write decision
 * (TreeDX's File API is UTF-8-only; blobs are binary-safe). */
export function isUtf8Safe(buf: Buffer): boolean {
  if (buf.includes(0)) return false
  const t = buf.toString('utf8')
  return Buffer.byteLength(t, 'utf8') === buf.length && Buffer.from(t, 'utf8').equals(buf)
}

/** Walk the mirror's content surface — every file except .git-adjacent dot
 * state (the state file itself, and anything dotted, same rule as git mode). */
export function walkMirror(dir: string, rel = ''): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue
    const r = rel === '' ? e.name : path.posix.join(rel, e.name)
    if (e.isDirectory()) out.push(...walkMirror(dir, r))
    else out.push(r)
  }
  return out.sort()
}
