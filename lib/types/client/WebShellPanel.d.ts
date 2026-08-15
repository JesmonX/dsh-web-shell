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
import '@xterm/xterm/css/xterm.css';
/** Injected by the plugin apply face from `ctx.layout`. */
export interface WebShellPanelInjected {
    closeShell(): void;
    setShellWidth(px: number): void;
}
interface WebShellPanelProps extends WebShellPanelInjected {
    /** Right-dock width reserved by ui-layout (0 while collapsed). */
    shellWidth?: number;
}
export declare function WebShellPanel({ shellWidth, closeShell, setShellWidth, }: WebShellPanelProps): import("react").JSX.Element;
export {};
//# sourceMappingURL=WebShellPanel.d.ts.map