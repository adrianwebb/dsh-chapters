/**
 * chapters_segment / chapters_continue — tool adapters. Thin by policy: caller
 * resolution, port wiring, refusal mapping. The logic is continue-core.ts and
 * the pure modules; the shapes are the dsh-session-fork idiom (defineTool,
 * jsonOutput, exec.agent, ctx.tools.register), each cited in docs/contract.md.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import { toolResultCandidates } from './render.ts'
import type { ChapterRange, SessionEventLike, ToolResultOverride } from './types.ts'
import { deriveRanges, refusalResult, runContinue, runFork, type BudgetProbe, type ContinueConfig, type ContinuePorts } from './continue-core.ts'
import { makeArchiveFs, type DomainLike, type RegistryStore } from './store.ts'
import type { SessionState } from './registry.ts'

const jsonOutput = <T>(render: (value: T) => string) => ({
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: render(value as T) }],
})

/** The narrow slices of the host services the adapter uses (structural, cordis-free typing). */
export interface ToolsCtx {
  agents: {
    create(opts: Record<string, unknown>): Promise<{ agent: unknown; dispose?: () => Promise<void> | void }>
  }
  get?(name: string): unknown
  sessionProjections?: { stateOf(session: unknown, key: string): unknown }
  llm?: {
    resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ context?: { contextWindow?: number } } | undefined>
  }
  tools: { register(def: unknown): () => void }
  logger?: { info?(m: string): void; warn?(m: string): void }
}

interface CallerAgent {
  session: {
    id: string
    header: { cwd?: string }
    snapshotEvents?(): SessionEventLike[]
    eventAt?(seq: number): SessionEventLike | undefined
  }
  options: { provider?: string; model?: string; reasoningEffort?: string }
}

const CALLER_MISSING = { ok: false as const, reason: 'no calling agent: this tool runs only inside an agent session' }

function callerOf(exec: ToolRunContext): CallerAgent | typeof CALLER_MISSING {
  const agent = (exec as unknown as { agent?: CallerAgent }).agent
  return agent ?? CALLER_MISSING
}

export interface ToolsConfig extends ContinueConfig {}

