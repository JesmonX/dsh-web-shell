import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { clientBundle } from './tsdown.client.ts'

const base = clientBundle('dsh-web-shell', ['lib/types/index.js'])

const XTERM_CSS_PATH = fileURLToPath(import.meta.resolve('@xterm/xterm/css/xterm.css'))
const XTERM_CSS_PREFIX = '\0dsh-web-shell-xterm-css:'
const XTERM_CSS_VIRTUAL = XTERM_CSS_PREFIX + 'xterm.css.mjs'

/**
 * Inline xterm's plain CSS into the browser bundle the same way the preset's
 * CSS-module plugin handles '*.module.css': a virtual module injects a
 * plugin-owned <style> tag at factory execution. This keeps the package from
 * needing @tsdown/css.
 */
function xtermCssPlugin() {
  return {
    name: 'dsh-web-shell-xterm-css',
    resolveId(source: string) {
      if (source === '@xterm/xterm/css/xterm.css') return XTERM_CSS_VIRTUAL
      return null
    },
    async load(id: string) {
      if (id !== XTERM_CSS_VIRTUAL) return null
      const source = await readFile(XTERM_CSS_PATH)
      const css = JSON.stringify(source.toString())
      return [
        'const css = ' + css + ';',
        'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css="dsh-web-shell/xterm.css"]\') === null) {',
        '  const tag = document.createElement(\'style\');',
        '  tag.dataset.plugin = \'dsh-web-shell\';',
        '  tag.dataset.pluginCss = \'dsh-web-shell/xterm.css\';',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        'export default css;',
      ].join('\n')
    },
  }
}

export default (inlineConfig: { env?: unknown }) =>
  base(inlineConfig).map((config) => {
    if (config.plugins === undefined) return config
    return { ...config, plugins: [...config.plugins, xtermCssPlugin()] }
  })
