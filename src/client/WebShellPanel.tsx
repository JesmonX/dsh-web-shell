/**
 * Collapsible right-docked shell panel with a live xterm.js terminal.
 *
 * Visibility has two controls:
 * - collapse hides the panel but keeps the WebSocket/PTY session mounted, so
 *   reopening restores the same shell process;
 * - close disposes the terminal, closes the WebSocket, and the host kills the
 *   PTY. Reopening after close starts a fresh shell.
 *
 * The panel width is owned by ui-layout's right-dock reservation
 * (`ctx.layout.setShellWidth`): the frame reserves the same width through its
 * `shell.overlay` owner share, so the center conversation column moves left
 * instead of being covered.
 */

import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type {
  WebShellClientMessage,
  WebShellServerMessage,
} from '../protocol.ts'
import css from './WebShellPanel.module.css'

/** Keep in sync with SHELL_* in packages/client/ui-layout/src/client/columns.ts. */
const SHELL_MIN_WIDTH = 360
const SHELL_MAX_WIDTH = 960
const SHELL_DEFAULT_WIDTH = 520
/** Keep at least the ui-layout center floor available while dragging. */
const CENTER_RESERVED_WHILE_DRAGGING = 640

/** Injected by the plugin apply face from `ctx.layout`. */
export interface WebShellPanelInjected {
  closeShell(): void
  setShellWidth(px: number): void
}

interface WebShellPanelProps extends WebShellPanelInjected {
  /** Right-dock width reserved by ui-layout (0 while collapsed). */
  shellWidth?: number
}

function clampShellWidth(px: number): number {
  const maxByViewport = Math.max(SHELL_MIN_WIDTH, window.innerWidth - CENTER_RESERVED_WHILE_DRAGGING)
  const max = Math.min(SHELL_MAX_WIDTH, maxByViewport)
  return Math.min(max, Math.max(SHELL_MIN_WIDTH, Math.round(px)))
}

