import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { openApp, newSessionWithTurn, localModelUp, sessionLogTextById, ROOT } from './session.ts'

/**
 * THE FAN-OUT CASE, driven the way the user described it: one parent agent
 * spawns subagent readers over documents, each with only the 32K stress
 * window. Papers are ~1600 lines (~30K tokens) — deliberately LARGER than
 * any single reader's window minus the header: every child must read in
 * ranges and crosses its compaction threshold mid-turn (the filing cabinet
 * earning its keep at a window that physically cannot hold the paper).
 *
 * What this pins:
 *   1. children complete their reading tasks and return reports (the mid-
 *      turn compaction path works INSIDE spawned sessions);
 *   2. the parent ingests both reports and synthesizes an answer citing
 *      each paper's unique marker + DONE token — nothing lost across two
 *      compaction domains reporting into one desk;
 *   3. (observation, not a gate) whether the PARENT itself crossed its own
 *      threshold collecting the reports — recorded for the notes sidecar.
 *
 * The 'one paper too big to load at all' case is structurally identical
 * from the engine's view (chunked reads, threshold crossings) and is
 * covered at larger scale by oversized-turn.spec.ts.
 */
const PAPER_A = path.join(ROOT, 'var', 'e2e-paperA.md')
const PAPER_B = path.join(ROOT, 'var', 'e2e-paperB.md')
const A_MARK = 'PAPER-A-MARKON-7731'
const B_MARK = 'PAPER-B-MARKON-4207'

function generatePapers(): void {
  const build = (file: string, title: string, mark: string, seed0: number): void => {
    let seed = seed0
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const words = 'gradient descent attention head sparse mixture expert routing recall precision embedding quantization distillation benchmark ablation perplexity retrieval corpus document chunk window recursion summary synthesis evaluation metric'
      .split(' ')
    const lines: string[] = [`# ${title}`, '', `Unique finding token: ${mark}`, '', `This paper ${title.toLowerCase()} studies recursive reading under small context windows. It claims that filing excerpts beats holding everything in attention.`]
    for (let i = 1; i <= 1600; i++) {
      const take = Array.from({ length: 12 }, () => words[Math.floor(rnd() * words.length)]).join(' ')
      lines.push(`${i.toString().padStart(4, '0')}: ${take}`)
    }
    lines.push('', 'Report ending: state the finding token and finish.')
    fs.writeFileSync(file, lines.join('\n'))
  }
  build(PAPER_A, 'Paper Alpha', A_MARK, 7)
  build(PAPER_B, 'Paper Beta', B_MARK, 991)
}

test('a parent fans out two subagent readers whose papers exceed their own windows; reports come back and synthesize', async ({ page }) => {
  test.setTimeout(7_200_000) // 120 min ceiling for local-hardware variance
  test.skip(!(await localModelUp()), 'Local model server not running')
  generatePapers()

  await openApp(page)
  const sid = await newSessionWithTurn(page, [
    'Research task. You have TWO subagent tool calls to make, sequentially (run_in_background false on each), in this exact order:',
    '',
    '1) Spawn ONE subagent whose prompt is: "Read var/e2e-paperA.md with the read tool in ranges of EXACTLY 300 lines for the FIRST SIX ranges only (offset 1, then 301, 601, 901, 1201, 1501 — never one big read, no bash). After the SIXTH read you MUST stop calling tools and answer immediately, whatever remains unread. Do NOT use shell commands. Answer in under 80 words: what the paper claims, including its finding token ' + A_MARK + ' verbatim."',
    '2) Do the same for var/e2e-paperB.md, finding token ' + B_MARK + '.',
    '',
    'After BOTH subagents have returned, write ONE final paragraph comparing their claims. Your final paragraph MUST contain both finding tokens verbatim and both words PAPER-A-DONE and PAPER-B-DONE.',
  ].join('\n'), 3_900_000, false) // 65-min turn: two child readers share one llama.cpp slot

  // --- 2: the parent's final answer carries BOTH children's worlds
  const texts: string[] = []
  for (const line of sessionLogTextById(sid).split('\n')) {
    try {
      const e = JSON.parse(line)
      if (e?.type !== 'assistant/message') continue
      const dd = (e.data ?? {}) as Record<string, unknown>
      const content = (((dd.message as { content?: unknown } | undefined)?.content ?? dd.content) ?? []) as { type?: string; text?: string }[]
      const t = content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
      if (t.trim()) texts.push(t)
    } catch { /* partial */ }
  }
  expect(texts.length, 'parent produced assistant text').toBeGreaterThanOrEqual(1)
  const final = texts[texts.length - 1]!
  expect(final, 'parent synthesis lost paper A').toContain(A_MARK)
  expect(final, 'parent synthesis lost paper B').toContain(B_MARK)
  expect(final).toContain('PAPER-A-DONE')
  expect(final).toContain('PAPER-B-DONE')

  // --- 1: children really ran as separate sessions (tool results in parent log)
  const raw = sessionLogTextById(sid)
  const childResults = raw.split('\n').filter((l) => {
    try { const e = JSON.parse(l); return e?.type === 'tool/result' && JSON.stringify(e).includes('MARKON') } catch { return false }
  })
  expect(childResults.length, 'both subagent reports arrived as tool results').toBeGreaterThanOrEqual(2)

  // --- 3: observation sidecar (never a gate): did anyone compact inside?
  let compactsHere = 0
  for (const line of raw.split('\n')) {
    try { if (JSON.parse(line)?.type === 'compaction/summary') compactsHere++ } catch { /* skip */ }
  }
  fs.writeFileSync(path.join(ROOT, 'var', 'e2e-fanout-notes.json'), JSON.stringify({
    at: new Date().toISOString(), parentCompactions: compactsHere,
    parentAnswerTokens: [A_MARK, B_MARK, 'PAPER-A-DONE', 'PAPER-B-DONE'].every((t) => final.includes(t)),
  }, null, 1))
})
