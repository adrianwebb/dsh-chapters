/*-----------------------------------------------------------------------------------------------
 * dsh-chapters client-bundle preset — VENDORED from dsh-session-fork's tsdown.client.config.ts,
 * which is itself the external-plugin replica of packages/client/tsdown.client.ts in the
 * deepseek-harness checkout (see that file's header for the commit-pinned regions). Trimmed for
 * this plugin: NO CSS pipeline (we ship no stylesheets — the action button reuses the host row's
 * own layout), PLUGIN_ID adapted. The browser artifact contract (loader banner/footer/intro,
 * external set, defines, purity gate) is the load-bearing part and stays byte-faithful.
 *
 * Upstream license (preserved): Copyright (c) DeepSeek, MIT License.
 *----------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'
import type { UserConfig } from 'tsdown'

/** Module-table rows the shell answers for every client bundle. */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

const PRELOADED_CLIENT_EXTERNALS = [
  '@deepseek-ai/dsh-client-runtime/client',
] as const

const PLUGIN_ID = '@treeseed/dsh-chapters'

const MANIFEST = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { readonly dsh?: { readonly client?: { readonly external?: unknown } } }

const requested = new Set<string>([
  ...PLATFORM_MODULES,
  ...PRELOADED_CLIENT_EXTERNALS,
  ...(Array.isArray(MANIFEST.dsh?.client?.external) ? MANIFEST.dsh.client.external as string[] : []),
])

const isRequested = (specifier: string): boolean => requested.has(specifier)

/** Wire/type layers a client bundle may inline (browser-safe contracts, no shared runtime identity). */
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|file-reference|session|llm|tools|brand)(\/|$)/
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

const config: UserConfig = {
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: isRequested,
    alwaysBundle: (specifier: string) => !isRequested(specifier),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [{
    // Build-time mirror of the module-edge rules: unlisted @deepseek-ai VALUE
    // imports are errors — cross-plugin value imports either duplicate runtime
    // identity or require a specifier the loader table cannot answer.
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (isRequested(source)) return null
      if (VENDORED_LIBRARY.test(source)) return null
      if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null
      throw new Error(
        `client bundle purity: "${source}" is not a requested module-table row or an inline-safe wire layer — `
        + 'collaborate through cordis services (type-only imports are erased and never reach this gate)',
      )
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default config
