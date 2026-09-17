/**
 * dsh-chapters client entry: the per-message fork action.
 *
 * Registers one button into the assistant action row
 * (`conversation.chat.assistant-actions` — the same slot the official
 * feedback package populates, between copy and the native branch button).
 * Clicking it executes `/chapters-fork` through the CLIENT commands facade —
 * the exact wire path the composer's input line uses for palette commands —
 * then opens the child session the host created once it is addressable.
 *
 * There is deliberately NO second implementation of fork logic here: the
 * button is a mouth for the host command (watermark, segmentation, budget,
 * titles, refusal-with-numbers all server-side, all tested). The purity gate
 * in tsdown.client.config.ts keeps this file cross-plugin-free: structural
 * types only, react from the loader table, cordis services as the sole seam.
 *
 * @module dsh-chapters/src/client
 */

import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'

/** Structural slice of the client commands facade (@deepseek-ai/dsh-client-ui-commands/client). */
interface ClientCommands {
  execute(session: { sessionId: string }, line: string, attachments?: readonly unknown[]): Promise<unknown>
}

/** Structural slice of the client sessions service (dsh-client-runtime/client). */
interface ClientSessions {
  binding(sessionId: string): unknown
  open(sessionId: string): void
}

/** Structural slice of the slots service — the inject wrapper waits on the slot
 * declaration and leaves with this plugin's fiber (the official feedback package
 * registers its actions through exactly this path). */
interface ClientSlots {
  inject(name: string, factory: () => unknown): void
  register(registration: Record<string, unknown>, component: unknown): unknown
}

interface Ctx {
  slots: ClientSlots
  get(name: string): unknown
  effect(dispose: () => void, label: string): void
}

/** Services the client fiber needs; the loader maps these to the injected packages below. */
export const inject = ['slots', 'commands', 'sessions'] as const

/** Pull the child id out of the command's success text (`… is session ch-…`). */
const CHILD_ID_PATTERN = /is session (ch-[\w-]+)/

async function waitForAddressable(sessions: ClientSessions, sessionId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (sessions.binding(sessionId) !== undefined) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return sessions.binding(sessionId) !== undefined
}

function makeForker(commands: ClientCommands, sessions: ClientSessions) {
  return async function fork(sessionId: string): Promise<{ ok: boolean; message: string }> {
    try {
      const executed = await commands.execute({ sessionId }, '/chapters-fork', []) as {
        kind?: string; text?: string
      } | undefined
      const text = typeof executed?.text === 'string' ? executed.text : ''
      if (executed?.kind !== 'success') return { ok: false, message: text || 'the fork was refused — see the command result in the transcript' }
      const child = CHILD_ID_PATTERN.exec(text)?.[1]
      if (child === undefined) return { ok: true, message: 'forked — the branch is appearing in the sidebar' }
      if (await waitForAddressable(sessions, child)) {
        sessions.open(child)
        return { ok: true, message: 'branched — opened' }
      }
      return { ok: true, message: 'forked — open the branch from the sidebar' }
    } catch (error) {
      return { ok: false, message: String((error as Error)?.message ?? error) }
    }
  }
}

/** Props composed by the slot framework: owner (`messageId`) + our injected verb. */
interface ForkActionProps {
  messageId: string
  fork: () => Promise<{ ok: boolean; message: string }>
}

const ICON_BUTTON_STYLE: Record<string, string> = {
  width: 'calc(28px + var(--dsh-content-font-delta, 0px))',
  height: 'calc(28px + var(--dsh-content-font-delta, 0px))',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '6px',
  border: 'none',
  borderRadius: '28px',
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary)',
  cursor: 'pointer',
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
      if (!result.ok || result.message !== 'branched — opened') setNote(result.message)
      setTimeout(() => { if (alive.current) setNote(null) }, 8000)
    })
  }, [busy, fork])
  return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } },
    h('button', {
      type: 'button',
      'aria-label': 'Fork with chapters',
      title: busy ? 'Forking…' : 'Fork this conversation with chapters: archive what is new verbatim, then open a branch whose history is the table of contents',
      disabled: busy,
      onClick,
      style: { ...ICON_BUTTON_STYLE, ...(busy ? { opacity: '0.4', cursor: 'default' } : {}) },
    },
      h('svg', { viewBox: '0 0 16 16', width: '15', height: '15', fill: 'currentColor', 'aria-hidden': 'true' },
        h('path', { d: 'M5 3.25a2.25 2.25 0 1 0-1.5 2.12v5.26a2.25 2.25 0 1 0 1.5 0V9h5a2.25 2.25 0 0 0 2.25-2.25v-1.4a2.25 2.25 0 1 0-1.5 0v1.4A.75.75 0 0 1 10 7.5H5V5.37A2.25 2.25 0 0 0 5 3.25Z' }))),
    note !== null
      ? h('span', { style: { fontSize: '12px', lineHeight: '20px', paddingLeft: '4px', color: 'var(--dsw-alias-label-tertiary)' } }, note)
      : null)
}

export function apply(ctx: Ctx): void {
  const slots = ctx.slots
  const commands = ctx.get('commands') as ClientCommands | undefined
  const sessions = ctx.get('sessions') as ClientSessions | undefined
  // A host without the commands facade (or sessions service) simply shows no
  // button: palette `/chapters-fork` keeps working, exactly like the tools
  // degrade without an agent.
  if (commands === undefined || sessions === undefined) return
  const fork = makeForker(commands, sessions)
  // The inject wrapper gates on ui-chat's slot declaration and unregisters with
  // this plugin's fiber — the pattern the official assistant-actions use.
  slots.inject('conversation.chat.assistant-actions', () => slots.register({
    name: 'conversation.chat.assistant-actions',
    id: 'chapters-fork',
    order: 30,
    inject: (sessionId: string) => ({ fork: () => fork(sessionId) }),
  }, ChaptersForkAction))
}
