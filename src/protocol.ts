/** Wire protocol between the browser shell panel and the host PTY bridge. */

export interface WebShellHello {
  type: 'hello'
  /** Shells this deployment offers, in display order. */
  shells: string[]
  /** The shell selected when the client does not ask for one. */
  defaultShell: string
}

export interface WebShellOpen {
  type: 'open'
  /** Optional starting directory; defaults to the host process cwd. */
  cwd?: string
  /** Optional shell name; must be one of the advertised shells. */
  shell?: string
  /** Terminal row count at open time. */
  rows?: number
  /** Terminal column count at open time. */
  cols?: number
}

export interface WebShellInput {
  type: 'input'
  /** Raw terminal input, without implicit newline conversion. */
  data: string
}

export interface WebShellResize {
  type: 'resize'
  cols: number
  rows: number
}

export interface WebShellOutput {
  type: 'output'
  /** UTF-8 terminal output in delivery order. */
  data: string
}

export interface WebShellExit {
  type: 'exit'
  /** Exit code; null when the shell died from a signal. */
  exitCode: number | null
  /** Terminating signal, e.g. 'SIGTERM'; null on normal exit. */
  signal: string | null
}

export interface WebShellError {
  type: 'error'
  message: string
}

export type WebShellClientMessage = WebShellOpen | WebShellInput | WebShellResize
export type WebShellServerMessage = WebShellHello | WebShellOutput | WebShellExit | WebShellError