export function WebShellPanel({
  shellWidth = 0,
  closeShell,
  setShellWidth,
}: WebShellPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [everOpened, setEverOpened] = useState(false)
  const [shells, setShells] = useState<string[]>(['bash', 'zsh'])
  const [defaultShell, setDefaultShell] = useState('bash')
  const [selectedShell, setSelectedShell] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const defaultShellRef = useRef(defaultShell)
  const selectedShellRef = useRef(selectedShell)
  const lastWidthRef = useRef(SHELL_DEFAULT_WIDTH)
  const dragState = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)
  const sendResizeRef = useRef<() => void>(() => {})
  defaultShellRef.current = defaultShell
  selectedShellRef.current = selectedShell

  const activeShell = selectedShell ?? defaultShell
  const panelWidth = shellWidth > 0 ? shellWidth : lastWidthRef.current

  // Remember the last open width so collapse (which writes 0) can restore it.
  useEffect(() => {
    if (shellWidth > 0) lastWidthRef.current = shellWidth
  }, [shellWidth])

  useEffect(() => {
    if (!everOpened) return
    const container = containerRef.current
    /* v8 ignore next -- the panel is mounted with its container before this effect runs */
    if (container === null) return

    const term = new Terminal({
      convertEol: false,
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    fit.fit()

    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/shell`
    const ws = new WebSocket(wsUrl)
    let opened = false
    let disposed = false

    const sendOpen = (): void => {
      if (opened || disposed) return
      opened = true
      const message: WebShellClientMessage = {
        type: 'open',
        shell: selectedShellRef.current ?? defaultShellRef.current,
        rows: term.rows,
        cols: term.cols,
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
    }

    const sendResize = (): void => {
      if (!opened || disposed) return
      // The container reports 0×0 while the panel is display:none (collapsed);
      // skipping keeps the last PTY size until the panel is visible again and
      // the ResizeObserver fires with real dimensions.
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      fit.fit()
      const message: WebShellClientMessage = { type: 'resize', cols: term.cols, rows: term.rows }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
    }

    term.onData((data) => {
      if (disposed) return
      const message: WebShellClientMessage = { type: 'input', data }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
    })

    ws.onopen = () => {
      term.write('\x1b[90m[web-shell] connected, waiting for host…\x1b[0m\r\n')
    }
    ws.onmessage = (event) => {
      if (disposed) return
      let msg: WebShellServerMessage
      try {
        msg = JSON.parse(String(event.data)) as WebShellServerMessage
      } catch {
        return
      }
      if (msg.type === 'hello') {
        defaultShellRef.current = msg.defaultShell
        setShells(msg.shells)
        setDefaultShell(msg.defaultShell)
        term.write('\x1b[90m[web-shell] host ready.\x1b[0m\r\n')
        sendOpen()
      } else if (msg.type === 'output') {
        term.write(msg.data)
      } else if (msg.type === 'exit') {
        term.write(`\r\n\x1b[90m[web-shell] exited: ${msg.exitCode ?? msg.signal ?? 'unknown'}\x1b[0m\r\n`)
      } else if (msg.type === 'error') {
        term.write(`\r\n\x1b[91m[web-shell] ${msg.message}\x1b[0m\r\n`)
      }
    }
    ws.onerror = () => {
      if (!disposed) term.write('\r\n\x1b[91m[web-shell] WebSocket error.\x1b[0m\r\n')
    }
    ws.onclose = () => {
      if (!disposed) term.write('\r\n\x1b[90m[web-shell] disconnected.\x1b[0m\r\n')
    }

    const resizeObserver = new ResizeObserver(() => {
      if (!disposed) sendResize()
    })
    resizeObserver.observe(container)
    sendResizeRef.current = sendResize

    return () => {
      disposed = true
      sendResizeRef.current = () => {}
      resizeObserver.disconnect()
      try { ws.close() } catch { /* already closed */ }
      term.dispose()
    }
  }, [everOpened, selectedShell])

  // Re-fit after collapse: the container reports 0×0 while display:none, and
  // xterm needs a fresh fit once the section is visible again.
  useEffect(() => {
    if (!expanded) return
    const id = requestAnimationFrame(() => { sendResizeRef.current() })
    return () => { cancelAnimationFrame(id) }
  }, [expanded])

  const openPanel = (): void => {
    setEverOpened(true)
    setExpanded(true)
    setShellWidth(clampShellWidth(lastWidthRef.current))
  }

  const collapsePanel = (): void => {
    setExpanded(false)
    closeShell()
  }

  const closePanel = (): void => {
    setExpanded(false)
    setEverOpened(false)
    setSelectedShell(null)
    closeShell()
  }

  const onResizePointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragState.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startWidth: shellWidth > 0 ? shellWidth : lastWidthRef.current,
    }
    setDragging(true)
  }

  const onResizePointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const state = dragState.current
    if (state === null || state.pointerId !== e.pointerId) return
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    // Dragging left (negative dx) widens the right-docked panel.
    const next = clampShellWidth(state.startWidth - (e.clientX - state.startX))
    lastWidthRef.current = next
    setShellWidth(next)
  }

  const onResizePointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const state = dragState.current
    if (state === null || state.pointerId !== e.pointerId) return
    dragState.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    setDragging(false)
  }

  if (!everOpened) {
    return (
      <button
        type="button"
        className={css.toggle}
        aria-label="Open web shell"
        title="Open shell (bash/zsh)"
        onClick={openPanel}
      >
        <span className={css.toggleIcon} aria-hidden>❯_</span>
      </button>
    )
  }

  return (
    <>
      {!expanded && (
        <button
          type="button"
          className={css.toggle}
          aria-label="Expand web shell"
          title="Expand shell (session kept alive)"
          onClick={openPanel}
        >
          <span className={css.toggleIcon} aria-hidden>❯_</span>
        </button>
      )}
      <section
        className={expanded ? css.panel : css.panelCollapsed}
        style={expanded ? { width: `${panelWidth}px` } : undefined}
        aria-label="Web shell"
      >
        <header className={css.header}>
          <span className={css.title}>Shell</span>
          <div className={css.shellPicker} role="group" aria-label="Shell type">
            {shells.map((shell) => (
              <button
                key={shell}
                type="button"
                className={shell === activeShell ? css.shellActive : css.shellButton}
                aria-pressed={shell === activeShell}
                onClick={() => { setSelectedShell(shell) }}
              >
                {shell}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={css.collapse}
            aria-label="Collapse shell"
            title="Collapse (keep session alive)"
            onClick={collapsePanel}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            className={css.close}
            aria-label="Close shell"
            title="Close shell (terminate session)"
            onClick={closePanel}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div ref={containerRef} className={css.terminal} />
        <div
          className={css.resizeHandle}
          data-dragging={dragging || undefined}
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
        />
      </section>
    </>
  )
}
