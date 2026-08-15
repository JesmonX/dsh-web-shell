/** Durable browser preferences owned by the web-shell plugin. */

import z from '@deepseek-ai/schemastery'

/** Settings namespace persisted in the active dsh profile's settings domain. */
export const WEB_SHELL_SETTINGS_NAMESPACE = 'web-shell'

/** Field storing the last user-selected right-dock width in CSS pixels. */
export const WEB_SHELL_DOCK_WIDTH_FIELD = 'dockWidth'

/** Field storing whether the shell is folded (hidden but still mounted). */
export const WEB_SHELL_FOLDED_FIELD = 'folded'

/** Durable settings shared by the Host schema and browser scope. */
export interface WebShellSettings {
  /** Last open right-dock width; absent until the user resizes the panel. */
  dockWidth?: number
  /** Whether the panel was folded when the profile was last used. */
  folded?: boolean
}

/** Settings schema; width bounds mirror the ui-layout shell contract. */
export const WebShellSettingsSchema: z<WebShellSettings> = z.object({
  [WEB_SHELL_DOCK_WIDTH_FIELD]: z.number().step(1).min(360).max(960).required(false),
  [WEB_SHELL_FOLDED_FIELD]: z.boolean().required(false),
})
