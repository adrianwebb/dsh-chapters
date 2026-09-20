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
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>'],
  [/"id"\s*:\s*"[^"]{8,}"/g, '"id":"<ID>"'],
  [/"callId"\s*:\s*"[^"]{8,}"/g, '"callId":"<CALL>"'],
  [/"toolCallId"\s*:\s*"[^"]{8,}"/g, '"toolCallId":"<CALL>"'],
]
const normalize = (v: unknown): string => {
  let s = JSON.stringify(v)
  for (const [re, rep] of VOLATILE) s = s.replace(re, rep)
  return s
}
const messagesOf = (body: Record<string, unknown>): unknown[] => Array.isArray(body.messages) ? body.messages : []

export interface TapeEntry { key: string; prefix: unknown[]; status: number; contentType: string; bytes: string /* base64 */; model: string; recordedAt: string }

export interface ProxyOpts {
  mode: 'record' | 'replay'
  tapeDir: string
  upstream?: string // e.g. http://localhost:8080 — required in record mode
}

function loadTape(tapeDir: string): TapeEntry[] {
  const out: TapeEntry[] = []
  for (const f of fs.readdirSync(tapeDir).filter((f) => f.endsWith('.json')).sort()) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(tapeDir, f), 'utf8')) as TapeEntry) } catch { /* skip torn */ }
  }
  return out
}

/** longest recorded request whose normalized messages are a PREFIX of ours */
function findReplay(tape: TapeEntry[], incoming: unknown[]): TapeEntry | null {
  const inc = incoming.map(normalizeSingle)
  let best: TapeEntry | null = null
  for (const e of tape) {
    const p = e.prefix
    if (p.length > inc.length) continue
    let ok = true
    for (let i = 0; i < p.length; i++) if (p[i] !== inc[i]) { ok = false; break }
    if (ok && (best === null || p.length > best.prefix.length)) best = e
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
        if (opts.mode === 'replay') {
          const tape = loadTape(opts.tapeDir)
          const hit = findReplay(tape, inc)
          if (hit !== null) {
            res.writeHead(hit.status, { 'content-type': hit.contentType })
            res.end(Buffer.from(hit.bytes, 'base64'))
            return
          }
          fs.appendFileSync(missLog, `${new Date().toISOString()} MISS messages=${inc.length} first=${JSON.stringify(inc[0] ?? '').slice(0, 160)}\n`)
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
