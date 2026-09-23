/**
 * Host-side slash commands for the knowledge layer (knowledge-repo.md §5, §2).
 * Both render as command flow nodes — verified to stay OUT of the model's
 * context (record §7.2: in-session UX, zero context cost).
 *
 *   /chapters-link                              show upstream + mirror status
 *   /chapters-link <local-path>                 bind a path upstream (no creds)
 *   /chapters-link <https-url> <token>          bind a network git upstream
 *   /chapters-link treedx+<url>/<repo> <token>  bind a TreeDX service upstream
 *   /chapters-status                            last sync result
 *   /chapters-enrich run | model … | report     P2 enrichment surface (record §6.2)
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_CLONE_DIR, planStoreToRepo, projectForCwd, readSyncStatus, readToken, runSync, writeToken,
  type ProjectRecord, type SyncScheduler,
} from './sync.ts'
import { isLocalUpstreamUrl, readOrigin, resolveLocalUpstreamPath } from './gitops.ts'
import { parseKnowledgeRemote, projectKeyForTarget, projectKeyFromRemote, resolveProject } from './repo.ts'
import { createTreeDxClient } from './treedx/client.ts'
import { resolveRepoId } from './treedx/provider.ts'
import { readState } from './treedx/state.ts'
import { selectProvider } from './provider.ts'
import type { DomainLike } from './store.ts'
import type { ToolsCtx } from './tools.ts'

/** Structural slice of EnrichWiring the commands need (keeps queue types out). */
export interface EnrichCommandSurface {
  runNow(cwd?: string): Promise<{ processed: number; remaining: number }>
  setModelOverride(v: string | null): Promise<void>
  modelOverride(): string | null
  statusLine(): string
  pendingCount(): Promise<number>
}

