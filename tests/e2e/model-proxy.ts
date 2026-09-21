/**
 * THE MODEL TAPE — record/replay proxy for acceptance testing
 * (user directive 2026-09-19: "the local model is way too slow for regular
 * testing; distill responses that can simulate an LLM for acceptance tests").
 *
 * An OpenAI-compatible proxy between the harness and llama.cpp:
 *
 *   record  — forwards to the real model, appends each exchange (request +
 *             the RAW streamed response bytes) to the tape directory.
 *   replay  — answers ONLY from the tape: normalized-longest-prefix match of
 *             the incoming messages against recorded requests, then re-serves
 *             the recorded bytes verbatim. A miss is LOUD (503 + the miss
 *             journal) — never a silent hang.
 *
 * Prefix matching is natural here: an agent conversation is append-only, so
 * step N of a scenario is exactly step N−1's request plus new tail nodes.
 * Normalization strips run-volatile text (dates, ISO timestamps, uuid-ish
 * tokens) so a replay week later still matches. Usage fields ride along in
 * the recorded bytes — the token meter sees identical numbers, so pressure
 * thresholds fire at identical steps: acceptance tests become deterministic
 * AND seconds-fast, while the GPU model remains the distillation instrument
 * used once per scenario (and on demand).
 *
 * Test-only scaffolding, like tests/integration/http-git-server.ts: the
 * product never depends on any of this.
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { createHash } from 'node:crypto'

export interface ProxyHandle { url: string; close: () => Promise<void> }

const VOLATILE: Array<[RegExp, string]> = [
  [/\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?/g, '<DATE>'],
  // human dates measured crossing midnight: 'Sep 19' recorded, 'Sep 20' replayed
  [/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}(,? \d{4})?\b/g, '<DATE>'],
  [/\b\d{1,2}:\d{2}(:\d{2})?\b/g, '<TIME>'],
  [/\b\d{13}\b/g, '<EPOCH>'],
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>'],
  [/"id"\s*:\s*"[^"]{8,}"/g, '"id":"<ID>"'],
  [/"callId"\s*:\s*"[^"]{8,}"/g, '"callId":"<CALL>"'],
  [/"toolCallId"\s*:\s*"[^"]{8,}"/g, '"toolCallId":"<CALL>"'],
  // 'seq' appears bare AND backslash-escaped (JSON-in-text title payloads);
  // one shape covers both (measured via the miss journal)
  [/"seq"\s*:\s*\d+/g, '"seq":<SEQ>'],
  // the injected skill catalog tracks the machine's plugin state and CAN
  // change between record and replay (measured mid-day); blanket it
  [/[Aa] skill is [\s\S]*?(?=<\/system-reminder>|$)/g, '<SKILL-CATALOG>'],
  // AGENTS-BLIND (user decision 2026-09-20): workspace instruction files are
  // DEVELOPMENT artifacts — every real project ships its own; plugin behavior
  // must not hinge on their bytes. Masking the injected block (header to the
  // reminder close, or end of message) frees doc edits from the re-record
  // cycle permanently. Ordinary conversation mentions of 'AGENTS.md' are
  // untouched: the pattern demands the exact injected header. This is the
  // LAST pipeline change: after its one re-record, the corpus is stable
  // against everything except product prompts (persona, tools, notice).
  [/(?:Updated |Current |This is an automatically updated )?instructions from: AGENTS\.md[\s\S]*?(?=<\/system-reminder>|$)/g, '<AGENTS-BLIND>'],
]
/** substitution pass over ALREADY-textual content.
 *
 * FIRST STEP collapses backslash-escaped quotes at ANY nesting depth to plain
 * quotes: a title prompt carries JSON-in-text-in-JSON, so "seq":8 appears as
 * "seq":8, \"seq\":8, … depending on stringify depth. Collapsing before
 * substituting makes every depth converge to identical canonical text — on
 * both the incoming side AND legacy stored prefixes (which still hold their
 * escaped forms from the old rules). */
