/**
 * @deepseek-ai/dsh-web-shell — collapsible web terminal.
 *
 * Host half: registers the `/api/shell` WebSocket upgrade route and bridges
 * each socket to one interactive PTY through `ctx.subprocess.spawnTerminal`.
 * The browser half lives in `src/client/index.ts`.
 */
import type { Context } from '@deepseek-ai/cordis';
export { WEB_SHELL_DOCK_WIDTH_FIELD, WEB_SHELL_FOLDED_FIELD, WEB_SHELL_SETTINGS_NAMESPACE, type WebShellSettings, } from './settings.ts';
/** Stable Cordis plugin name. */
export declare const name = "web-shell";
/** Services required before the PTY bridge can mount. */
export declare const inject: string[];
/** Plugin config, resolved from the bundle patch (or a test context). */
export interface Config {
    /** Shells offered to the browser, in display order. */
    shells?: string[];
    /** Shell used when the browser does not choose one. */
    defaultShell?: string;
    /** Starting directory for new terminals; defaults to process.cwd(). */
    cwd?: string;
    /** Initial terminal rows. */
    rows?: number;
    /** Initial terminal columns. */
    cols?: number;
    /** TERM-to-KILL cleanup grace for the complete terminal session. */
    graceMs?: number;
    /** CSS font-family stack for the browser xterm.js terminal. */
    fontFamily?: string;
}
interface WebRuntimeLike {
    trustedHosts: string[];
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        webRuntime: WebRuntimeLike;
    }
}
/**
 * Mount the /api/shell upgrade route and the PTY session bridge.
 * @param ctx - plugin context carrying webServer, subprocess, and webRuntime.
 * @param config - validated {@link Config}.
 */
export declare function apply(ctx: Context, config?: Config): void;
//# sourceMappingURL=index.d.ts.map