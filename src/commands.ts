/**
 * Host-side slash commands for the knowledge layer (knowledge-repo.md §5, §2).
 * Both render as command flow nodes — verified to stay OUT of the model's
 * context (record §7.2: in-session UX, zero context cost).
 *
 *   /chapters-link                              show upstream + mirror status
 *   /chapters-link <local-path>                 bind a path upstream (no creds)
 *   /chapters-link <https-url> <token>          bind a network upstream
 *   /chapters-status                            last sync result
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_CLONE_DIR, planStoreToRepo, projectForCwd, readSyncStatus, readToken, runSync, writeToken,
  type ProjectRecord, type SyncScheduler,
} from './sync.ts'
import { isLocalUpstreamUrl, readOrigin, resolveLocalUpstreamPath } from './gitops.ts'
import { projectKeyFromRemote, resolveProject } from './repo.ts'
import type { DomainLike } from './store.ts'
import type { ToolsCtx } from './tools.ts'

export interface HostCommandsConfig {
  artifactStoreRoot: string
  harnessId: string
  /** The sync scheduler to arm after a link (record §5). */
  scheduler?: SyncScheduler
}

type CommandResult = { kind: 'success'; text?: string } | { kind: 'error'; text: string }
type CommandsService = { register?: (def: unknown) => (() => void) | unknown } | undefined

const cwdOf = (agent: unknown): string =>
  ((agent as { session?: { header?: { cwd?: string } } })?.session?.header?.cwd ?? process.cwd())


/** branch name (or short oid) the mirror's HEAD points at. */
function readMirrorHead(mirrorAbs: string): string | null {
  try {
    const head = fs.readFileSync(path.join(mirrorAbs, '.git', 'HEAD'), 'utf8').trim()
    const m = /^ref: refs\/heads\/(.+)$/.exec(head)
    return m?.[1] ?? head.slice(0, 8)
  } catch { return null }
}

/** store files not yet present in the mirror (the honest pending-push view). */
function countPending(mirrorAbs: string, storeDir: string, projectKey: string): number {
  try {
    return planStoreToRepo(storeDir, projectKey).filter((f) => !fs.existsSync(path.join(mirrorAbs, f.rel))).length
  } catch { return -1 }
}