export function substituteAll(str: string): string {
  let t = str
  if (/^\{\s*"role"\s*:\s*"tool"/.test(t)) return '{"role":"tool"}'
  // canonical escape/whitespace equivalence class (measured S0 diff): legacy
  // stored strings round-tripped through JSON.parse carry REAL newlines/quotes,
  // incoming stringified text carries literal two-char escape sequences. Both
  // forms must collapse to identical canonical text or nothing ever matches.
  t = t.replace(/\\*"/g, '"') // escaped quotes at any depth -> plain
  t = t.replace(/\\[nrt]/g, ' ') // literal backslash-n/t/r -> space
  t = t.replace(/\s+/g, ' ') // real whitespace runs -> single space
  for (const [re, rep] of VOLATILE) t = t.replace(re, rep)
  return t
}
/** canonical form of a message OBJECT: one stringify + substitutions. */
export function normalize(v: unknown): string {
  // TOOL RESULTS ARE HARNESS-GENERATED, never model output: their bytes
  // depend on the workspace state at replay time (measured: a src/ edit
  // between record and replay missed the recorded read result). They carry
  // zero signal for matching — model side, the scripted tool CALLS and
  // their args come from the tape; live tool behavior is asserted via the
  // durable plane (spec effects), not via tape equality. This rule is FINAL:
  // any further normalizer change invalidates existing tapes by definition.
  if (typeof v === 'object' && v !== null && (v as { role?: unknown }).role === 'tool') return '{"role":"tool"}'
  return substituteAll(JSON.stringify(v))
}

const messagesOf = (body: Record<string, unknown>): unknown[] => Array.isArray(body.messages) ? body.messages : []

export interface TapeEntry { key: string; prefix: unknown[]; status: number; contentType: string; bytes: string /* base64 */; model: string; recordedAt: string }

export interface ProxyOpts {
  mode: 'record' | 'replay'
  tapeDir: string
  upstream?: string // e.g. http://localhost:8080 — required in record mode
  /** replay + liveFallback: a miss goes to the real model AND lands on the
   * tape (journal the gap, self-heal); strict replay keeps misses LOUD so
   * suites fail fast when a scenario legitimately changed. */
  liveFallback?: boolean
}

function loadTape(tapeDir: string): TapeEntry[] {
  const out: TapeEntry[] = []
  for (const f of fs.readdirSync(tapeDir).filter((f) => f.endsWith('.json')).sort()) {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(tapeDir, f), 'utf8')) as TapeEntry
      // tapes recorded under older normalizer rules carry residue ('Sep 19'
      // literals); applying the SUBSTITUTION pass to stored strings keeps both
      // sides of the match on current rules without a re-record. (The earlier
      // attempt here re-RAN normalize(), which double-stringified stored
      // strings and broke every legacy match — the S0 root cause.)
      e.prefix = e.prefix.map((p) => (typeof p === 'string' ? substituteAll(p) : normalize(p)))
      out.push(e)
    } catch { /* skip torn */ }
  }
  return out
}

/**
 * Recorded request must match the incoming one ENTIRELY after normalization —
 * plain prefix matching collided ACROSS scenarios (all specs share a
 * normalized system+reminder header; replayed one spec's answer into
 * another's first call, ending its turn with zero assistant messages —
 * measured). The conversation's append-only nature means the right exchange
 * is present at full length; requiring equality also on the LAST message
 * pins that. A legit re-run whose volatile content normalized identically
 * still matches.
 */
