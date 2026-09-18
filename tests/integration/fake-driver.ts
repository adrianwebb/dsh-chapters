/**
 * A fake GitDriver for sync-loop tests. isomorphic-git 1.42 registers only
 * http/https transports (no file:// — verified against its transport
 * registry), so an end-to-end local remote over the REAL driver is not
 * possible without a smart-HTTP server. The fake models exactly the
 * semantics the sync loop relies on: clone snapshots the remote, pull
 * fast-forwards (or disjoint-merges append-only content), push rejects
 * when the remote moved — so the loop's pull→commit→push order and its
 * retry-on-reject behavior are what these tests exercise.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { GitDriver, GitOpResult, RemoteSpec, CommitAuthor } from '../../src/gitops.ts'

export interface FakeRemote {
  files: Map<string, string>
}

export const makeFakeRemote = (): FakeRemote => ({ files: new Map() })

const readJson = (p: string, fallback: unknown): unknown => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fallback }
}
const walk = (dir: string): string[] => {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  const rec = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name.startsWith('.')) continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) rec(p, rel === '' ? e.name : path.join(rel, e.name))
      else out.push(rel === '' ? e.name : path.join(rel, e.name))
    }
  }
  rec(dir, '')
  return out
}

export const makeFakeDriver = (remote: FakeRemote): GitDriver => {
  const baseFile = (dir: string) => path.join(dir, '.git', 'base-remote')
  const localFile = (dir: string) => path.join(dir, '.git', 'local-commits')
  const baseOf = (dir: string): string[] => readJson(baseFile(dir), []) as string[]
  const localOf = (dir: string): string[] => readJson(localFile(dir), []) as string[]
  const isRepo = (dir: string) => fs.existsSync(path.join(dir, '.git', 'HEAD'))
  return {
    async ensureClone(dir: string, _remote: RemoteSpec, _opts?): Promise<GitOpResult> {
      if (isRepo(dir)) return { ok: true, detail: 'already a repo' }
      const files = walk(dir)
      if (files.length > 0) return { ok: false, detail: 'not empty, not a repo' }
      fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
      fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref')
      for (const [name, content] of remote.files) {
        const p = path.join(dir, name)
        fs.mkdirSync(path.dirname(p), { recursive: true })
        fs.writeFileSync(p, content)
      }
      fs.writeFileSync(baseFile(dir), JSON.stringify([...remote.files.keys()].sort()))
      fs.writeFileSync(localFile(dir), '[]')
      return { ok: true, detail: 'cloned', changed: true }
    },
    async stageAllAndCommit(dir: string, _message: string, _author: CommitAuthor): Promise<GitOpResult> {
      if (!isRepo(dir)) return { ok: false, detail: 'not a repo' }
      const changed: string[] = []
      for (const name of walk(dir)) {
        const content = fs.readFileSync(path.join(dir, name), 'utf8')
        const remoteContent = remote.files.get(name)
        if (remoteContent === undefined || remoteContent !== content) changed.push(name)
      }
      const prior = new Set(localOf(dir))
      const now = [...new Set([...prior, ...changed])]
      const grown = now.length > prior.size
      fs.writeFileSync(localFile(dir), JSON.stringify(now))
      return grown
        ? { ok: true, detail: `committed ${changed.length} path(s)`, changed: true }
        : { ok: true, detail: 'nothing to commit' }
    },
    async pullFastForward(dir: string, _remote: RemoteSpec, _opts?): Promise<GitOpResult> {
      if (!isRepo(dir)) return { ok: false, detail: 'not a repo' }
      const base = baseOf(dir)
      const remoteNames = [...remote.files.keys()].sort()
      const newRemote = remoteNames.filter((n) => !base.includes(n))
      if (newRemote.length === 0) return { ok: true, detail: 'up to date (nothing to fast-forward)' }
      const local = new Set(localOf(dir))
      const overlap = newRemote.filter((n) => local.has(n))
      if (overlap.length > 0) {
        const conflicted = overlap.filter((n) => remote.files.get(n) !== fs.readFileSync(path.join(dir, n), 'utf8'))
        if (conflicted.length > 0) {
          return { ok: false, detail: `diverged on owned file(s) ${conflicted.join(', ')} — inspect the mirror` }
        }
      }
      for (const n of newRemote) {
        const p = path.join(dir, n)
        fs.mkdirSync(path.dirname(p), { recursive: true })
        fs.writeFileSync(p, remote.files.get(n)!)
      }
      fs.writeFileSync(baseFile(dir), JSON.stringify(remoteNames))
      return { ok: true, detail: overlap.length > 0 ? 'merged disjoint content' : 'fast-forwarded', changed: true }
    },
    async push(dir: string, _remote: RemoteSpec, _opts?): Promise<GitOpResult> {
      if (!isRepo(dir)) return { ok: false, detail: 'not a repo' }
      const base = baseOf(dir)
      const local = localOf(dir)
      if (local.length === 0) return { ok: true, detail: 'pushed (nothing new)' }
      const remoteAhead = [...remote.files.keys()].filter((n) => !base.includes(n) && !local.includes(n))
      if (remoteAhead.length > 0) {
        return { ok: false, detail: 'push rejected (remote is ahead) — pull-and-retry' }
      }
      for (const n of local) {
        remote.files.set(n, fs.readFileSync(path.join(dir, n), 'utf8'))
      }
      fs.writeFileSync(baseFile(dir), JSON.stringify([...remote.files.keys()].sort()))
      fs.writeFileSync(localFile(dir), '[]')
      return { ok: true, detail: `pushed (${local.length} path(s))`, changed: true }
    },
  }
}
