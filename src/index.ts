/**
 * @deepseek-ai/dsh-web-shell — collapsible web terminal.
 *
 * Host half: registers the `/api/shell` WebSocket upgrade route and bridges
 * each socket to one interactive PTY through `ctx.subprocess.spawnTerminal`.
 * The browser half lives in `src/client/index.ts`.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'

/** Compatibility with older @deepseek-ai/dsh-subprocess releases that predate the terminal `name` spawn field. */
type TerminalSpawnSpec = Parameters<import('@deepseek-ai/dsh-subprocess').SubprocessRuntime['spawnTerminal']>[0] & { name?: string }
/** Compatibility with older @deepseek-ai/dsh-subprocess releases that predate the optional `resize` handle method. */
type TerminalHandleWithResize = SubprocessTerminalHandle & { resize?(cols: number, rows: number): Promise<void> }
import type {} from '@deepseek-ai/dsh-subprocess'
import { WebSocketServer, WebSocket } from 'ws'
import { isTrustedApiRequest } from './trust.ts'
import type { WebShellClientMessage } from './protocol.ts'

/** Stable Cordis plugin name. */
export const name = 'web-shell'

/** Services required before the PTY bridge can mount. */
export const inject = ['webServer', 'subprocess', 'webRuntime']

/** Plugin config, resolved from the bundle patch (or a test context). */
export interface Config {
  /** Shells offered to the browser, in display order. */
  shells?: string[]
  /** Shell used when the browser does not choose one. */
  defaultShell?: string
  /** Starting directory for new terminals; defaults to process.cwd(). */
  cwd?: string
  /** Initial terminal rows. */
  rows?: number
  /** Initial terminal columns. */
  cols?: number
  /** TERM-to-KILL cleanup grace for the complete terminal session. */
  graceMs?: number
}

interface WebRuntimeLike {
  trustedHosts: string[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    webRuntime: WebRuntimeLike
  }
}

const DEFAULT_SHELLS = ['bash', 'zsh']

/** Validate and normalize the configured shell roster. */
function normalizeShells(config?: Config): { shells: string[]; defaultShell: string } {
  const shells = (config?.shells ?? DEFAULT_SHELLS).filter(shell => shell === 'bash' || shell === 'zsh')
  const unique = [...new Set(shells)]
  const resolved = unique.length > 0 ? unique : DEFAULT_SHELLS
  const defaultShell = config?.defaultShell ?? resolved[0]!
  return { shells: resolved, defaultShell: resolved.includes(defaultShell) ? defaultShell : resolved[0]! }
}

/**
 * Mount the /api/shell upgrade route and the PTY session bridge.
 * @param ctx - plugin context carrying webServer, subprocess, and webRuntime.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config?: Config): void {
  const { shells, defaultShell } = normalizeShells(config)
  const cwd = config?.cwd ?? process.cwd()
  const rows = config?.rows ?? 40
  const cols = config?.cols ?? 120
  const graceMs = config?.graceMs ?? 5000

  const wss = new WebSocketServer({ noServer: true })
  const sessions = new Map<WebSocket, SubprocessTerminalHandle>()

  const disposeRoute = ctx.webServer.registerUpgrade({
    path: '/api/shell',
    handler(req, socket, head) {
      if (!isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)) {
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req)
      })
    },
  })
  ctx.effect(() => disposeRoute, 'web-shell: /api/shell upgrade route')

  wss.on('connection', (ws) => {
    ws.on('error', (err) => {
      ctx.logger.warn(err instanceof Error ? err : new Error(String(err)))
    })

    ws.send(JSON.stringify({ type: 'hello', shells, defaultShell } satisfies import('./protocol.ts').WebShellHello))

    ws.on('message', (raw) => {
      let msg: WebShellClientMessage
      try {
        msg = JSON.parse(String(raw)) as WebShellClientMessage
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'invalid JSON frame' }))
        return
      }

      if (msg.type === 'open') {
        if (sessions.has(ws)) return // one terminal per socket
        const requestedShell = msg.shell ?? defaultShell
        if (!shells.includes(requestedShell)) {
          ws.send(JSON.stringify({ type: 'error', message: `unsupported shell '${requestedShell}'; choose ${shells.join(' or ')}` }))
          ws.close()
          return
        }

        void (async () => {
          let handle: SubprocessTerminalHandle
          try {
            const spec: TerminalSpawnSpec = {
              argv: [requestedShell, '-i'],
              cwd: msg.cwd ?? cwd,
              env: {
                COLORTERM: 'truecolor',
              },
              name: 'xterm-256color',
              rows: msg.rows ?? rows,
              cols: msg.cols ?? cols,
              graceMs,
            }
            handle = await ctx.subprocess.spawnTerminal(spec)
          } catch (err) {
            ws.send(JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : String(err) }))
            ws.close()
            return
          }

          sessions.set(ws, handle)
          handle.output.on('data', (chunk: Buffer | string) => {
            if (ws.readyState !== WebSocket.OPEN) return
            ws.send(JSON.stringify({
              type: 'output',
              data: Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk,
            }))
          })
          void handle.done.then((outcome) => {
            sessions.delete(ws)
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'exit', exitCode: outcome.exitCode, signal: outcome.signal }))
              ws.close()
            }
          })
        })().catch((err: unknown) => {
          sessions.delete(ws)
          ws.send(JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : String(err) }))
          ws.close()
        })
        return
      }

      const handle = sessions.get(ws) as TerminalHandleWithResize | undefined
      if (handle === undefined) return

      if (msg.type === 'input') {
        void handle.write(msg.data).catch((err: unknown) => {
          ws.send(JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : String(err) }))
        })
      } else if (msg.type === 'resize') {
        void handle.resize?.(msg.cols, msg.rows)?.catch((err: unknown) => {
          ws.send(JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : String(err) }))
        })
      }
    })

    ws.on('close', () => {
      const handle = sessions.get(ws)
      sessions.delete(ws)
      if (handle !== undefined) void handle.terminate()
    })
  })

  ctx.effect(() => () => {
    for (const [ws, handle] of sessions) {
      sessions.delete(ws)
      void handle.terminate()
      try { ws.terminate() } catch { /* already closed */ }
    }
    wss.close()
  }, 'web-shell: teardown')
}