export interface HostCommandsConfig {
  artifactStoreRoot: string
  harnessId: string
  /** The sync scheduler to arm after a link (record §5). */
  scheduler?: SyncScheduler
  /** P2 enrichment command surface (host plane; manual-drain semantics). */
  enrich?: EnrichCommandSurface
  /** P3 rule lifecycle family, bound to a workspace (S2 module underneath). */
  rules?: (cwd: string, args: string) => Promise<{ kind: 'success' | 'error'; text: string }>
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
    description: 'Show / set this project\u2019s knowledge upstream: /chapters-link [path | <https-url> <token> | treedx+<url>/<repo> <token>]',
    input: { hint: '[path | <https-remote-url> <token> | treedx+<url>/<repo> <token>]' },
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
          const treedx = (rec.kind ?? 'git') === 'treedx'
          const tstate = treedx ? readState(mirrorAbs) : null
          const head = treedx ? (tstate?.head !== null && tstate?.head !== undefined ? tstate.head.slice(0, 10) : null) : readMirrorHead(mirrorAbs)
          const origin = treedx ? tstate?.origin ?? null : readOrigin(mirrorAbs)
          const status = readSyncStatus(cwd, config.artifactStoreRoot)
          const pending = countPending(mirrorAbs, path.join(cwd, config.artifactStoreRoot), rec.projectKey)
          const hasToken = readToken(cwd, config.artifactStoreRoot, rec.projectKey) !== undefined
          const local = isLocalUpstreamUrl(rec.remote)
          const lines = [
            `Provider: ${rec.kind ?? 'git'}`,
            `Upstream: ${rec.remote}`,
            `Bound:    ${rec.slug} · key ${rec.projectKey} · since ${rec.linkedAt}`,
            `Mirror:   ${fs.existsSync(mirrorAbs) ? DEFAULT_CLONE_DIR : '(not created yet)'}` +
              (treedx ? `  head ${head ?? (tstate === null ? 'not cloned' : 'empty repo')}${tstate?.offline === true ? ' · OFFLINE (push deferred)' : ''}` : `  branch ${head ?? 'main'}`) +
              (origin !== null && origin !== (treedx ? rec.remote : local ? resolveLocalUpstreamPath(rec.remote, cwd) : rec.remote) ? `  [origin drift: ${origin} — will rebuild]` : ''),
            `Sync:     ${status === null ? 'never run' : `${status.mode} @ ${status.at}`}${status !== null && !status.lastOk ? ` — ${status.detail}` : ''}`,
            `Pending:  ${pending} file(s) not yet mirrored${hasToken || local ? '' : '  ⚠ no credentials — /chapters-link ' + (treedx ? 'treedx+<url>/<repo> <token>' : '<url> <token>')}`,
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

        // ---- mode 4: TreeDX service upstream (§15 amendment)
        if (target.startsWith('treedx+')) {
          const parsed = parseKnowledgeRemote(target) // throws on a malformed form — caught below
          const token = parts[1]
          if (token === undefined || token === '') {
            return { kind: 'error', text: 'TreeDX always needs a bearer token: /chapters-link treedx+<url>/<repo> <token> (a local dev container: scripts/treedx-local.sh token mints one)' }
          }
          if (parsed.treedx === undefined) return { kind: 'error', text: 'internal: treedx+ target did not parse to a service target' }
          const client = createTreeDxClient({ baseUrl: parsed.treedx.baseUrl, token, fetchTimeoutMs: 15000 })
          // Resolve-or-create the managed repository — linking is an explicit
          // human act (§2.1), so creating the named pool is in scope here and
          // ONLY here. 409 (exists) is a success path. One shared live-shaped
          // catalog parser with the transport (repoCatalog/resolveRepoId) —
          // the first live run broke precisely on parser drift.
          let repoId = await resolveRepoId(client, parsed.treedx.repoName)
          let resolveNote = ''
          if (repoId === '') {
            const created = await client.post('/api/v1/repos', {
              repositoryName: parsed.treedx.repoName, source: { type: 'empty' }, placement: { mode: 'local' },
            })
            if (!created.ok && created.code !== 'conflict' && created.status !== 409) {
              return { kind: 'error', text: `TreeDX repository '${parsed.treedx.repoName}' not found and create failed (${created.detail}) — check the URL/token or create it server-side.` }
            }
            resolveNote = '\nCreated the managed repository (born with refs/heads/main).'
            repoId = await resolveRepoId(client, parsed.treedx.repoName)
          }
          const record: ProjectRecord = {
            projectKey: projectKeyForTarget(parsed),
            slug: parsed.treedx.repoName,
            remote: target,
            kind: 'treedx',
            ...(repoId !== '' ? { repoId } : {}),
            harnessId: config.harnessId,
            linkedAt: new Date().toISOString(),
            cwd,
          }
          writeToken(record.projectKey, token)
          table.put(record.projectKey, record)
          const sync = await syncNow(cwd, record, token)
          return {
            kind: 'success',
            text: `Linked to TreeDX ${parsed.treedx.baseUrl} repo '${parsed.treedx.repoName}'${repoId !== '' ? ` (${repoId})` : ''}.\nKey: ${record.projectKey}\nCredentials stored (DSH home, 0600).${resolveNote}\nSync: ${sync.mode} — ${sync.steps.join(' → ') || sync.detail}` +
              (sync.ok || sync.mode === 'local-only' ? '' : '\nThe service may be down or the token wrong — /chapters-status carries the detail; nothing else is affected.'),
          }
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
        try { lines.push(`Provider: ${selectProvider(project).describe(project)}`) }
        catch { lines.push('Provider: (kind unrecognized — sync will refuse loudly, nothing silently reroutes)') }
        try { lines.push(`Provider: ${selectProvider(project).describe(project)}`) } catch { /* unregistered kind: the Remote line already names it */ }
        lines.push(pending ? 'Sync: a push is pending (debounced)' : `Sync: ${status?.mode ?? 'never run'}${pending ? '' : ''}`)
      }
      if (status !== null) {
        lines.push(`Last sync: ${status.at} \u2014 ${status.lastOk ? 'synced' : `${status.mode ?? 'local-only'}: ${status.detail}`}`)
        lines.push(`  ${(status.steps ?? []).join(' \u2192 ')}`)
      }
      if (config.enrich !== undefined) lines.push(config.enrich.statusLine())
      return { kind: 'success', text: lines.join('\n') }
    },
  }

  const enrichCommand = {
    name: 'chapters-enrich',
    description: 'P2 chapter enrichment (record \u00A76): run a batch now, set the model, or report pending work.',
    input: { hint: 'run | model <provider/model | clear> | report' },
    async handler(invocation: { agent: unknown; rawInput?: string }): Promise<CommandResult> {
      if (config.enrich === undefined) return { kind: 'error', text: 'enrichment is not wired on this plane' }
      const parts = (invocation.rawInput ?? '').trim().split(/\s+/).filter((p) => p.length > 0)
      const verb = parts[0] ?? 'help'
      try {
        if (verb === 'model') {
          const arg = parts[1]
          if (arg === undefined) {
            const o = config.enrich.modelOverride()
            return { kind: 'success', text: `enrichment model: ${o ?? 'conversation default'}${o === undefined || o === null ? '' : ' (override)'}` }
          }
          await config.enrich.setModelOverride(arg === 'clear' ? null : arg)
          return { kind: 'success', text: arg === 'clear' ? 'enrichment model reset to the conversation default' : `enrichment model set to ${arg} (pending chapters re-qualify under the new key)` }
        }
        if (verb === 'run') {
          const r = await config.enrich.runNow(cwdOf(invocation.agent))
          return { kind: 'success', text: `enrichment: processed ${r.processed} chapter(s); ${r.remaining} pending` }
        }
        if (verb === 'report') {
          return { kind: 'success', text: `${config.enrich.statusLine()}\npending: ${await config.enrich.pendingCount()} chapter(s)` }
        }
        return { kind: 'success', text: 'usage: /chapters-enrich run | model <provider/model | clear> | report' }
      } catch (error) {
        return { kind: 'error', text: `chapters-enrich failed: ${String((error as Error)?.message ?? error).slice(0, 200)}` }
      }
    },
  }

  try {
    const d1 = commands.register(linkCommand)
    if (typeof d1 === 'function') disposers.push(d1 as () => void)
    const d2 = commands.register(statusCommand)
    if (typeof d2 === 'function') disposers.push(d2 as () => void)
    const d3 = commands.register(enrichCommand)
    if (typeof d3 === 'function') disposers.push(d3 as () => void)
    if (config.rules !== undefined) {
      const rulesFn = config.rules
      const rulesCommandDef = {
        name: 'chapters-rule',
        description: 'Project rules (record \u00A77): propose, review, approve per machine, revoke.',
        input: { hint: 'add <category> <text> | list [--all|--proposed|--category <c>] | approve <id> | revoke <id>' },
        async handler(invocation: { agent: unknown; rawInput?: string }): Promise<CommandResult> {
          const r = await rulesFn(cwdOf(invocation.agent), invocation.rawInput ?? '')
          return { kind: r.kind, text: r.text }
        },
      }
      const d4 = commands.register(rulesCommandDef)
      if (typeof d4 === 'function') disposers.push(d4 as () => void)
    }
  } catch (error) {
    // LOUD on the operator's console too — a swallowed register error here is
    // how r35g's silent command-absence cost an extra boot to diagnose.
    const message = `dsh-chapters: host command registration failed (${String(error)})`
    ctx.logger?.warn?.(message)
    console.error(message)
  }
  return () => { for (const d of disposers) d() }
}
