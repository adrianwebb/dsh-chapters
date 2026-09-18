/**
 * A REAL git smart-HTTP server for tests: `git http-backend` (the stock CGI)
 * behind a tiny node bridge. The product (isomorphic-git) talks real HTTP
 * smart protocol over loopback — clones, fetches, pushes exactly as it would
 * against GitHub. The git binary is test-scaffolding only; the shipped plugin
 * never shells out (record §3.2).
 *
 * Returns null when git/http-backend is unavailable — tests skip, honestly.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const BACKEND = '/usr/lib/git-core/git-http-backend'

export interface GitHttpServer {
  base: string
  /** Create (or reuse) a bare repo; returns its push-capable clone URL. */
  serveRepo(name: string): string
  stop(): Promise<void>
}

export async function startGitHttpServer(rootDir: string): Promise<GitHttpServer | null> {
  if (!fs.existsSync(BACKEND) && spawnSync('git', ['--version']).status !== 0) return null
  fs.mkdirSync(rootDir, { recursive: true })
  const sockets = new Set<import('node:net').Socket>()
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const u = new URL(req.url ?? '/', 'http://127.0.0.1')
      const m = /^\/([^/]+\/[^/]+?\.git)(?:\/(info\/refs|git-upload-pack|git-receive-pack))?/.exec(u.pathname)
      if (m === null) { res.writeHead(404); res.end('not a git route'); return }
      const repoRel = m[1]!
      const service = m[2] ?? ''
      const cgis = path.join(rootDir, repoRel)
      if (!fs.existsSync(cgis)) { res.writeHead(404); res.end('no repo'); return }
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_PROJECT_ROOT: rootDir,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: `/${repoRel}${service !== '' ? `/${service}` : ''}`,
        QUERY_STRING: u.search.slice(1),
        REQUEST_METHOD: req.method ?? 'GET',
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        CONTENT_LENGTH: String(body.length),
        REMOTE_USER: 'dsh-test',
        REMOTE_IDENT: 'dsh-test',
        GATEWAY_INTERFACE: 'CGI/1.1',
        SERVER_PROTOCOL: 'HTTP/1.1',
        HTTP_HOST: req.headers.host ?? '127.0.0.1',
      }
      const cgi = spawn(BACKEND, [], { env })
      cgi.stdin.end(body)
      const out: Buffer[] = []
      cgi.stdout.on('data', (c: Buffer) => out.push(c))
      cgi.stderr.on('data', (c: Buffer) => process.stderr.write(`[http-backend] ${c}`))
      cgi.on('close', () => {
        const raw = Buffer.concat(out)
        const sep = raw.indexOf('\r\n\r\n') >= 0 ? raw.indexOf('\r\n\r\n') + 4 : (() => {
          // LF-only header terminator
          for (let i = 0; i + 1 < raw.length; i++) {
            if (raw[i] === 0x0a && raw[i + 1] === 0x0a) return i + 2
          }
          return raw.length
        })()
        const head = raw.subarray(0, sep).toString('latin1')
        const rest = raw.subarray(sep)
        const headers: Record<string, string> = {}
        let status = 200
        for (const line of head.split(/\r?\n/)) {
          const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line)
          if (kv === null) continue
          const k = kv[1]!
          const v = kv[2]!
          if (k.toLowerCase() === 'status') status = Number.parseInt(v, 10) || 200
          else headers[k] = v
        }
        res.writeHead(status, headers)
        res.end(rest)
      })
    })
  })
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (address === null || typeof address === 'string') return null
  const base = `http://127.0.0.1:${address.port}`
  return {
    base,
    serveRepo(name: string): string {
      const dir = path.join(rootDir, 'repos', name)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(path.dirname(dir), { recursive: true })
        const init = spawnSync('git', ['init', '--bare', '-b', 'main', dir], { encoding: 'utf8' })
        if (init.status !== 0) throw new Error(`git init --bare failed: ${init.stderr}`)
        // allow push over dumb-less smart HTTP without auth
        spawnSync('git', ['-C', dir, 'config', 'http.receivepack', 'true'], { encoding: 'utf8' })
        spawnSync('git', ['-C', dir, 'config', 'http.uploadpack', 'true'], { encoding: 'utf8' })
      }
      return `${base}/repos/${name}`
    },
    async stop(): Promise<void> {
      await new Promise<void>((resolve) => { server.close(() => resolve()) })
      for (const s of sockets) s.destroy()
    },
  }
}

/** Read a remote's tree (file names) through the SAME isomorphic-git stack
 * the product uses — the honest assertion that a push landed. */
export async function remoteFiles(repoUrl: string, token: string | undefined): Promise<string[]> {
  const git = await import('isomorphic-git')
  const nodefs = await import('node:fs')
  const nodeHttp = (await import('isomorphic-git/http/node')).default
  const tmp = fs.mkdtempSync(path.join('/tmp', 'dsh-remote-check-'))
  try {
    await git.clone({
      fs: nodefs as never, http: nodeHttp, dir: tmp, url: repoUrl, singleBranch: true,
      ...(token !== undefined ? { onAuth: () => ({ username: 'dsh', password: token }) } : {}),
    })
    return await git.listFiles({ fs: nodefs as never, dir: tmp, ref: 'HEAD' })
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
