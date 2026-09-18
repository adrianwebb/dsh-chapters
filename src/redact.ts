/**
 * Deterministic credential redaction (knowledge-repo.md §9).
 *
 * The user's position, adopted: credentials only, deterministic patterns only,
 * everything else byte-identical — the character of the conversation is
 * historical value and stays intact. The marker is deliberate and stable:
 *   ⟦redacted:credential sha256=8f3a1c2b⟧
 * (a) obviously not a real value to any model reading a chapter,
 * (b) deterministic per secret — same secret, same marker, so diffs and
 *     cross-chapter greps stay stable,
 * (c) leaks nothing but an 8-hex prefix hash, which is also what lets a user
 *     ask "which secrets touched my sessions" without exposing them.
 *
 * Patterns are conservative by design and config-extensible; redaction is a
 * speed bump, not a guarantee (the record says so, and so does the in-repo
 * notice). Applied once, at the render chokepoint (src/render.ts), so chapters
 * and artifact files are both covered without caller changes.
 */
import { createHash } from 'node:crypto'

export interface RedactPattern {
  name: string
  /** Global regex; the secret is the whole match unless `secretGroup` names a capture group. */
  regex: RegExp
  /** Capture group holding the secret (e.g. keep `token=`, redact the value). Default: whole match. */
  secretGroup?: number
}

/** Built-in set (record §9). New patterns are config additions, not magic. */
export const DEFAULT_REDACTIONS: readonly RedactPattern[] = [
  { name: 'pem-private-key', regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { name: 'aws-access-key-id', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'github-token', regex: /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{16,}\b/g },
  { name: 'github-fine-grained', regex: /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g },
  { name: 'openai-style-key', regex: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g },
  { name: 'bearer-token', regex: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, secretGroup: 1 },
  { name: 'url-credential-param', regex: /([?&](?:token|api[_-]?key|apikey|key|secret|password)=)[^&\s"'`]+/gi, secretGroup: 1 },
]

/**
 * `Bearer <tok>` → redact the token, keep the `Bearer ` label: the pattern's
 * `secretGroup` names the capture that is NOT the secret; here we invert —
 * the label is group 1, so the secret is the remainder of the match after
 * the group. Implemented via a post-step in redactText (label-aware patterns).
 */
function markerFor(secret: string): string {
  const h = createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 8)
  return `⟦redacted:credential sha256=${h}⟧`
}

export interface RedactionResult {
  text: string
  /** Number of secret occurrences replaced. */
  count: number
  /** Distinct markers produced (for tests/audit; order of first appearance). */
  markers: string[]
}

/**
 * Replace every pattern match's secret with its stable marker.
 * `secretGroup` semantics: the named group is the LABEL to keep; the secret
 * is the rest of the match (url-credential-param, bearer). Without it, the
 * whole match is the secret. Markers never re-match any pattern (verified by
 * test), so passes compose safely.
 */
export function redactText(text: string, patterns: readonly RedactPattern[] = DEFAULT_REDACTIONS): RedactionResult {
  let out = text
  let count = 0
  const markers: string[] = []
  for (const p of patterns) {
    const re = new RegExp(p.regex.source, p.regex.flags.includes('g') ? p.regex.flags : p.regex.flags + 'g')
    const matches = Array.from(out.matchAll(re))
    if (matches.length === 0) continue
    // splice back-to-front so earlier indices stay valid
    for (let i = matches.length - 1; i >= 0; i -= 1) {
      const m = matches[i]!
      const whole = m[0]
      let keep = ''
      let secret = whole
      // label-group patterns (bearer, url-credential): the named group is a
      // PREFIX of the match and is kept; the remainder is the secret. Any
      // other shape falls through to whole-match redaction (safe default).
      if (p.secretGroup !== undefined) {
        const label = m[p.secretGroup]
        if (typeof label === 'string' && label.length > 0 && whole.startsWith(label)) {
          keep = label
          secret = whole.slice(label.length)
        }
      }
      if (secret.length === 0) continue
      const marker = markerFor(secret)
      const start = m.index! + keep.length
      out = out.slice(0, start) + marker + out.slice(start + secret.length)
      count += 1
      if (!markers.includes(marker)) markers.push(marker)
    }
  }
  return { text: out, count, markers }
}
