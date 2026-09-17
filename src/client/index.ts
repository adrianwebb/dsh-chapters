/**
 * dsh-chapters client entry: the per-message fork action.
 *
 * Registers one button into the assistant action row
 * (`conversation.chat.assistant-actions` — the slot the official feedback
 * package populates beside copy/branch). Clicking it executes `/chapters-fork`
 * through `remote.commands` — the exact wire the composer's input line rides —
 * then SWITCHES the app to the fresh branch:
 *
 *   1. `sessions.open(child)` — the client sessions service carries open() on
 *      its prototype (Playwright-verified against this host; a keys-dump alone
 *      hid it, which is why an earlier round wrongly gave up on this path);
 *   2. fallback: click the branch's sidebar row after expanding collapsed
 *      groups (plugin children can render under collapsed 'Ungrouped' heads);
 *   3. last resort: an inline note — the branch is durable either way.
 *
 * There is deliberately NO second implementation of fork logic here: the
 * button is a mouth for the host command (watermark, segmentation, budget,
 * titles, refusal-with-numbers all server-side, all tested). The purity gate
 * in tsdown.client.config.ts keeps this file cross-plugin-free.
 *
 * @module dsh-chapters/src/client
 */

import { createElement as h, useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
// The host's own tooltip bubble — a platform module served by the loader table,
// external like react. Every action in this row labels through it.
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'

/** Structural slice of the aggregated remote service (@deepseek-ai/dsh-api-remotes).
 * `remote.commands` must ALSO appear in inject — the federation gates each
 * sub-service individually (the live feedback package declares
 * remote.messageFeedback beside remote for exactly this reason). */
interface ClientRemote {
  commands?: {
    execute(sessionId: string, line: string, attachments: readonly unknown[]): Promise<{
      ok?: boolean
      value?: { commandId?: string; result?: { kind?: string; text?: string } }
      error?: { code?: string; message?: string }
    }>
  }
}

interface ClientSlots {
  inject(name: string, factory: () => unknown): void
  register(registration: Record<string, unknown>, component: unknown): unknown
}

/** The client sessions service (dsh-client-runtime): open() lives on the
 * prototype; everything else on the surface stays untrusted and unused. */
interface ClientSessions {
  open(sessionId: string): unknown
}

interface Ctx {
  slots: ClientSlots
  get(name: string): unknown
}

export const inject = ['slots', 'remote', 'remote.commands', 'sessions'] as const

/** Pull the child id and branch title out of the command's durable texts. */
const CHILD_ID = /is session (ch-[\w-]+)/
const BRANCH_TITLE = /branch \u201C([^\u201D]+)\u201D is session/

function openByService(sessions: ClientSessions | undefined, sessionId: string): Promise<boolean> {
  return (async () => {
    const svc = sessions as unknown as { open?: (id: string) => unknown; refresh?: () => unknown } | undefined
    if (typeof svc?.open !== 'function') return false
    try { await svc.refresh?.() } catch { /* refresh best-effort */ }
    // The store must know the session before open() resolves it; a child
    // created seconds ago is only server-known until refresh lands. Retry
    // open briefly across that window.
    const started = Date.now()
    for (;;) {
      try { svc.open(sessionId); return true } catch {
        if (Date.now() - started > 4_000) return false
        await new Promise((r) => setTimeout(r, 250))
      }
    }
  })()
}

/**
 * Fallback path: expand collapsed groups / show-more buttons, then click the
 * newest treeitem whose label contains the branch title (newest-updated sorts
 * first, so the first match is the fresh branch).
 */
async function openBranchRow(title: string, budgetMs = 4_000): Promise<boolean> {
  if (typeof document === 'undefined') return false
  const needle = title.toLowerCase()
  const tryClick = (): boolean => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"]'))
    const hit = rows.find((row) => (row.textContent ?? '').toLowerCase().includes(needle))
    if (hit === undefined) return false
    hit.click()
    return true
  }
  const clickMore = (): number => {
    const buttons = Array.from(document.querySelectorAll<HTMLElement>('button'))
      .filter((b) => /more sessions|ungrouped/i.test(b.textContent ?? '') && b.getAttribute('aria-expanded') !== 'true')
    for (const b of buttons) b.click()
    return buttons.length
  }
  const started = Date.now()
  let expansions = 0
  while (Date.now() - started < budgetMs) {
    if (tryClick()) return true
    if (expansions < 4 && clickMore() > 0) { expansions += 1; await new Promise((r) => setTimeout(r, 250)); continue }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return tryClick()
}

function makeForker(remote: ClientRemote, sessions: ClientSessions | undefined) {
  return async function fork(sessionId: string): Promise<{ ok: boolean; message: string }> {
    try {
      if (remote.commands?.execute === undefined) return { ok: false, message: 'commands remote unavailable' }
      const res = await remote.commands.execute(sessionId, '/chapters-fork', [])
      if (res.ok !== true) return { ok: false, message: (res.error?.message ?? 'the fork call failed').slice(0, 90) }
      const result = res.value?.result
      const text = typeof result?.text === 'string' ? result.text : ''
      if (result?.kind !== 'success') return { ok: false, message: (text || 'the fork was refused — see the command result').slice(0, 90) }
      const child = CHILD_ID.exec(text)?.[1]
      if (child === undefined) return { ok: true, message: 'forked — the branch is appearing in the sidebar' }
      const opened = await openByService(sessions, child)
      if (opened) return { ok: true, message: '' }
      const title = BRANCH_TITLE.exec(text)?.[1]
      if (title !== undefined && await openBranchRow(title)) return { ok: true, message: '' }
      return { ok: true, message: 'forked — open the branch in the sidebar' }
    } catch (error) {
      return { ok: false, message: String((error as Error)?.message ?? error).slice(0, 90) }
    }
  }
}

/** Props composed by the slot framework: owner (`messageId`) + our injected verb. */
interface ForkActionProps {
  messageId: string
  fork: () => Promise<{ ok: boolean; message: string }>
}

/**
 * Style parity with the native IconActions row: rules copied verbatim from the
 * host's MessageIconActions module (`._xzv4MW_action` in dsh-client-ui-chat's
 * compiled client + the feedback package's :disabled) — same metrics, tokens,
 * hover. Update this string if the host restyles its action row.
 *
 * The final rule hides the native branch action IN THE MESSAGE ROW only
 * (user-approved cosmetic decision, docs/architecture.md): built-in chrome, so
 * the selector is its accessible label scoped to action-row buttons; both
 * locale spellings covered. If the host rewords the label the button simply
 * reappears — fails open, visibly.
 */
const CSS = [
  '.dsh-chapters_forkAction{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:28px;justify-content:center;align-items:center;padding:6px;display:inline-flex}',
  '.dsh-chapters_forkAction svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}',
  '.dsh-chapters_forkAction:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
  '.dsh-chapters_forkAction:disabled{cursor:default;opacity:.4}',
  '.dsh-chapters_forkNote{color:var(--dsw-alias-label-tertiary);padding-left:4px;font-size:13px;line-height:20px}',
  'button[class*="_action"][aria-label="Branch into a new conversation"],button[class*="_action"][aria-label="\u5728\u65b0\u5bf9\u8bdd\u4e2d\u5206\u652f"]{display:none !important}',
].join('\n')
const CSS_TAG_ID = 'dsh-chapters/assistant-action.css'

function injectStyles(): void {
  try {
    if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG_ID)}]`) !== null) return
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-chapters'
    tag.dataset.pluginCss = CSS_TAG_ID
    tag.textContent = CSS
    document.head.appendChild(tag)
  } catch { /* styling is cosmetic; the action still works without it */ }
}

function ChaptersForkAction({ fork }: ForkActionProps) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  const onClick = useCallback(() => {
    if (busy) return
    setBusy(true)
    setNote(null)
    void fork().then((result) => {
      if (!alive.current) return
      setBusy(false)
      setNote(result.message === '' ? null : result.message)
      setTimeout(() => { if (alive.current) setNote(null) }, 8000)
    })
  }, [busy, fork])
  const button = h('button', {
    type: 'button',
    'aria-label': 'Fork with chapters',
    disabled: busy,
    onClick,
    className: 'dsh-chapters_forkAction',
  },
    h('svg', { viewBox: '0 0 16 16', width: '15', height: '15', fill: 'currentColor', 'aria-hidden': 'true' },
      h('path', { d: 'M5 3.25a2.25 2.25 0 1 0-1.5 2.12v5.26a2.25 2.25 0 1 0 1.5 0V9h5a2.25 2.25 0 0 0 2.25-2.25v-1.4a2.25 2.25 0 1 0-1.5 0v1.4A.75.75 0 0 1 10 7.5H5V5.37A2.25 2.25 0 0 0 5 3.25Z' })))
  return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } },
    h(Tooltip, { label: 'Fork with chapters', side: 'bottom' as const, children: button as ReactElement<Record<string, unknown>> }),
    note !== null
      ? h('span', { className: 'dsh-chapters_forkNote' }, note)
      : null)
}

export function apply(ctx: Ctx): void {
  injectStyles()
  const slots = ctx.slots
  const remote = (ctx.get('remote') ?? {}) as ClientRemote
  let sessions: ClientSessions | undefined
  try { sessions = ctx.get('sessions') as ClientSessions | undefined } catch { sessions = undefined }
  // No early return on missing descriptors: the button registers regardless
  // and the click reports the gap. A missing button is worse than a button
  // that explains itself.
  const fork = makeForker(remote, sessions)
  slots.inject('conversation.chat.assistant-actions', () => slots.register({
    name: 'conversation.chat.assistant-actions',
    id: 'chapters-fork',
    order: 30,
    inject: (sessionId: string) => ({ fork: () => fork(sessionId) }),
  }, ChaptersForkAction))
}
