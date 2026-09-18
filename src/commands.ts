/**
 * Host-side slash commands for the knowledge layer (knowledge-repo.md §5, §2).
 * Both render as command flow nodes — verified to stay OUT of the model's
 * context (record §7.2: in-session UX, zero context cost).
 *
 *   /chapters-link <remote-url> [token]   link this project to a knowledge repo
 *   /chapters-status                       where the mirror stands
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { resolveProject } from './repo.ts'
import { readSyncStatus, runSync, type ProjectRecord } from './sync.ts'
import type { DomainLike } from './store.ts'
import type { ToolsCtx } from './tools.ts'

export interface HostCommandsConfig {
  artifactStoreRoot: string
  harnessId: string
}

type CommandResult = { kind: 'success'; text?: string } | { kind: 'error'; text: string }
type CommandsService = { register?: (def: unknown) => (() => void) | unknown } | undefined

const cwdOf = (agent: unknown): string =>
  ((agent as { session?: { header?: { cwd?: string } } })?.session?.header?.cwd ?? process.cwd())

const tokenPath = (cwd: string, storeRoot: string, projectKey: string): string =>
  path.join(cwd, storeRoot, '.git-auth', projectKey)

function readToken(cwd: string, storeRoot: string, projectKey: string): string | undefined {
  try {
    const raw = fs.readFileSync(tokenPath(cwd, storeRoot, projectKey), 'utf8').trim()
    return raw.length > 0 ? raw : undefined
  } catch {
    return undefined
  }
}

function writeToken(cwd: string, storeRoot: string, projectKey: string, token: string): void {
  const p = tokenPath(cwd, storeRoot, projectKey)
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
  fs.writeFileSync(p, token + '\n', { mode: 0o600 })
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
          slug: resolved.remote === null ? path.basename(cwd) : resolved.remote.split('/').pop() ?? 'project',
          remote: url,
          harnessId: config.harnessId,
          linkedAt: new Date().toISOString(),
          cwd,
        }
        if (token !== undefined) writeToken(cwd, config.artifactStoreRoot, record.projectKey, token)
        const table = domain.table('projects')
        table.put(record.projectKey, record)
        const storedToken = readToken(cwd, config.artifactStoreRoot, record.projectKey)
        const sync = await runSync({
          cwd,
          storeRoot: config.artifactStoreRoot,
          cloneDir: '.dsh-knowledge',
          project: record,
          ...(storedToken !== undefined ? { token: storedToken } : {}),
        })
        const state = sync.ok
          ? `Linked. Mirror synced: ${sync.steps.join(' → ')}`
          : `Linked, but the first sync did not complete (the link is saved; the next archive retries): ${sync.detail}`
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
      for (const [key, rec] of table.entries()) {
        if (resolveProject(cwd, key, rec.remote).projectKey === key || true) { project = rec; break }
      }
      const status = readSyncStatus(cwd, config.artifactStoreRoot)
      if (project === undefined && status === null) {
        return { kind: 'success', text: 'No knowledge repository is linked yet. Link one with /chapters-link <https-remote-url> [token].' }
      }
      const lines: string[] = []
      if (project !== undefined) lines.push(`Project: ${project.slug} · key ${project.projectKey}`)
      if (status !== null) {
        lines.push(`Last sync: ${status.at} — ${status.lastOk ? 'OK' : 'FAILED'}`)
        lines.push(`  ${status.steps.join(' → ') || status.detail}`)
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
