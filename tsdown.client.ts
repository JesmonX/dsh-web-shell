/**
 * Shared tsdown preset for the dsh-web-shell client bundle, adapted from the
 * DeepSeek Harness monorepo (packages/client/tsdown.client.ts) so this
 * standalone repository rebuilds byte-compatible artifacts without the
 * monorepo. Emits a closure-factory artifact: the bundle calls
 * window.__ModuleLoader__.load({ id, factory }) and resolves externals through
 * the injected require (loader module table — cordis DI entities, no globals,
 * no import map). CSS Modules are compiled by lightningcss inside the bundle:
 * importing 'x.module.css' yields the hashed class map, and the css text
 * auto-injects a <style data-plugin="<id>"> tag at factory execution (the
 * loader removes plugin-owned tags on unload).
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

/**
 * Browser platform modules the shell shares into the frozen module table.
 * Inlined from packages/client/web/src/platform.ts; keep in sync with the
 * harness release this plugin targets.
 */
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
] as const

/** Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline (which requires @tsdown/css). */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/**
 * Wire/type layers a client bundle may inline: browser-safe contracts
 * with no runtime identity to share (no Symbol/instanceof/singleton state).
 */
export const INLINE_SAFE = /^@deepseek-ai\/(host-apiproxy|session|llm|tools|brand)(\/|$)/

/**
 * Vendored framework libraries: rescoped into @deepseek-ai, so the gate below
 * would read them as plugin packages. They carry no cross-plugin runtime
 * identity to share — ordinary libraries a browser bundle inlines.
 */
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/

/** Generated descriptor/codec contribution with no shared runtime identity. */
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

/**
 * Temporary exemption kept from the monorepo preset: the snapshot-store
 * engine lives in dsh-client-runtime pending its rehoming. The lazy CJS table
 * answers the require natively: runtime is an immediately-tier row, its
 * factory is registered before any dependent bundle materializes.
 */
const RUNTIME_STORE_EXEMPTION = '@deepseek-ai/dsh-client-runtime/client'

/** Externals resolved from the loader module table: the platform seed entries plus the documented runtime exemption. */
export const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES, RUNTIME_STORE_EXEMPTION]

const REPOSITORY_ROOT = fileURLToPath(new URL('.', import.meta.url))

/** Rebase a physical lib-relative source onto a browser URL that mirrors the repository source directory. */
function browserSourcePath(source: string, sourcemapPath: string): string {
  if (!source.startsWith('.')) return source
  const physicalSource = resolvePath(dirname(sourcemapPath), source)
  const repositoryPath = relative(REPOSITORY_ROOT, physicalSource).split(sep).join('/')
  return repositoryPath.startsWith('src/') ? '../' + repositoryPath : source
}

/**
 * Build the tsdown config for the dsh-web-shell package: the node-half lib
 * build plus the browser client bundle.
 * @param id - plugin id (package name), stamped into the __ModuleLoader__.load
 * handoff and onto the injected style tags.
 * @param libEntry - node-half entries, spelled at the call site.
 */
export function clientBundle(id: string, libEntry: readonly string[]): (inlineConfig: Pick<UserConfig, 'env'>) => UserConfig[] {
  const lib: UserConfig = {
    name: id,
    entry: [...libEntry],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  }
  return ({ env }) => {
    const face = env?.DSH_BUILD_FACE
    if (face !== undefined && face !== 'host' && face !== 'client') {
      throw new Error('tsdown: --env.DSH_BUILD_FACE must be host or client, received ' + String(face))
    }
    // The standalone build script always runs both tsc passes first, then the
    // client face; a bare 'tsdown' builds both halves from lib/types too.
    if (face === 'host') return []
    return [lib, clientConfig(id)]
  }
}

function clientConfig(id: string): UserConfig {
  return {
    name: id + '/client',
    entry: { client: 'lib/types/client/index.js' },
    // Browser bundle lands next to the node half (single lib/ artifact dir;
    // the entryFileNames pin keeps it exactly lib/client.js). clean must stay
    // off — a default clean would wipe the node-half output emitted above.
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    // Types ship from lib/types (tsc); dts here would wrap the banner/footer into .d.cts and break parsing.
    dts: false,
    // Plugin code is fetched outside Vite's module graph, so its own bundle
    // must carry the TS/TSX mapping consumed by browser profiling tools.
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    // Browser bundles inline node-idiom deps (zustand/immer read
    // process.env.NODE_ENV). The keys honor the build's NODE_ENV so a
    // dev build keeps the dev-branch semantics; artifacts default to production.
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    // tsdown auto-externalizes package dependencies; anything NOT in the
    // loader module table must inline instead (xterm, addon-fit — every
    // non-shared dep). A require() the table cannot answer is a guaranteed
    // runtime throw, so the rule is the table list itself.
    noExternal: (dep: string) => (CLIENT_EXTERNALS.includes(dep) ? undefined : true),
    plugins: [{
      // Bundle purity gate (build-time mirror of the module-edge rules):
      // platform seed entries stay external, inline-safe wire layers inline,
      // and every other @deepseek-ai value import is a build error.
      name: 'dsh-client-bundle-purity',
      resolveId(source: string) {
        if (!source.startsWith('@deepseek-ai/')) return null
        if (CLIENT_EXTERNALS.includes(source)) return null
        if (VENDORED_LIBRARY.test(source)) return null
        if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null
        throw new Error(
          'client bundle purity: "' + source + '" is not a platform module (CLIENT_EXTERNALS), an inline-safe wire layer, or a generated /remote contribution — '
          + 'cross-plugin value imports are forbidden; collaborate through cordis services (type-only imports are erased and never reach this gate)',
        )
      },
    }, {
      name: 'dsh-css-modules-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css')) return null
        const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
        return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
        const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        // The virtual id otherwise hides the physical stylesheet from Rolldown's watch graph.
        this.addWatchFile(fileId)
        const source = await readFile(fileId)
        const { code, exports: cssExports } = transform({
          filename: fileId,
          code: source,
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        const classMap: Record<string, string> = {}
        for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
        // One <style data-plugin> per module file; idempotent under re-evaluation.
        const tagIdValue = id + '/' + basename(fileId)
        return [
          'const css = ' + JSON.stringify(code.toString()) + ';',
          'const tagId = ' + JSON.stringify(tagIdValue) + ';',
          'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
          '  const tag = document.createElement(\'style\');',
          '  tag.dataset.plugin = ' + JSON.stringify(id) + ';',
          '  tag.dataset.pluginCss = tagId;',
          '  tag.textContent = css;',
          '  document.head.appendChild(tag);',
          '}',
          'export default ' + JSON.stringify(classMap) + ';',
        ].join('\n')
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      // The map is served from /plugins/<package>/client.js.map. The browser
      // resolves its local sources back into URLs that mirror the repository
      // src directory; sourcesContent keeps them usable without exposing that
      // tree as an HTTP route.
      sourcemapPathTransform: browserSourcePath,
      banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(id) + ', factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}

/** Resolve an emitted JS asset import against its source-tree counterpart. */
function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolvePath(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const marker = sep + 'lib' + sep + 'types' + sep
  const boundary = emitted.indexOf(marker)
  if (boundary < 0) return emitted
  return resolvePath(emitted.slice(0, boundary), 'src', emitted.slice(boundary + marker.length))
}