export function registerHostCommands(
  ctx: ToolsCtx,
  domain: DomainLike,
  config: HostCommandsConfig,
): () => void {
  const commands = ctx.get?.('commands') as CommandsService
  const disposers: (() => void)[] = []
  if (commands?.register === undefined) return () => {}

  /**
   * /chapters-link — the upstream configuration surface, three modes:
   *   (no args)      show the current upstream + mirror state (git-status-like)
   *   <local-path>   bind the pool to a directory upstream (bare repo created
   *                  on demand; no credentials — §2.1's local upstreams)
   *   <url> <token>  bind to an http(s) upstream; the token is REQUIRED unless
   *                  the host is loopback, and is stored in the DSH home, 0600
   */
  const linkCommand = {
    name: 'chapters-link',
    description: 'Show / set this project\u2019s knowledge upstream: /chapters-link [path | <https-url> <token>]',
    input: { hint: '[path | <https-remote-url> <token>]' },
    async handler(invocation: { agent: unknown; rawInput?: string }): Promise<CommandResult> {
      const parts = (invocation.rawInput ?? '').trim().split(/\s+/).filter((p) => p.length > 0)
      const cwd = cwdOf(invocation.agent)
      const table = domain.table('projects')
      try {
        // ---- mode 1: no args — the git-status-like view
        if (parts.length === 0) {
          const rec = projectForCwd(table.entries(), cwd)
          if (rec === undefined) {
            return { kind: 'success', text: 'Upstream: none — this workspace is knowledge-local (chapters, forks, signatures all work; nothing syncs).\nSet one: /chapters-link <path> or /chapters-link <https-url> <token>' }
          }
          const mirrorAbs = path.join(cwd, DEFAULT_CLONE_DIR)
          const head = readMirrorHead(mirrorAbs)
          const origin = readOrigin(mirrorAbs)
          const status = readSyncStatus(cwd, config.artifactStoreRoot)
          const pending = countPending(mirrorAbs, path.join(cwd, config.artifactStoreRoot), rec.projectKey)
          const hasToken = readToken(cwd, config.artifactStoreRoot, rec.projectKey) !== undefined
          const local = isLocalUpstreamUrl(rec.remote)
          const lines = [
            `Upstream: ${rec.remote}`,
            `Bound:    ${rec.slug} \u00B7 key ${rec.projectKey} \u00B7 since ${rec.linkedAt}`,
            `Mirror:   ${fs.existsSync(mirrorAbs) ? DEFAULT_CLONE_DIR : '(not created yet)'}  branch ${head ?? 'main'}` + (origin !== null && origin !== (local ? resolveLocalUpstreamPath(rec.remote, cwd) : rec.remote) ? `  [origin drift: ${origin} \u2014 will rebuild]` : ''),
            `Sync:     ${status === null ? 'never run' : `${status.mode} @ ${status.at}`}${status !== null && !status.lastOk ? ` \u2014 ${status.detail}` : ''}`,
            `Pending:  ${pending} file(s) not yet mirrored${hasToken || local ? '' : '  \u26A0 no credentials \u2014 /chapters-link <url> <token>'}`,
            `Harness:  ${rec.harnessId}`,
          ]
          return { kind: 'success', text: lines.join('\n') }
        }

        // ---- mode 2: local-path upstream
        const target = parts[0]!
        if (!/^https?:\/\//.test(target) && (target.startsWith('/') || target === '~' || target.startsWith('~/') || target.startsWith('./') || target.startsWith('../') || /^file:\/\/\//.test(target))) {
          const resolved = resolveLocalUpstreamPath(target, cwd)
          const record: ProjectRecord = {
            projectKey: projectKeyFromRemote(`file://${resolved}`),
            slug: path.basename(resolved).replace(/\.git$/, ''),
            remote: resolved,
            harnessId: config.harnessId,
            linkedAt: new Date().toISOString(),
            cwd,
          }
          table.put(record.projectKey, record)
          const sync = await syncNow(cwd, record, undefined)
          return { kind: 'success', text: `Linked to local upstream ${resolved} (a bare pool repo is created there if absent; no credentials needed).\nKey: ${record.projectKey}\nSync: ${sync.mode} \u2014 ${sync.steps.join(' \u2192 ') || sync.detail}` }
        }

        // ---- mode 3: https upstream — token required unless loopback
        if (!/^https?:\/\//.test(target)) {
          return { kind: 'error', text: 'usage: /chapters-link [<local-path> | <https-url> <token>] \u2014 (no args shows the current upstream)' }
        }
        const token = parts[1]
        const host = (() => { try { return new URL(target).hostname } catch { return '' } })()
        const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
        if (token === undefined && !loopback) {
          return { kind: 'error', text: 'A credential is required for a network upstream: /chapters-link <url> <token> (stored 0600 under the DSH home \u2014 never in the project). Local paths need none: /chapters-link ./vendor/kb.git' }
        }
        const resolved = resolveProject(cwd, undefined, target)
        const record: ProjectRecord = {
          projectKey: resolved.projectKey,
          slug: (resolved.remote ?? target).split('/').pop()!.replace(/\.git$/, ''),
          remote: target,
          harnessId: config.harnessId,
          linkedAt: new Date().toISOString(),
          cwd,
        }
        if (token !== undefined) writeToken(record.projectKey, token)
        table.put(record.projectKey, record)
        const sync = await syncNow(cwd, record, token ?? readToken(cwd, config.artifactStoreRoot, record.projectKey))
        const hint = sync.ok || sync.mode === 'local-only'
          ? ''
          : '\nThe upstream may not exist yet \u2014 create the private repo (GitHub creates one on push for a suitably-scoped token), or point at a local path: /chapters-link ./vendor/kb.git'
        return { kind: 'success', text: `Linked to ${target}.\nKey: ${record.projectKey}${token === undefined ? '\n(no credentials: loopback upstream)' : '\nCredentials stored (DSH home, 0600).'}\nSync: ${sync.mode} \u2014 ${sync.steps.join(' \u2192 ') || sync.detail}${hint}` }
      } catch (error) {
        return { kind: 'error', text: `chapters-link failed: ${String((error as Error)?.message ?? error)}`.slice(0, 300) }
      }
    },
  }

  /** one immediate sync pass for a fresh record (explicit project wins). */
  async function syncNow(cwd: string, record: ProjectRecord, token: string | undefined | null) {
    if (config.scheduler !== undefined) return config.scheduler.run(cwd, 'link', record)
    return runSync({
      cwd, storeRoot: config.artifactStoreRoot, cloneDir: DEFAULT_CLONE_DIR,
      project: record, ...(token !== undefined && token !== null ? { token } : {}),
      force: true,
    })
  }

  const statusCommand = {
    name: 'chapters-status',
    description: 'Show the knowledge-repo mirror status for this project.',
    input: { hint: '[prints project, remote, and last sync result]' },
    async handler(invocation: { agent: unknown; rawInput?: string }): Promise<CommandResult> {
      const cwd = cwdOf(invocation.agent)
      const project = projectForCwd(domain.table('projects').entries(), cwd)
      const status = readSyncStatus(cwd, config.artifactStoreRoot)
      if (project === undefined && status === null) {
        return { kind: 'success', text: 'No knowledge repository is linked yet. Link one with /chapters-link <https-remote-url> [token].' }
      }
      const lines: string[] = []
      if (project !== undefined) {
        const pending = config.scheduler?.hasPending(cwd) === true
        lines.push(`Project: ${project.slug} \u00B7 key ${project.projectKey}`)
        lines.push(`Remote: ${project.remote}`)
        lines.push(pending ? 'Sync: a push is pending (debounced)' : `Sync: ${status?.mode ?? 'never run'}${pending ? '' : ''}`)
      }
      if (status !== null) {
        lines.push(`Last sync: ${status.at} \u2014 ${status.lastOk ? 'synced' : `${status.mode ?? 'local-only'}: ${status.detail}`}`)
        lines.push(`  ${(status.steps ?? []).join(' \u2192 ')}`)
      }
      return { kind: 'success', text: lines.join('\n') }
    },
  }

  try {
    const d1 = commands.register(linkCommand)
    if (typeof d1 === 'function') disposers.push(d1 as () => void)
    const d2 = commands.register(statusCommand)
    if (typeof d2 === 'function') disposers.push(d2 as () => void)
  } catch (error) {
    // LOUD on the operator's console too — a swallowed register error here is
    // how r35g's silent command-absence cost an extra boot to diagnose.
    const message = `dsh-chapters: host command registration failed (${String(error)})`
    ctx.logger?.warn?.(message)
    console.error(message)
  }
  return () => { for (const d of disposers) d() }
}
