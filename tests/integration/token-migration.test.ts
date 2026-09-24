/**
 * The credential migration in sync.ts (readToken): a pre-move token living in
 * the WORKSPACE (.dsh-chapters/.git-auth/<key>) must ride to the DSH home with
 * 0600 and be deleted from the project tree on first read — the user directive
 * says credentials never live where the agent reads. Zero coverage before
 * this file (discovered by the 2026-09-23 coverage audit).
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readToken, writeToken, tokenPath } from '../../src/sync.ts'

let home: string
let ws: string
const storeRoot = '.dsh-chapters'

const legacyOf = (key: string): string => path.join(ws, storeRoot, '.git-auth', key)
const putLegacy = (key: string, content: string): void => {
  fs.mkdirSync(path.dirname(legacyOf(key)), { recursive: true })
  fs.writeFileSync(legacyOf(key), content)
}

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokmig-home-'))
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tokmig-ws-'))
  process.env.DSH_HOME = home
})
after(() => {
  delete process.env.DSH_HOME
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(ws, { recursive: true, force: true })
})

test('legacy workspace token migrates to the DSH home (0600) and the old file is deleted', () => {
  putLegacy('KEY-MIG', 'tok-old\n')
  assert.equal(readToken(ws, storeRoot, 'KEY-MIG'), 'tok-old')
  const tp = tokenPath('KEY-MIG')
  assert.ok(fs.existsSync(tp), 'the credential now lives under the DSH home')
  assert.equal((fs.statSync(tp).mode & 0o777).toString(8), '600', '0600 — user-readable only')
  assert.equal(fs.readFileSync(tp, 'utf8').trim(), 'tok-old')
  assert.ok(!fs.existsSync(legacyOf('KEY-MIG')), 'the workspace copy is GONE — nothing token-shaped in the project tree')
  // subsequent reads come from home; nothing re-migrates
  assert.equal(readToken(ws, storeRoot, 'KEY-MIG'), 'tok-old')
})

test('a token already in the home wins outright; no legacy file is consulted', () => {
  writeToken('KEY-HOME', 'tok-home')
  putLegacy('KEY-HOME', 'tok-old')
  assert.equal(readToken(ws, storeRoot, 'KEY-HOME'), 'tok-home')
})

test('an empty legacy file is no credential (and must not create one in the home)', () => {
  putLegacy('KEY-EMPTY', '')
  assert.equal(readToken(ws, storeRoot, 'KEY-EMPTY'), undefined)
  assert.ok(!fs.existsSync(tokenPath('KEY-EMPTY')))
})

test('no token anywhere reads as undefined, never throws', () => {
  assert.equal(readToken(ws, storeRoot, 'KEY-NONE'), undefined)
})