/** Build the two tool definitions (registration is the caller's lifecycle). */
export function buildChaptersTools(
  ctx: ToolsCtx,
  store: RegistryStore,
  config: ToolsConfig,
): { segment: ReturnType<typeof defineTool>; chaptersContinue: ReturnType<typeof defineTool>; chaptersFork: ReturnType<typeof defineTool>; forkCommand: { name: string; description: string; input: { hint: string }; handler: (invocation: { agent: unknown; rawInput?: string; signal?: AbortSignal }) => Promise<{ kind: 'success'; text?: string } | { kind: 'error'; text: string }> } } {

  const portsFor = async (caller: CallerAgent): Promise<ContinuePorts> => {
    const cwd = caller.session.header.cwd ?? ''
    const presetId = (ctx.sessionProjections?.stateOf(caller.session, 'agentPreset') as string | undefined) ?? null
    return {
      readCallerEvents: async () => [...(caller.session.snapshotEvents?.() ?? [])] as SessionEventLike[],
      getState: (sessionId) => store.get(sessionId),
      putState: (sessionId, state) => store.put(sessionId, state),
      fs: () => {
        if (cwd === '') throw new Error('caller session has no workspace cwd — nowhere reachable for the read tool')
        return makeArchiveFs(cwd)
      },
      budgetProbe: async (): Promise<BudgetProbe> => {
        const { provider, model } = caller.options
        let windowTokens: number | null = null
        if (provider !== undefined && model !== undefined && ctx.llm?.resolveModelInfo !== undefined) {
          try {
            const info = await ctx.llm.resolveModelInfo(provider, model, new AbortController().signal)
            windowTokens = info?.context?.contextWindow ?? null
          } catch { windowTokens = null }
        }
        // Header bound: the last real request's full prompt (usage) — an
        // UPPER bound on header+surface-at-that-time, so it over-counts the
        // header conservatively; refusals err toward the loud side.
        let headerBoundTokens: number | null = null
        const events = caller.session.snapshotEvents?.() ?? []
        for (let i = events.length - 1; i >= 0; i -= 1) {
          const usage = (events[i]!.data as { usage?: { inputTokens?: number; cacheReadTokens?: number } } | undefined)?.usage
          if (usage !== undefined) {
            headerBoundTokens = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0)
            break
          }
        }
        return { windowTokens, headerBoundTokens }
      },
      newId: () => randomUUID(),
      createChild: async ({ sessionId, noticeEvent, presetId: mountPreset, title }) => {
        const callerOptions = caller.options
        const handle = await ctx.agents.create({
          sessionId,
          seed: [noticeEvent],
          inheritedEventCount: 0,
          meta: { cwd, isSeeded: false, ...(mountPreset !== undefined && mountPreset !== null ? { agentPreset: mountPreset } : {}) },
          ...(callerOptions.provider !== undefined ? { agentOptions: callerOptions } : {}),
          setup: async (agentCtx: unknown) => {
            const presets = ctx.get?.('agentPresets') as { mount?: (c: unknown, id: string) => Promise<unknown> } | undefined
            if (presets?.mount === undefined) throw new Error('agentPresets service absent — the child would be tool-less')
            await presets.mount(agentCtx, mountPreset)
          },
        })
        try {
          const workspaceRegistry = ctx.get?.('workspaceRegistry') as { createCanonical?: (cwd: string) => Promise<{ attachSession?: (id: string) => Promise<void> | void } | undefined> } | undefined
          if (cwd !== '' && workspaceRegistry?.createCanonical !== undefined) {
            const workspace = await workspaceRegistry.createCanonical(cwd)
            await workspace?.attachSession?.(sessionId)
          }
        } catch (error) {
          // An unattached child is durable but may not list — say so, keep going.
          ctx.logger?.warn?.(`dsh-chapters: child workspace attach failed (${String(error)})`)
        }
        // Title while the child is still live: sessionController.rename resolves
        // the agent, routes through the official session-title normalizer, and
        // appends the durable `session/title` event (r6: commands-execute was the
        // wrong registry; the service method is the one that sticks). A refusal
        // here is cosmetic — warn, never roll back a durable continuation.
        try {
          const controller = ctx.get?.('sessionController') as
            { rename?: (r: { sessionId: string; title: string }) => Promise<unknown> } | undefined
          if (controller?.rename !== undefined) await controller.rename({ sessionId, title })
          else ctx.logger?.warn?.('dsh-chapters: sessionController absent — child created without a title')
        } catch (error) {
          ctx.logger?.warn?.(`dsh-chapters: child title refused (${String(error)}); child remains untitled`)
        } finally {
          // The live handle is ours only until the child is handed to the user:
          // holding it blocks their resume ("already owned by an active write
          // handle", measured r3). Dispose after the live-work, keep the session.
          await handle.dispose?.()
        }
      },
      now: () => Date.now(),
    }
  }

  // ---------------------------------------------------------------- segment

  const chaptersSegment = defineTool({
    name: 'chapters_segment',
    description:
      'Facts for planning a chapter archive of THIS session: the completed-turn archive ceiling, '
      + 'every tool result with its real size, and the chapters already in the registry. '
      + 'Returns ranges for you to propose in chapters_continue — you never write chapter text; the plugin renders it from the log.',
    parameters: {},
    output: jsonOutput((value: unknown) => JSON.stringify(value, null, 1)),
    async execute(_args: Record<string, never>, exec: ToolRunContext) {
      const caller = callerOf(exec)
      if ('reason' in caller) return { ...CALLER_MISSING }
      const events = caller.session.snapshotEvents?.() ?? []
      const lastTurnEnd = [...events].reverse().find((e) => e.type === 'turn/end')
      if (lastTurnEnd === undefined) return { ok: false, reason: 'no completed turn to archive yet' }
      const ceiling = lastTurnEnd.seq
      const below = events.filter((e) => e.seq <= ceiling)
      const callerState: SessionState = await store.get(caller.session.id)
      return {
        ok: true,
        archiveCeiling: ceiling,
        eventCount: below.length,
        // fresh literals, not the ToolResultCandidate interface: anonymous
        // object types carry the implicit index signature JsonValue needs.
        toolResults: toolResultCandidates(below, { title: '', summary: '', startSeq: 0, endSeq: ceiling })
          .map((c) => ({ seq: c.seq, toolName: c.toolName, bytes: c.bytes, estimatedTokens: c.estimatedTokens, excerpt: c.excerpt })),
        existingChapters: callerState.chapters.map((c) => ({
          number: c.number, path: c.path, title: c.title, startSeq: c.startSeq, endSeq: c.endSeq,
        })),
        budgetHint: { continuationBudgetRatio: config.continuationBudgetRatio, chapterTokenTarget: config.chapterTokenTarget },
      }
    },
  })

  // ---------------------------------------------------------------- continue

  const chaptersContinue = defineTool({
    name: 'chapters_continue',
    description:
      'Archive this conversation as verbatim Markdown chapters and open a NEW session that starts from their '
      + 'table of contents plus your handoff note. Supply event ranges (startSeq/endSeq) — never chapter text; '
      + 'the plugin renders bodies from the session log. This session is left untouched; the child gets its own '
      + 'cache and can reload any chapter with read. Oversized tool results defer to reference files by default; '
      + 'toolResultOverrides marks the exceptions you want kept inline (it still writes the artifact).',
    parameters: {
      title: { type: 'string', required: true, description: 'Name for the continued session.' },
      handoffNote: { type: 'string', required: true, description: 'State of play for the child: what was in progress, decisions held, the next step. Budget-checked as part of the notice, never silently truncated.' },
      chapters: {
        type: 'array',
        required: true,
        description: 'Ascending, non-overlapping ranges covering every event to archive (<= the archiveCeiling from chapters_segment).',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', required: true, description: 'Chapter title (topic-named; it becomes the file slug).' },
            summary: { type: 'string', required: true, description: 'One-line TOC summary of what the chapter holds.' },
            startSeq: { type: 'integer', required: true, description: 'First durable event seq, inclusive.' },
            endSeq: { type: 'integer', required: true, description: 'Last durable event seq, inclusive.' },
          },
        },
      },
      toolResultOverrides: {
        type: 'array',
        description: 'Sparse exceptions to the defer-by-default rule: {seq, inline:true} keeps a large result inline in its chapter (the artifact is still written); {seq, inline:false} trims a small one.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            seq: { type: 'integer', required: true, description: 'The tool result event seq (from chapters_segment toolResults).' },
            inline: { type: 'boolean', required: true, description: 'Keep inline (true) or defer (false), overriding the size default for this one result.' },
          },
        },
      },
    },
    output: jsonOutput((value: unknown) => JSON.stringify(value, null, 1)),
    async execute(
      args: {
        title: string
        handoffNote: string
        chapters: ChapterRange[]
        toolResultOverrides?: ToolResultOverride[]
      },
      exec: ToolRunContext,
    ) {
      const caller = callerOf(exec)
      if ('reason' in caller) return { ...CALLER_MISSING }
      try {
        const ports = await portsFor(caller)
        const result = await runContinue(ports, {
          callerSessionId: caller.session.id,
          callerPreset: (ctx.sessionProjections?.stateOf(caller.session, 'agentPreset') as string | null | undefined) ?? null,
          title: args.title,
          handoffNote: args.handoffNote,
          chapters: args.chapters,
          toolResultOverrides: args.toolResultOverrides ?? [],
        }, config)
        // conditional spreads: absent optionals must not surface as `undefined`
        // (not a JsonValue); the output schema validates the successful body.
        return {
          ok: true as const,
          ...(result.childSessionId !== undefined ? { childSessionId: result.childSessionId } : {}),
          ...(result.presetUsed !== undefined ? { presetUsed: result.presetUsed } : {}),
          ...(result.chapters !== undefined ? { chapters: result.chapters } : {}),
          ...(result.warnings !== undefined && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
          ...(result.budget !== undefined ? { budget: result.budget } : {}),
        }
      } catch (error) {
        const refusal = refusalResult(error)
        if (refusal !== null) {
          return {
            ok: false as const,
            reason: refusal.reason ?? 'refused',
            ...(refusal.budget !== undefined ? { budget: refusal.budget } : {}),
            ...(refusal.warnings !== undefined && refusal.warnings.length > 0 ? { warnings: refusal.warnings } : {}),
          }
        }
        return { ok: false, reason: `chapters_continue failed: ${(error as Error)?.stack ?? String(error)}`.slice(0, 800) }
      }
    },
  })

  // ---------------------------------------------------------------- fork

  const chaptersFork = defineTool({
    name: 'chapters_fork',
    description:
      'Open a SIBLING session citing the same chapter archive this one already has — nothing new is '
      + 'archived, no files written, no numbers spent. Use for trying a genuinely different approach '
      + 'while the current session keeps working. Your handoff note says what the sibling should do.',
    parameters: {
      title: { type: 'string', required: true, description: 'Name for the forked session.' },
      handoffNote: { type: 'string', required: true, description: 'What the sibling is for — its whole context is the archive TOC plus this note.' },
    },
    output: jsonOutput((value: unknown) => JSON.stringify(value, null, 1)),
    async execute(args: { title: string; handoffNote: string }, exec: ToolRunContext) {
      const caller = callerOf(exec)
      if ('reason' in caller) return { ...CALLER_MISSING }
      try {
        const ports = await portsFor(caller)
        const result = await runFork(ports, {
          callerSessionId: caller.session.id,
          callerPreset: (ctx.sessionProjections?.stateOf(caller.session, 'agentPreset') as string | null | undefined) ?? null,
          title: args.title,
          handoffNote: args.handoffNote,
        }, config)
        return {
          ok: true as const,
          ...(result.childSessionId !== undefined ? { childSessionId: result.childSessionId } : {}),
          ...(result.presetUsed !== undefined ? { presetUsed: result.presetUsed } : {}),
          ...(result.budget !== undefined ? { budget: result.budget } : {}),
        }
      } catch (error) {
        const refusal = refusalResult(error)
        if (refusal !== null) {
          return { ok: false as const, reason: refusal.reason ?? 'refused', ...(refusal.budget !== undefined ? { budget: refusal.budget } : {}) }
        }
        return { ok: false as const, reason: `chapters_fork failed: ${(error as Error)?.stack ?? String(error)}`.slice(0, 800) }
      }
    },
  })


  // ---------------------------------------------------------------- command

  // The palette/URL path for the fork BUTTON: same ports as the tools, ZERO
  // model involvement — deriveRanges is deterministic, so a click needs no
  // agent turn and no proposed ranges. `/chapters-fork [title]`: everything
  // up to the last completed turn is archived verbatim and a titled child
  // opens whose entire history is the cumulative TOC.
  const forkCommand = {
    name: 'chapters-fork',
    description: 'Fork this conversation into a new session: archive everything so far into verbatim chapters and open a child whose history is the table of contents. Optional argument: a title for the branch.',
    input: { hint: '[title]' },
    async handler(invocation: { agent: unknown; rawInput?: string; signal?: AbortSignal }): Promise<{ kind: 'success'; text?: string } | { kind: 'error'; text: string }> {
      const agent = invocation.agent as CallerAgent
      if (agent?.session === undefined) return { kind: 'error' as const, text: 'chapters-fork: no session context for this invocation' }
      try {
        const ports = await portsFor(agent)
        const events = await ports.readCallerEvents()
        const anchor = [...events].reverse().find((e) => e.type === 'turn/end')?.seq
        if (anchor === undefined) return { kind: 'error' as const, text: 'chapters-fork: nothing to archive yet — the conversation has no completed turn' }
        const { chapters, notes } = deriveRanges(events, anchor, config.chapterTokenTarget)
        const trimmed = (invocation.rawInput ?? '').trim()
        const parentTitle = [...events].reverse()
          .find((e) => e.type === 'session/title')?.data?.title as string | undefined
        const title = trimmed !== '' ? trimmed : `${parentTitle ?? 'Chapters branch'} \u2014 branch`
        const handoffNote = 'Branched from the conversation through the Chapters fork. The chapters listed above carry every prior word verbatim — reload any with the read tool on its path. No task was handed over with this fork: ask the user what this branch should work on.'
          + (notes.length > 0 ? `\n(Segmentation notes: ${notes.join('; ')})` : '')
        const result = await runContinue(ports, {
          callerSessionId: agent.session.id,
          callerPreset: (ctx.sessionProjections?.stateOf(agent.session, 'agentPreset') as string | null | undefined) ?? null,
          title,
          handoffNote,
          chapters,
          toolResultOverrides: [],
        }, config)
        const budgetText = result.budget !== undefined ? `; TOC ~${result.budget.usedTokens} tokens, allowance ${result.budget.allowanceTokens}` : ''
        return { kind: 'success' as const, text: `Forked: ${chapters.length} chapter(s) archived, branch \u201C${title}\u201D is session ${result.childSessionId ?? '(created)'}${budgetText}. Switch to it from the sidebar — its first message is the table of contents.` }
      } catch (error) {
        const refusal = refusalResult(error)
        if (refusal !== null) {
          const budget = refusal.budget !== undefined ? ` (notice ~${refusal.budget.usedTokens} > allowance ${refusal.budget.allowanceTokens})` : ''
          return { kind: 'error' as const, text: `chapters-fork refused: ${refusal.reason ?? 'refused'}${budget}` }
        }
        return { kind: 'error' as const, text: `chapters-fork failed: ${String((error as Error)?.message ?? error)}`.slice(0, 500) }
      }
    },
  }

  return { segment: chaptersSegment, chaptersContinue, chaptersFork, forkCommand }
}

export function registerChaptersTools(
  ctx: ToolsCtx,
  store: RegistryStore,
  config: ToolsConfig,
): () => void {
  const built = buildChaptersTools(ctx, store, config)
  const disposeSegment = ctx.tools.register(built.segment)
  const disposeContinue = ctx.tools.register(built.chaptersContinue)
  const disposeFork = ctx.tools.register(built.chaptersFork)
  let disposeCommand: (() => void) | null = null
  const commands = ctx.get?.('commands') as { register?: (def: unknown) => (() => void) | unknown } | undefined
  if (commands?.register !== undefined) {
    try {
      const disposer = commands.register(built.forkCommand)
      if (typeof disposer === 'function') disposeCommand = disposer as () => void
    } catch (error) {
      ctx.logger?.warn?.(`dsh-chapters: /chapters-fork command registration failed (${String(error)}); tools unaffected`)
    }
  }
  return () => { disposeSegment(); disposeContinue(); disposeFork(); disposeCommand?.() }
}
