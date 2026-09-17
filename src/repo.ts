/**
 * Project identity and knowledge-repo layout (knowledge-repo.md §2.2–2.3).
 *
 * Pure module: no cordis, no network, no git binary. `canonicalizeRemote` +
 * UUIDv5 give every machine the SAME key for the same project (local paths
 * differ; the remote is the identity). `.git/config` is parsed as a plain
 * file — the no-git-executable rule (record §3.2) applies to discovery too.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Record §2.3, exact: lowercase; strip `https://` / `ssh://`; convert
 * `user@host:path` → `host/path`; strip trailing `/` and `.git`; KEEP the
 * host (two hosts, same path = different projects).
 */
export function canonicalizeRemote(url: string): string {
  let s = url.trim().toLowerCase()
  s = s.replace(/^(?:https?|ssh|git):\/\//, '')
  // [user@]host:path (scp-style) and [user@]host/path (scheme-form, after the
  // scheme strip above)
  s = s.replace(/^([a-z0-9._-]+)@([a-z0-9.-]+)[:\/](.+)$/, (_m, _user, host, p) => `${host}/${p}`)
  s = s.replace(/^([a-z0-9.-]+):(.+)$/, (_m, host, p) => `${host}/${p}`)
  s = s.replace(/\/+$/, '')
  s = s.replace(/\.git$/, '')
  return s
}

/** UUIDv5(NAMESPACE_OID, name) per RFC 4122 — deterministic, name-derived. */
export const NAMESPACE_OID = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'

export function uuidv5(namespaceUuid: string, name: string): string {
  const ns = namespaceUuid.replace(/-/g, '')
  if (ns.length !== 32) throw new Error(`uuidv5: namespace is not a UUID: ${namespaceUuid}`)
  const b = createHash('sha1').update(Buffer.concat([Buffer.from(ns, 'hex'), Buffer.from(name, 'utf8')])).digest()
  b[6] = (b[6]! & 0x0f) | 0x50 // version 5
  b[8] = (b[8]! & 0x3f) | 0x80 // variant 10xx
  // RFC 4122: the first 16 OCTETS of the SHA-1 (not all 20)
  const h = b.subarray(0, 16).toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** The project key: stable across machines for the same remote (record §2.3). */
export const projectKeyFromRemote = (url: string): string => uuidv5(NAMESPACE_OID, canonicalizeRemote(url))

/**
 * Parse the minimum of a git config we need: the first remote's url,
 * preferring `origin`. Comments (# ;), sections, and whitespace handled;
 * anything exotic returns null rather than guessing.
 */
export function parseGitConfigRemoteUrl(text: string): string | null {
  let section: string | null = null
  let originUrl: string | null = null
  let firstRemoteUrl: string | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line)
    if (sectionMatch !== null) {
      section = sectionMatch[1]!
      continue
    }
    const kv = /^([A-Za-z0-9.]+)\s*=\s*(.+)$/.exec(line)
    if (kv === null || section === null) continue
    if (kv[1]!.toLowerCase() !== 'url') continue
    const value = kv[2]!.trim().replace(/^["']|["']$/g, '')
    const sectionName = section.replace(/^remote\s+"?([^"]+)"?$/i, '$1').toLowerCase()
    if (sectionName === 'origin' && originUrl === null) originUrl = value
    else if (/^remote/.test(section) && firstRemoteUrl === null) firstRemoteUrl = value
  }
  return originUrl ?? firstRemoteUrl
}

export interface ProjectRemote {
  remote: string
  /** `remote` = from a git remote; `path-derived` = non-git workspace fallback. */
  source: 'remote' | 'path-derived'
}

/**
 * Discover the project's remote WITHOUT a git binary: read `.git` as a file
 * or directory, parse its `config` (following a `gitdir:` pointer for
 * worktrees/submodules, relative to `cwd`). Non-git workspace → the
 * path-derived fallback is the CALLER's choice (this returns null), so the
 * key's `source` flag stays an explicit decision.
 */
export function readProjectRemote(cwd: string): ProjectRemote | null {
  const dotGit = path.join(cwd, '.git')
  let configPath: string | null = null
  try {
    const st = fs.statSync(dotGit)
    if (st.isDirectory()) configPath = path.join(dotGit, 'config')
    else if (st.isFile()) {
      const pointer = fs.readFileSync(dotGit, 'utf8').trim()
      const m = /^gitdir:\s*(.+)$/m.exec(pointer)
      if (m !== null) {
        const target = m[1]!.trim()
        configPath = path.isAbsolute(target) ? path.join(target, 'config') : path.join(cwd, target, 'config')
      }
    }
  } catch {
    return null // no .git, unreadable, or not git
  }
  if (configPath === null) return null
  try {
    const url = parseGitConfigRemoteUrl(fs.readFileSync(configPath, 'utf8'))
    if (url === null) return null
    return { remote: url, source: 'remote' }
  } catch {
    return null
  }
}

/** Resolve the project identity: override > discovered remote > path-derived. */
export function resolveProject(cwd: string, overrideKey?: string, overrideRemote?: string): {
  projectKey: string
  projectKeySource: 'override' | 'remote' | 'path-derived'
  remote: string | null
} {
  if (overrideKey !== undefined && overrideKey !== '') {
    return { projectKey: overrideKey, projectKeySource: 'override', remote: overrideRemote ?? null }
  }
  const discovered = overrideRemote !== undefined && overrideRemote !== ''
    ? { remote: overrideRemote, source: 'remote' as const }
    : readProjectRemote(cwd)
  if (discovered !== null) {
    return { projectKey: projectKeyFromRemote(discovered.remote), projectKeySource: discovered.source, remote: discovered.remote }
  }
  return { projectKey: uuidv5(NAMESPACE_OID, cwd), projectKeySource: 'path-derived', remote: null }
}

/** Repo layout (record §2.2) — every path the sync/index/search layers touch. */
export function repoPaths(projectKey: string, harnessId: string, sessionId?: string) {
  const base = ''
  return {
    projectYml: path.join(base, 'project.yml'),
    chaptersDir: sessionId === undefined
      ? path.join(base, 'chapters', projectKey)
      : path.join(base, 'chapters', projectKey, sessionId),
    artifactsDir: path.join(base, 'artifacts', projectKey),
    collectionsFile: (sid: string) => path.join(base, 'collections', projectKey, `${sid}.jsonl`),
    indexDir: path.join(base, 'index'),
    indexManifest: path.join(base, 'index', 'manifest.json'),
    curationFile: path.join(base, 'edits', harnessId, 'curation.jsonl'),
    rulesDir: path.join(base, 'rules', projectKey),
    vocabularyJson: path.join(base, 'topics', 'vocabulary.json'),
  }
}