function findReplay(tape: TapeEntry[], incoming: unknown[]): TapeEntry | null {
  const inc = incoming.map(normalizeSingle)
  let best: TapeEntry | null = null
  for (const e of tape) {
    const p = e.prefix
    if (p.length !== inc.length) continue
    let ok = true
    for (let i = 0; i < p.length; i++) if (p[i] !== inc[i]) { ok = false; break }
    // ties resolve to the NEWEST recording: re-record appends, and the
    // freshest capture of a conversation is the truthful one
    if (ok && (best === null || e.recordedAt > best.recordedAt)) best = e
  }
  if (best === null && process.env.E2E_TAPE_DIFF) {
    // instrumented: dump incoming + every stored prefix of the same length for diffing
    const sameLen = tape.filter((e) => e.prefix.length === inc.length).slice(0, 3)
    const dir = process.env.E2E_TAPE_DIFF
    fs.mkdirSync(dir, { recursive: true })
    const n = fs.readdirSync(dir).length
    fs.writeFileSync(path.join(dir, `${String(n).padStart(3, '0')}.json`), JSON.stringify({
      incoming: inc, storedCandidates: sameLen.map((e) => e.prefix),
    }, null, 1).slice(0, 4_000_000))
  }
  return best
}
function normalizeSingle(m: unknown): string { return JSON.stringify(m) === '' ? '' : normalize(m) }

export async function startModelProxy(opts: ProxyOpts): Promise<ProxyHandle> {
  fs.mkdirSync(opts.tapeDir, { recursive: true })
  const missLog = path.join(opts.tapeDir, '..', 'e2e-tape-misses.log')
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => {
      void (async () => {
        const raw = Buffer.concat(chunks)
        let body: Record<string, unknown> = {}
        try { body = JSON.parse(raw.toString('utf8')) as Record<string, unknown> } catch { /* non-json passthrough below */ }
        const inc = messagesOf(body)
        if (opts.mode === 'replay' && opts.liveFallback !== true) {
          const tape = loadTape(opts.tapeDir)
          const hit = findReplay(tape, inc)
          if (hit !== null) {
            res.writeHead(hit.status, { 'content-type': hit.contentType })
            res.end(Buffer.from(hit.bytes, 'base64'))
            return
          }
          fs.appendFileSync(missLog, `${new Date().toISOString()} MISS project-tape messages=${inc.length} last=${JSON.stringify(inc[inc.length - 1] ?? '').slice(0, 200)}\n`)
          // (liveFallback mode skips this block entirely and falls through)
          res.writeHead(503, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: `e2e model tape miss: no recorded exchange prefixes the ${inc.length}-message request (see ${missLog}) — re-record this scenario with E2E_MODEL=record`, type: 'tape_miss' } }))
          return
        }
        // ---- record: stream through, capture bytes, append tape
        const upstreamUrl = new URL((opts.upstream ?? 'http://localhost:8080') + req.url!)
        const transport = upstreamUrl.protocol === 'https:' ? https : http
        const ureq = transport.request(upstreamUrl, { method: req.method, headers: { ...req.headers, host: upstreamUrl.host } }, (ures) => {
          const buf: Buffer[] = []
          ures.on('data', (c) => { const b = c as Buffer; buf.push(b); try { res.write(b) } catch { /* client gone (teardown race) — the tape still records below */ } })
          ures.on('end', () => {
            try { res.end() } catch { /* client gone */ }
            const entry: TapeEntry = {
              key: createHash('sha256').update(normalize(body)).digest('hex').slice(0, 16),
              prefix: inc.map(normalizeSingle),
              status: ures.statusCode ?? 200,
              contentType: String(ures.headers['content-type'] ?? 'text/event-stream'),
              bytes: Buffer.concat(buf).toString('base64'),
              model: String(body.model ?? ''),
              recordedAt: new Date().toISOString(),
            }
            const n = fs.readdirSync(opts.tapeDir).filter((f) => /^\d+\.json$/.test(f)).length
            fs.writeFileSync(path.join(opts.tapeDir, `${String(n).padStart(4, '0')}.json`), JSON.stringify(entry))
          })
        })
        ureq.on('error', (e) => { try { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: `tape proxy upstream: ${String(e)}` } })) } catch { /* client gone */ } })
        ureq.write(raw)
        ureq.end()
      })()
    })
  })
  await new Promise<void>((resolve) => server.listen(41799, '127.0.0.1', resolve))
  return {
    url: 'http://127.0.0.1:41799/v1',
    close: async () => { await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())) },
  }
}
