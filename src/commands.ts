/**
 * Host-side slash commands for the knowledge layer (knowledge-repo.md §5, §2).
 * Both render as command flow nodes — verified to stay OUT of the model's
 * context (record §7.2: in-session UX, zero context cost).
 *
 *   /chapters-link <remote-url> [token]   link this project to a knowledge repo
 *   /chapters-status                       where the mirror stands
 */
import path from 'node:path'
import { resolveProject } from './repo.ts'
import {
  DEFAULT_CLONE_DIR, readSyncStatus, readToken, runSync, writeToken,
  type ProjectRecord, type SyncScheduler,
} from './sync.ts'
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

function runSyncDirect(storeRoot: string, cwd: string, record: ProjectRecord, token: string | undefined) {
  return runSync({
    cwd,
    storeRoot,
    cloneDir: DEFAULT_CLONE_DIR,
    project: record,
    ...(token !== undefined ? { token } : {}),
    force: true,
  })
}

export function registerHostCommands(
  ctx: ToolsCtx,
  domain: DomainLike,
  config: HostCommandsConfig,
): () => void {
  const commands = ctx.get?.('commands') as CommandsService
  const disposers: (() => void)[] = []
  if (commands?.register === undefined) return () => {}

  const linkCommand = {
    name: 'chapters-link',
    description: 'Link this project to a shared knowledge repository: /chapters-link <remote-url> [token]',
    input: { hint: '<remote-url> [token]' },
    async handler(invocation: { agent: unknown; rawInput?: string }): Promise<CommandResult> {
      const parts = (invocation.rawInput ?? '').trim().split(/\s+/).filter((p) => p.length > 0)
      if (parts.length < 1 || !/^https?:\/\//.test(parts[0]!)) {
        return { kind: 'error', text: 'usage: /chapters-link <https-remote-url> [token] — the remote must be a private repo you created (record §2.1).' }
      }
      const url = parts[0]!
      const token = parts[1]
      const cwd = cwdOf(invocation.agent)
      try {
        const resolved = resolveProject(cwd, undefined, url)
        const record: ProjectRecord = {
          projectKey: resolved.projectKey,
          slug: (resolved.remote === null ? path.basename(cwd) : resolved.remote.split('/').pop() ?? 'project').replace(/\.git$/, ''),
          remote: url,
          harnessId: config.harnessId,
          linkedAt: new Date().toISOString(),
          cwd,
        }
        if (token !== undefined) writeToken(cwd, config.artifactStoreRoot, record.projectKey, token)
        const table = domain.table('projects')
        table.put(record.projectKey, record)
        const storedToken = readToken(cwd, config.artifactStoreRoot, record.projectKey)
        const sync = config.scheduler !== undefined
          ? await config.scheduler.run(cwd, 'link')
          : await runSyncDirect(config.artifactStoreRoot, cwd, record, storedToken)
        const state = sync.ok
          ? `Linked. Mirror synced: ${sync.steps.join(' \u2192 ')}`
          : `Linked (saved). Sync in ${sync.mode === 'local-only' ? 'LOCAL-ONLY mode' : 'failed state'}: ${sync.detail}`
        return {
          kind: 'success',
          text: `${state}\nProject key: ${record.projectKey}${token === undefined ? '\nNo token given — push will fail on a private remote until /chapters-link is re-run with one (stored 0600 at .dsh-chapters/.git-auth/).' : ''}`,
        }
      } catch (error) {
        return { kind: 'error', text: `chapters-link failed: ${String((error as Error)?.message ?? error)}`.slice(0, 300) }
      }
    },
  }

  const statusCommand = {
    name: 'chapters-status',
    description: 'Show the knowledge-repo mirror status for this project.',
    input: { hint: '' },
    async handler(invocation: { agent: unknown; rawInput?: string }): Promise<CommandResult> {
      const cwd = cwdOf(invocation.agent)
      const table = domain.table('projects')
      let project: ProjectRecord | undefined
      for (const [, rec] of table.entries()) {
        if (cwd === rec.cwd || cwd.startsWith(rec.cwd + path.sep) || cwd.startsWith(rec.cwd + '/')) {
          if (project === undefined || rec.cwd.length > project.cwd.length) project = rec
        }
      }
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
    ctx.logger?.warn?.(`dsh-chapters: host command registration failed (${String(error)})`)
  }
  return () => { for (const d of disposers) d() }
}
