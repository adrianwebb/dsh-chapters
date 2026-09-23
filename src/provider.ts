/**
 * Knowledge-transport providers (knowledge-repo.md §3.2, extended by the §15
 * amendment "transport is pluggable; git is one provider").
 *
 * The sync loop's transport surface is exactly six verbs — ensureClone,
 * initLocal, removeMirror, stageAllAndCommit, pullFastForward, push — every one
 * returning `{ok, detail, code?}` because §5.3 makes transport best-effort by
 * rule: a transport failure degrades to local-only, it never throws into a
 * conversation. A `SyncProvider` is those verbs plus an identity: `kind` (what
 * the project record says it is, and what status lines print) and `describe`
 * (one honest line for /chapters-status — e.g. which remote, which head).
 *
 * What a provider is NOT: storage. The workspace store stays the truth in
 * every mode (§3.1); the mirror directory is materialized the same way whether
 * a git clone or a remote API fills it, so search, rules, index build, and the
 * read path never learn who transported the bytes. Adding a backend means
 * implementing these six verbs and registering the kind — nothing else may
 * grow provider-specific branches.
 */
import { isomorphicDriver, type GitDriver } from './gitops.ts'
import type { ProjectRecord } from './sync.ts'

export type ProviderKind = 'git' | 'treedx'

export interface SyncProvider extends GitDriver {
  readonly kind: ProviderKind
  /** One human line describing where this project's transport points. */
  describe(project: ProjectRecord): string
}

/** The default provider: pure-JS git over HTTPS / local paths (record §3.2). */
export const gitProvider: SyncProvider = {
  ...isomorphicDriver,
  kind: 'git',
  describe: (project) => `git · ${project.remote}`,
}

// Registration is a map keyed by kind; Phase C's treedx module adds its entry.
// Kept as a registry (not a switch) so provider selection stays open while
// `kind` stays closed: an unknown kind is a LOUD refusal, never a silent
// fallback to git that would sync someone's chapters into the wrong pool.
const registry = new Map<ProviderKind, SyncProvider>([['git', gitProvider]])

export function registerProvider(provider: SyncProvider): void {
  registry.set(provider.kind, provider)
}

/**
 * Resolve the transport for a project record. `kind` absent = 'git' (every
 * record written before providers existed parses to this default).
 * Throws for an unknown/unregistered kind — callers degrade loudly (§5.3):
 * the sync pass reports local-only with the reason; nothing silently reroutes.
 */
export function selectProvider(project: Pick<ProjectRecord, 'kind' | 'remote'>): SyncProvider {
  const kind = project.kind ?? 'git'
  const provider = registry.get(kind)
  if (provider === undefined) {
    throw new Error(`knowledge provider '${kind}' is not registered (remote ${project.remote})`)
  }
  return provider
}

/**
 * Reconcile a remote target's scheme with the configured `knowledgeProvider`
 * policy ('auto' | 'git' | 'treedx'). A contradiction throws — NOTHING ever
 * silently falls back into a different pool; the caller degrades loudly
 * (auto-link skips + warns; /chapters-link refuses with the message).
 */
export function providerKindFor(targetKind: ProviderKind, policy: string): ProviderKind {
  if (policy === 'auto') return targetKind
  if (policy !== 'git' && policy !== 'treedx') {
    throw new Error(`knowledgeProvider policy '${policy}' is not one of auto | git | treedx`)
  }
  if (policy !== targetKind) {
    throw new Error(`knowledgeProvider policy '${policy}' contradicts the remote target (a ${targetKind} remote) — fix one; there is no automatic fallback`)
  }
  return policy
}
