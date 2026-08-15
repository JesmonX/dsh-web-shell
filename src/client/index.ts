/**
 * Browser half of dsh-web-shell: registers a collapsible right-docked shell
 * panel into ui-layout's `shell.overlay` seat (list, root scope — additive).
 * The panel owns the right-dock width through `ctx.layout`, so ui-layout can
 * reserve the same width and keep the conversation column clear of the shell.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: merges ui-layout's SlotMap entry for `shell.overlay` and its
// Context merge for `ctx.layout`.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { WebShellPanel } from './WebShellPanel.tsx'
import type { WebShellPanelInjected } from './WebShellPanel.tsx'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'layout']

/** Right-dock API added to ctx.layout by newer ui-layout releases. */
interface WebShellLayout {
  closeShell?(): void
  setShellWidth?(px: number): void
}

/**
 * Mount the shell panel. The slot is declared by ui-layout's root entry, so
 * registration rides `slots.inject` and activates when the declaration exists.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  // Cast deliberately: older ui-layout builds expose ctx.layout but predate
  // the right-dock API. With those, the methods are no-ops and the shell
  // falls back to a pure overlay; newer builds reserve space and prevent the
  // center conversation column from being covered.
  const layout = ctx.layout as unknown as WebShellLayout
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'web-shell',
    order: 100,
    inject: (): WebShellPanelInjected => ({
      closeShell: () => { layout.closeShell?.() },
      setShellWidth: (px: number) => { layout.setShellWidth?.(px) },
    }),
  }, WebShellPanel))
}
