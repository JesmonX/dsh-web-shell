/**
 * Collapsible right-docked shell panel with a live xterm.js terminal and
 * browser-style multiple shell tabs.
 *
 * Visibility has two controls:
 * - collapse hides the panel but keeps every tab's WebSocket/PTY session
 *   mounted, so reopening restores the same shell processes;
 * - close disposes every tab, closes each WebSocket, and the host kills the
 *   PTYs. Reopening after close starts a fresh shell.
 *
 * The panel width is owned by ui-layout's right-dock reservation
 * (`ctx.layout.setShellWidth`): the frame reserves the same width through its
 * `shell.overlay` owner share, so the center conversation column moves left
 * instead of being covered.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
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
/** Matches the host default; hello may override it with the configured stack. */
const DEFAULT_SHELL_FONT_FAMILY = '"Maple Mono NF CN", "Sarasa Mono SC", "Cascadia Code", "JetBrains Mono", "Noto Sans Mono CJK SC", "Microsoft YaHei UI", monospace'
const DEFAULT_FONT_SIZE = 13
const MIN_FONT_SIZE = 8
const MAX_FONT_SIZE = 24

/** Dark theme with the contrast and palette of a conventional Linux terminal. */
const TERMINAL_THEME = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#ffffff',
  cursorAccent: '#1e1e1e',
  selectionBackground: '#264f78',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
} as const

type XtermLinkProvider = Parameters<Terminal['registerLinkProvider']>[0]
type XtermLink = Parameters<XtermLinkProvider['provideLinks']>[1] extends (links: (infer T)[] | undefined) => void ? T : never

function registerWebLinks(term: Terminal): void {
  const provider: XtermLinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      const line = term.buffer.active.getLine(bufferLineNumber)
      if (line === undefined) {
        callback(undefined)
        return
      }
      const text = line.translateToString(true)
      const links: XtermLink[] = []
      const regex = /https?:\/\/[^\s"'<>]+/gi
      let match: RegExpExecArray | null
      while ((match = regex.exec(text)) !== null) {
        const raw = match[0]
        const uri = raw.replace(/[.,;:!?]+$/, '')
        const start = match.index
        const end = start + uri.length
        links.push({
          range: {
            start: { x: start + 1, y: bufferLineNumber + 1 },
            end: { x: end + 1, y: bufferLineNumber + 1 },
          },
          text: uri,
          activate(_event, text) {
            window.open(text, '_blank', 'noopener')
          },
        })
      }
      callback(links)
    },
  }
  term.registerLinkProvider(provider)
}

async function copySelection(term: Terminal): Promise<void> {
  const selection = term.getSelection()
  if (selection.length === 0) return
  if (typeof navigator.clipboard?.writeText === 'function') {
    await navigator.clipboard.writeText(selection)
  }
}

async function pasteClipboard(term: Terminal): Promise<void> {
  if (typeof navigator.clipboard?.readText === 'function') {
    try {
      const text = await navigator.clipboard.readText()
      term.paste(text)
      return
    } catch {
      /* fall through to the browser paste path */
    }
  }
  term.focus()
  document.execCommand('paste')
}

/** Injected by the plugin apply face from `ctx.layout`. */
export interface WebShellPanelInjected {
  closeShell(): void
  setShellWidth(px: number): void
}

interface WebShellPanelProps extends WebShellPanelInjected {
  /** Right-dock width reserved by ui-layout (0 while collapsed). */
  shellWidth?: number
}

interface ShellTab {
  id: number
  shell: string
}

interface ContextMenuState {
  x: number
  y: number
}

interface ShellSessionProps {
  tab: ShellTab
  active: boolean
  fontSize: number
  shells: string[]
  onHello(shells: string[], defaultShell: string): void
  onChangeShell(tabId: number, shell: string): void
  onNewTab(): void
  onZoomIn(): void
  onZoomOut(): void
  onZoomReset(): void
}

function clampShellWidth(px: number): number {
  const maxByViewport = Math.max(SHELL_MIN_WIDTH, window.innerWidth - CENTER_RESERVED_WHILE_DRAGGING)
  const max = Math.min(SHELL_MAX_WIDTH, maxByViewport)
  return Math.min(max, Math.max(SHELL_MIN_WIDTH, Math.round(px)))
}

