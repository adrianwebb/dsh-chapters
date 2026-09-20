import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEnrichWiring, type EnrichWiringDeps } from '../../src/enrich-wire.ts'
import { parseChapterFile } from '../../src/enrich-store.ts'

function harness(fetchImpl?: (prompt: string) => Promise<string>) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-'))
  const rel = '.dsh-chapters/sess-1/chapters/001-topic.md'
  fs.mkdirSync(path.join(ws, '.dsh-chapters', 'sess-1', 'chapters'), { recursive: true })
  const body = '# Topic\n\n**User:** build the thing\n\n**Assistant:** done: pushed and verified\n'
  fs.writeFileSync(path.join(ws, rel), `---\ntitle: "legacy fragment"\nsummary: deterministic summary text\ntopics: ["src/a.ts"]\n---\n${body}`)
  const state: any = {
    chapters: [{ number: 1, path: rel, title: 'legacy fragment', summary: 'deterministic summary text', topics: ['src/a.ts'], sha256: 'x'.repeat(64), startSeq: 0, endSeq: 5, estimatedTokens: 10 }],
  }
  const settings = new Map<string, string>()
  const store = {
    get: async () => state as never,
    put: async (_id: string, next: any) => { state.chapters = next.chapters },
    sessions: () => [['sess-1', state]] as Iterable<[string, unknown]>,
    getSetting: (k: string) => settings.get(k),
    putSetting: async (k: string, v: string) => { settings.set(k, v) },
  } as unknown as EnrichWiringDeps['store']
  let fetched = 0
  const counted = fetchImpl ?? (async () => '{"title": "Enriched title", "summary": "Model summary sentence here.", "topics": ["auth", "retrieval"]}')
  const deps: EnrichWiringDeps = {
    store,
    cwd: () => ws,
    config: { enabled: true, model: 'p/m1', trigger: 'both', idleMs: 10, batchCap: 5 },
    fetch: async (prompt, route) => { fetched++; return await counted(prompt, route) },
    conversationRoute: () => ({ provider: 'p', model: 'm1' }),
    log: () => undefined, warn: () => undefined,
    setTimer: (fn) => { const t = setTimeout(fn, 100000); return { cancel: () => clearTimeout(t) } },
  }
  void store
  return { ws, rel, deps, state, settings, bumpFetch: () => { fetched++ }, fetchCount: () => fetched, dispose: () => fs.rmSync(ws, { recursive: true, force: true }) }
}

test('ladder: enriches file + record, stamps provenance, schedules republish', async () => {
  const h = harness()
  let scheduled = ''
  h.deps.scheduler = { schedule: (c, w) => { scheduled = `${c}|${w}` } }
  const w = createEnrichWiring(h.deps)
  const r = await w.runNow()
  assert.equal(r.processed, 1, JSON.stringify(r))
  const doc = parseChapterFile(fs.readFileSync(path.join(h.ws, h.rel), 'utf8'))
  const fm = doc.fmLines.join('\n')
  assert.ok(fm.includes('title: "Enriched title"') && fm.includes('generated:'), fm.slice(0, 300))
  assert.ok(fm.includes('model: p/m1'), 'provenance names the resolved route')
  assert.equal(doc.body, '# Topic\n\n**User:** build the thing\n\n**Assistant:** done: pushed and verified\n', 'body bytes untouched')
  assert.equal((h.state.chapters[0] as unknown as { title: string }).title, 'Enriched title', 'registry record mirrors')
  assert.ok(scheduled.endsWith('|archive:enrichment'))
  assert.equal(await w.pendingCount(), 0, 'nothing pending after enrichment')
  const r2 = await w.runNow()
  assert.equal(r2.processed, 0, 'idempotent second run')
  h.dispose()
})

test('failure ladder: garbage -> one nudge retry -> deterministic values kept, pending unchanged', async () => {
  const h = harness(async () => 'sorry, I cannot produce JSON today')
  const w = createEnrichWiring(h.deps)
  const r = await w.runNow()
  assert.equal(r.processed, 0)
  assert.equal((h.state.chapters[0] as unknown as { title: string }).title, 'legacy fragment')
  const fmText = fs.readFileSync(path.join(h.ws, h.rel), 'utf8')
  assert.ok(!fmText.includes('generated:'), 'no provenance written for a failed ladder')
  assert.equal(h.fetchCount(), 2, 'initial attempt + exactly one nudge retry')
  assert.equal(await w.pendingCount(), 1)
  h.dispose()
})

test('model change re-qualifies chapters (idempotency key includes the model)', async () => {
  const h = harness()
  const w = createEnrichWiring(h.deps)
  await w.runNow()
  assert.equal(await w.pendingCount(), 0)
  await w.setModelOverride('p/m2')
  assert.equal(await w.pendingCount(), 1, 'a newer model makes pending work again')
  h.dispose()
})
