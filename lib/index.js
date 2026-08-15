import { t as isTrustedApiRequest } from "./trust-JaytFzkA.js";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { WebSocket, WebSocketServer } from "ws";
import z from "@deepseek-ai/schemastery";
//#region lib/types/settings.js
/** Durable browser preferences owned by the web-shell plugin. */
/** Settings namespace persisted in the active dsh profile's settings domain. */
const WEB_SHELL_SETTINGS_NAMESPACE = "web-shell";
/** Field storing the last user-selected right-dock width in CSS pixels. */
const WEB_SHELL_DOCK_WIDTH_FIELD = "dockWidth";
/** Field storing whether the shell is folded (hidden but still mounted). */
const WEB_SHELL_FOLDED_FIELD = "folded";
/** Settings schema; width bounds mirror the ui-layout shell contract. */
const WebShellSettingsSchema = z.object({
	[WEB_SHELL_DOCK_WIDTH_FIELD]: z.number().step(1).min(360).max(960).required(false),
	[WEB_SHELL_FOLDED_FIELD]: z.boolean().required(false)
});
//#endregion
//#region lib/types/index.js
/**
* @deepseek-ai/dsh-web-shell — collapsible web terminal.
*
* Host half: registers the `/api/shell` WebSocket upgrade route and bridges
* each socket to one interactive PTY through `ctx.subprocess.spawnTerminal`.
* The browser half lives in `src/client/index.ts`.
*/
/** Stable Cordis plugin name. */
const name = "web-shell";
/** Services required before the PTY bridge can mount. */
const inject = [
	"webServer",
	"subprocess",
	"webRuntime"
];
const DEFAULT_SHELLS = ["bash", "zsh"];
/** Default browser font stack; prefers locally-installed monospace fonts with CJK fallbacks. */
const DEFAULT_SHELL_FONT_FAMILY = "\"Maple Mono NF CN\", \"Sarasa Mono SC\", \"Cascadia Code\", \"JetBrains Mono\", \"Noto Sans Mono CJK SC\", \"Microsoft YaHei UI\", monospace";
/** Validate and normalize the configured shell roster. */
function normalizeShells(config) {
	const shells = (config?.shells ?? DEFAULT_SHELLS).filter((shell) => shell === "bash" || shell === "zsh");
	const unique = [...new Set(shells)];
	const resolved = unique.length > 0 ? unique : DEFAULT_SHELLS;
	const defaultShell = config?.defaultShell ?? resolved[0];
	return {
		shells: resolved,
		defaultShell: resolved.includes(defaultShell) ? defaultShell : resolved[0]
	};
}
/**
* Mount the /api/shell upgrade route and the PTY session bridge.
* @param ctx - plugin context carrying webServer, subprocess, and webRuntime.
* @param config - validated {@link Config}.
*/
function apply(ctx, config) {
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.register(settingsNamespace(WEB_SHELL_SETTINGS_NAMESPACE), WebShellSettingsSchema);
	});
	const { shells, defaultShell } = normalizeShells(config);
	const cwd = config?.cwd ?? process.cwd();
	const rows = config?.rows ?? 40;
	const cols = config?.cols ?? 120;
	const graceMs = config?.graceMs ?? 5e3;
	const fontFamily = config?.fontFamily ?? DEFAULT_SHELL_FONT_FAMILY;
	const wss = new WebSocketServer({ noServer: true });
	const sessions = /* @__PURE__ */ new Map();
	const disposeRoute = ctx.webServer.registerUpgrade({
		path: "/api/shell",
		handler(req, socket, head) {
			if (!isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)) {
				socket.destroy();
				return;
			}
			wss.handleUpgrade(req, socket, head, (ws) => {
				wss.emit("connection", ws, req);
			});
		}
	});
	ctx.effect(() => disposeRoute, "web-shell: /api/shell upgrade route");
	wss.on("connection", (ws) => {
		ws.on("error", (err) => {
			ctx.logger.warn(err instanceof Error ? err : new Error(String(err)));
		});
		ws.send(JSON.stringify({
			type: "hello",
			shells,
			defaultShell,
			fontFamily
		}));
		ws.on("message", (raw) => {
			let msg;
			try {
				msg = JSON.parse(String(raw));
			} catch {
				ws.send(JSON.stringify({
					type: "error",
					message: "invalid JSON frame"
				}));
				return;
			}
			if (msg.type === "open") {
				if (sessions.has(ws)) return;
				const requestedShell = msg.shell ?? defaultShell;
				if (!shells.includes(requestedShell)) {
					ws.send(JSON.stringify({
						type: "error",
						message: `unsupported shell '${requestedShell}'; choose ${shells.join(" or ")}`
					}));
					ws.close();
					return;
				}
				(async () => {
					let handle;
					try {
						const spec = {
							argv: [requestedShell, "-i"],
							cwd: msg.cwd ?? cwd,
							env: { COLORTERM: "truecolor" },
							name: "xterm-256color",
							rows: msg.rows ?? rows,
							cols: msg.cols ?? cols,
							graceMs
						};
						handle = await ctx.subprocess.spawnTerminal(spec);
					} catch (err) {
						ws.send(JSON.stringify({
							type: "error",
							message: err instanceof Error ? err.message : String(err)
						}));
						ws.close();
						return;
					}
					sessions.set(ws, handle);
					handle.output.on("data", (chunk) => {
						if (ws.readyState !== WebSocket.OPEN) return;
						ws.send(JSON.stringify({
							type: "output",
							data: Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk
						}));
					});
					handle.done.then((outcome) => {
						sessions.delete(ws);
						if (ws.readyState === WebSocket.OPEN) {
							ws.send(JSON.stringify({
								type: "exit",
								exitCode: outcome.exitCode,
								signal: outcome.signal
							}));
							ws.close();
						}
					});
				})().catch((err) => {
					sessions.delete(ws);
					ws.send(JSON.stringify({
						type: "error",
						message: err instanceof Error ? err.message : String(err)
					}));
					ws.close();
				});
				return;
			}
			const handle = sessions.get(ws);
			if (handle === void 0) return;
			if (msg.type === "input") handle.write(msg.data).catch((err) => {
				ws.send(JSON.stringify({
					type: "error",
					message: err instanceof Error ? err.message : String(err)
				}));
			});
			else if (msg.type === "resize") handle.resize?.(msg.cols, msg.rows)?.catch((err) => {
				ws.send(JSON.stringify({
					type: "error",
					message: err instanceof Error ? err.message : String(err)
				}));
			});
		});
		ws.on("close", () => {
			const handle = sessions.get(ws);
			sessions.delete(ws);
			if (handle !== void 0) handle.terminate();
		});
	});
	ctx.effect(() => () => {
		for (const [ws, handle] of sessions) {
			sessions.delete(ws);
			handle.terminate();
			try {
				ws.terminate();
			} catch {}
		}
		wss.close();
	}, "web-shell: teardown");
}
//#endregion
export { WEB_SHELL_DOCK_WIDTH_FIELD, WEB_SHELL_FOLDED_FIELD, WEB_SHELL_SETTINGS_NAMESPACE, apply, inject, name };
