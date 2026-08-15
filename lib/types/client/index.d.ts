/**
 * Browser half of dsh-web-shell: registers a collapsible right-docked shell
 * panel into ui-layout's `shell.overlay` seat (list, root scope — additive).
 * The panel owns the right-dock width through `ctx.layout`, so ui-layout can
 * reserve the same width and keep the conversation column clear of the shell.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
/** Required services (cordis fiber inject). */
export declare const inject: string[];
/**
 * Mount the shell panel. The slot is declared by ui-layout's root entry, so
 * registration rides `slots.inject` and activates when the declaration exists.
 * @param ctx - the browser plugin context.
 */
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map