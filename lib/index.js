import { WebSocket, WebSocketServer } from "ws";
//#region lib/types/trust.js
/**
* Browser-trust fence for the /api/shell upgrade route. Copied from
* @deepseek-ai/dsh-client-connection/src/api-request-trust.ts so this plugin
* stays self-contained when published: loopback Host plus any configured
* `trustedHosts` authorities, with Origin/Fetch-Metadata cross-site defense.
*/
function header(headers, name) {
	if (headers instanceof Headers) return headers.get(name) ?? void 0;
	const value = headers[name];
	return typeof value === "string" ? value : void 0;
}
/** Whether a normalized URL hostname names the local loopback authority. */
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
/** Normalized URL of a Host-header authority, or undefined when unparsable. */
function parseAuthority(authority) {
	try {
		return new URL(`http://${authority}`);
	} catch {
		return;
	}
}
/** Canonical form of a parsed authority: `hostname` or `hostname:port`. */
function canonicalAuthority(entry, entryUrl) {
	const port = entryUrl.port !== "" ? entryUrl.port : new URL(`https://${entry}`).port;
	return port === "" ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}
/** Whether the request authority matches a `trustedHosts` entry. */
function isTrustedAuthority(hostUrl, trustedHosts) {
	return trustedHosts.some((entry) => {
		const entryUrl = parseAuthority(entry);
		if (entryUrl === void 0) return false;
		return canonicalAuthority(entry, entryUrl) === entryUrl.hostname ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host;
	});
}
/**
* Decide whether one /api/shell upgrade may proceed.
* @param request - Node HTTP request facts.
* @param trustedHosts - non-loopback authorities this deployment serves.
* @returns true when the Host is ours (loopback or trusted) and any attached browser markers are same-origin.
*/
function isTrustedApiRequest(request, trustedHosts) {
	const host = header(request.headers, "host");
	if (host === void 0) return false;
	const hostUrl = parseAuthority(host);
	if (hostUrl === void 0) return false;
	if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
	if (header(request.headers, "sec-fetch-site") === "cross-site") return false;
	const origin = header(request.headers, "origin");
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
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
	const { shells, defaultShell } = normalizeShells(config);
	const cwd = config?.cwd ?? process.cwd();
	const rows = config?.rows ?? 40;
	const cols = config?.cols ?? 120;
	const graceMs = config?.graceMs ?? 5e3;
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
			defaultShell
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
						handle = await ctx.subprocess.spawnTerminal({
							argv: [requestedShell, "-i"],
							cwd: msg.cwd ?? cwd,
							env: { COLORTERM: "truecolor" },
							name: "xterm-256color",
							rows: msg.rows ?? rows,
							cols: msg.cols ?? cols,
							graceMs
						});
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
export { apply, inject, name };