function ShellSession({
  tab,
  active,
  fontSize,
  shells,
  onHello,
  onChangeShell,
  onNewTab,
  onZoomIn,
  onZoomOut,
  onZoomReset,
}: ShellSessionProps) {
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const [sessionNonce, setSessionNonce] = useState(0)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sendResizeRef = useRef<() => void>(() => {})
  const fontSizeRef = useRef(fontSize)
  const shellRef = useRef(tab.shell)
  const activeRef = useRef(active)
  const onNewTabRef = useRef(onNewTab)
  const onZoomInRef = useRef(onZoomIn)
  const onZoomOutRef = useRef(onZoomOut)
  const onZoomResetRef = useRef(onZoomReset)
  fontSizeRef.current = fontSize
  shellRef.current = tab.shell
  activeRef.current = active
  onNewTabRef.current = onNewTab
  onZoomInRef.current = onZoomIn
  onZoomOutRef.current = onZoomOut
  onZoomResetRef.current = onZoomReset

  useEffect(() => {
    if (!active) setMenu(null)
  }, [active])

  useEffect(() => {
    const container = containerRef.current
    /* v8 ignore next -- the tab is mounted with its container before this effect runs */
    if (container === null) return

    const term = new Terminal({
      convertEol: false,
      fontFamily: DEFAULT_SHELL_FONT_FAMILY,
      fontSize: fontSizeRef.current,
      fontWeight: '400',
      fontWeightBold: '700',
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 10000,
      smoothScrollDuration: 120,
      theme: TERMINAL_THEME,
      allowProposedApi: true,
    })
    termRef.current = term
    const fit = new FitAddon()
    fitRef.current = fit
    term.loadAddon(fit)
    term.open(container)
    registerWebLinks(term)
    if (activeRef.current) fit.fit()

    const copyTerminalSelection = async (): Promise<void> => {
      await copySelection(term)
    }
    const pasteIntoTerminal = async (): Promise<void> => {
      await pasteClipboard(term)
    }

    term.attachCustomKeyEventHandler((event) => {
      const ctrl = event.ctrlKey && !event.altKey && !event.metaKey
      if (ctrl && event.shiftKey && event.code === 'KeyC') {
        event.preventDefault()
        void copyTerminalSelection()
        return false
      }
      if (ctrl && event.shiftKey && event.code === 'KeyV') {
        event.preventDefault()
        void pasteIntoTerminal()
        return false
      }
      if (ctrl && event.shiftKey && event.code === 'KeyT') {
        event.preventDefault()
        onNewTabRef.current()
        return false
      }
      if (ctrl && event.code === 'Equal' || ctrl && event.code === 'NumpadAdd') {
        event.preventDefault()
        onZoomInRef.current()
        return false
      }
      if (ctrl && event.code === 'Minus' || ctrl && event.code === 'NumpadSubtract') {
        event.preventDefault()
        onZoomOutRef.current()
        return false
      }
      if (ctrl && event.code === 'Digit0') {
        event.preventDefault()
        onZoomResetRef.current()
        return false
      }
      return true
    })

    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/shell`
    const ws = new WebSocket(wsUrl)
    let opened = false
    let disposed = false

    const sendOpen = (): void => {
      if (opened || disposed) return
      opened = true
      const message: WebShellClientMessage = {
        type: 'open',
        shell: shellRef.current,
        rows: term.rows,
        cols: term.cols,
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
    }

    const sendResize = (): void => {
      if (!opened || disposed) return
      // The container reports 0×0 while the tab is hidden (or the panel is
      // collapsed); skipping keeps the last PTY size until the tab is visible
      // again and the ResizeObserver fires with real dimensions.
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
        onHello(msg.shells, msg.defaultShell)
        if (msg.fontFamily) term.options.fontFamily = msg.fontFamily
        term.write('\x1b[90m[web-shell] host ready.\x1b[0m\r\n')
        fit.fit()
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
      if (termRef.current === term) termRef.current = null
      if (fitRef.current === fit) fitRef.current = null
    }
  }, [tab.id, tab.shell, sessionNonce])

  // Apply font-size zoom and re-fit the active tab after xterm re-measures.
  useEffect(() => {
    const term = termRef.current
    if (term === null) return
    term.options.fontSize = fontSize
    if (!active) return
    const raf = requestAnimationFrame(() => {
      fitRef.current?.fit()
      sendResizeRef.current?.()
    })
    return () => { cancelAnimationFrame(raf) }
  }, [active, fontSize])

  // Re-fit after a tab becomes visible again.
  useEffect(() => {
    if (!active) return
    const raf = requestAnimationFrame(() => {
      fitRef.current?.fit()
      sendResizeRef.current?.()
    })
    return () => { cancelAnimationFrame(raf) }
  }, [active])

  const openContextMenu = (e: ReactMouseEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY })
  }

  const closeContextMenu = (): void => {
    setMenu(null)
  }

  const menuCopy = (): void => {
    const term = termRef.current
    if (term !== null) void copySelection(term)
    closeContextMenu()
  }

  const menuPaste = (): void => {
    const term = termRef.current
    if (term !== null) void pasteClipboard(term)
    closeContextMenu()
  }

  const menuClear = (): void => {
    termRef.current?.clear()
    closeContextMenu()
  }

  const menuRestart = (): void => {
    setSessionNonce((value) => value + 1)
    closeContextMenu()
  }

  const menuShell = (shell: string): void => {
    onChangeShell(tab.id, shell)
    closeContextMenu()
  }

  const contextLeft = menu === null ? 0 : Math.min(menu.x, window.innerWidth - 232)
  const contextTop = menu === null ? 0 : Math.min(menu.y, window.innerHeight - 272)

  return (
    <div className={active ? css.session : css.sessionHidden}>
      <div
        ref={containerRef}
        className={css.terminal}
        onContextMenu={openContextMenu}
      />
      {menu !== null && (
        <div
          className={css.contextMenuBackdrop}
          onMouseDown={closeContextMenu}
          onContextMenu={(event) => {
            event.preventDefault()
            closeContextMenu()
          }}
        >
          <div
            className={css.contextMenu}
            style={{ left: `${contextLeft}px`, top: `${contextTop}px` }}
            onMouseDown={(event) => { event.stopPropagation() }}
          >
            <div className={css.contextMenuLabel}>Shell</div>
            <button type="button" className={css.contextMenuItem} onClick={menuCopy}>复制</button>
            <button type="button" className={css.contextMenuItem} onClick={menuPaste}>粘贴</button>
            <button type="button" className={css.contextMenuItem} onClick={menuClear}>清屏</button>
            <div className={css.contextMenuDivider} />
            {shells.map((shell) => (
              <button
                key={shell}
                type="button"
                className={shell === tab.shell ? css.contextMenuItemActive : css.contextMenuItem}
                onClick={() => { menuShell(shell) }}
              >
                使用 {shell}
              </button>
            ))}
            <div className={css.contextMenuDivider} />
            <button type="button" className={css.contextMenuItem} onClick={menuRestart}>重启 shell</button>
          </div>
        </div>
      )}
    </div>
  )
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
  const [dragging, setDragging] = useState(false)
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE)
  const [tabs, setTabs] = useState<ShellTab[]>([])
  const [activeTabId, setActiveTabId] = useState<number | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const lastWidthRef = useRef(SHELL_DEFAULT_WIDTH)
  const nextTabIdRef = useRef(1)
  const dragState = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null
  const activeShell = activeTab?.shell ?? defaultShell
  const panelWidth = shellWidth > 0 ? shellWidth : lastWidthRef.current

  // Remember the last open width so collapse (which writes 0) can restore it.
  useEffect(() => {
    if (shellWidth > 0) lastWidthRef.current = shellWidth
  }, [shellWidth])

  const handleHello = useCallback((nextShells: string[], nextDefaultShell: string) => {
    setShells(nextShells)
    setDefaultShell(nextDefaultShell)
    // A tab that requested a shell this deployment does not offer (for
    // example a tab created before hello arrived) is migrated to the host's
    // advertised default.
    setTabs((prev) => prev.map((tab) => (
      nextShells.includes(tab.shell) ? tab : { ...tab, shell: nextDefaultShell }
    )))
  }, [])

  const ensurePanelOpen = (): void => {
    setEverOpened(true)
    setExpanded(true)
    setShellWidth(clampShellWidth(lastWidthRef.current))
  }

  const addTab = (): void => {
    const requested = activeTab?.shell ?? defaultShell
    const shell = shells.includes(requested) ? requested : (shells[0] ?? defaultShell)
    const id = nextTabIdRef.current
    nextTabIdRef.current += 1
    setTabs((prev) => prev.length === 0
      ? [{ id, shell }]
      : [...prev, { id, shell }])
    setActiveTabId(id)
    ensurePanelOpen()
  }

  const openPanel = (): void => {
    if (tabs.length === 0) {
      addTab()
      return
    }
    ensurePanelOpen()
  }

  const collapsePanel = (): void => {
    setExpanded(false)
    closeShell()
  }

  const closePanel = (): void => {
    setExpanded(false)
    setEverOpened(false)
    setTabs([])
    setActiveTabId(null)
    closeShell()
  }

  const closeTab = (id: number): void => {
    const nextTabs = tabs.filter((tab) => tab.id !== id)
    if (nextTabs.length === 0) {
      closePanel()
      return
    }
    setTabs(nextTabs)
    if (activeTabId === id) {
      const closedIndex = tabs.findIndex((tab) => tab.id === id)
      const neighbor = nextTabs[Math.max(0, closedIndex - 1)] ?? nextTabs[0]!
      setActiveTabId(neighbor.id)
    }
  }

  const changeShell = (shell: string): void => {
    if (activeTabId === null) return
    setTabs((prev) => prev.map((tab) => (
      tab.id === activeTabId ? { ...tab, shell } : tab
    )))
  }

  const zoomIn = (): void => {
    setFontSize((value) => Math.min(MAX_FONT_SIZE, value + 1))
  }

  const zoomOut = (): void => {
    setFontSize((value) => Math.max(MIN_FONT_SIZE, value - 1))
  }

  const zoomReset = (): void => {
    setFontSize(DEFAULT_FONT_SIZE)
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
          title="Expand shell (sessions kept alive)"
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
                onClick={() => { changeShell(shell) }}
              >
                {shell}
              </button>
            ))}
          </div>
          <div className={css.zoom} role="group" aria-label="Terminal font size">
            <button type="button" className={css.zoomButton} title="Decrease font size (Ctrl+-)" onClick={zoomOut}>−</button>
            <span className={css.zoomValue}>{fontSize}px</span>
            <button type="button" className={css.zoomButton} title="Increase font size (Ctrl++)" onClick={zoomIn}>+</button>
          </div>
          <button
            type="button"
            className={css.collapse}
            aria-label="Collapse shell"
            title="Collapse (sessions kept alive)"
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
            title="Close shell (terminate all sessions)"
            onClick={closePanel}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className={css.tabBar} role="tablist" aria-label="Shell sessions">
          {tabs.map((tab, index) => (
            <div
              key={tab.id}
              role="tab"
              aria-selected={tab.id === activeTabId}
              className={tab.id === activeTabId ? css.tabActive : css.tab}
              onClick={() => { setActiveTabId(tab.id) }}
            >
              <span className={css.tabTitle}>{tab.shell} {index + 1}</span>
              <button
                type="button"
                className={css.tabClose}
                aria-label={`Close ${tab.shell} ${index + 1}`}
                title="Close tab (terminate session)"
                onClick={(event) => {
                  event.stopPropagation()
                  closeTab(tab.id)
                }}
              >
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          ))}
          <button
            type="button"
            className={css.tabNew}
            aria-label="New shell tab"
            title="New shell tab (Ctrl+Shift+T)"
            onClick={addTab}
          >
            +
          </button>
        </div>
        <div ref={containerRef} className={css.sessions}>
          {tabs.map((tab) => (
            <ShellSession
              key={tab.id}
              tab={tab}
              active={tab.id === activeTabId}
              fontSize={fontSize}
              shells={shells}
              onHello={handleHello}
              onChangeShell={(id, shell) => {
                setTabs((prev) => prev.map((item) => (
                  item.id === id ? { ...item, shell } : item
                )))
              }}
              onNewTab={addTab}
              onZoomIn={zoomIn}
              onZoomOut={zoomOut}
              onZoomReset={zoomReset}
            />
          ))}
        </div>
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
