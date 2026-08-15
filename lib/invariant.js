import { t as isTrustedApiRequest } from "./trust-JaytFzkA.js";
//#region lib/types/invariant.js
/**
* Package-owned doctor/invariant companion for dsh-web-shell.
* @module dsh-web-shell/invariant
*/
const PACKAGE_NAME = "dsh-web-shell";
/** Cordis companion plugin name. */
const name = "web-shell-invariant";
/** Service required before the companion can register its check. */
const inject = ["invariants"];
function request(headers) {
	return { headers };
}
function authorityIsParseable(authority) {
	try {
		const url = new URL(`http://${authority}`);
		return url.hostname !== "" && url.pathname === "/" && url.search === "" && url.hash === "" && url.username === "" && url.password === "" && !/[/\\\s]/.test(authority);
	} catch {
		return false;
	}
}
function check(name, ok, message) {
	return {
		name,
		ok,
		message
	};
}
/**
* Verify the exact request fence used by `/api/shell` without opening a port.
*
* This is intentionally a matrix over the production predicate rather than a
* second implementation of the policy. A future `dsh doctor` command can call
* this function with the resolved `webServer`/`webRuntime` values.
*/
function checkWebShellTrust(input) {
	const checks = [];
	const trustedHosts = input.trustedHosts;
	const invalidAuthorities = trustedHosts.filter((authority) => !authorityIsParseable(authority));
	checks.push(check("trusted-host-syntax", invalidAuthorities.length === 0, invalidAuthorities.length === 0 ? "all trustedHosts entries are host authorities" : `invalid trustedHosts entries: ${invalidAuthorities.map((value) => JSON.stringify(value)).join(", ")}`));
	const loopback = isTrustedApiRequest(request({ host: "127.0.0.1" }), trustedHosts);
	checks.push(check("loopback-host", loopback, loopback ? "loopback Host is accepted" : "loopback Host was rejected"));
	const missingHost = isTrustedApiRequest(request({}), trustedHosts);
	checks.push(check("host-required", !missingHost, !missingHost ? "requests without Host are rejected" : "requests without Host were accepted"));
	const untrusted = isTrustedApiRequest(request({ host: "attacker.invalid" }), trustedHosts);
	checks.push(check("untrusted-host", !untrusted, !untrusted ? "unlisted non-loopback Host is rejected" : "unlisted non-loopback Host was accepted"));
	const trusted = trustedHosts.find(authorityIsParseable);
	if (trusted === void 0) checks.push(check("trusted-host-acceptance", input.bindHost !== "0.0.0.0", input.bindHost === "0.0.0.0" ? "0.0.0.0 requires at least one valid trustedHosts authority" : "no non-loopback trusted host is configured; loopback-only deployment is valid"));
	else {
		const sameOrigin = isTrustedApiRequest(request({
			host: trusted,
			origin: `http://${trusted}`
		}), trustedHosts);
		checks.push(check("trusted-host-acceptance", sameOrigin, sameOrigin ? "configured trusted Host with same-origin Origin is accepted" : "configured trusted Host was rejected"));
	}
	const crossOrigin = trusted === void 0 ? false : isTrustedApiRequest(request({
		host: trusted,
		origin: "http://attacker.invalid"
	}), trustedHosts);
	checks.push(check("origin-fence", !crossOrigin, !crossOrigin ? "cross-origin Origin is rejected" : "cross-origin Origin was accepted"));
	const fetchCrossSite = trusted === void 0 ? false : isTrustedApiRequest(request({
		host: trusted,
		"sec-fetch-site": "cross-site"
	}), trustedHosts);
	checks.push(check("fetch-metadata-fence", !fetchCrossSite, !fetchCrossSite ? "Sec-Fetch-Site: cross-site is rejected" : "Sec-Fetch-Site: cross-site was accepted"));
	return {
		ok: checks.every((result) => result.ok),
		checks
	};
}
/** Install the doctor matrix as a runtime invariant when the required Web rows exist. */
const install = (ctx, fail) => {
	ctx.on("internal/plugin", () => {
		const webServer = ctx.get("webServer");
		const webRuntime = ctx.get("webRuntime");
		if (webServer === void 0 || webRuntime === void 0) return;
		const report = checkWebShellTrust({
			bindHost: webServer.host,
			trustedHosts: webRuntime.trustedHosts ?? []
		});
		if (!report.ok) fail(`the /api/shell trust fence failed its doctor checks (${report.checks.filter((result) => !result.ok).map((result) => `${result.name}: ${result.message}`).join("; ")})`);
	}, { global: true });
};
/** Register the dsh-web-shell doctor/invariant companion. */
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, checkWebShellTrust, inject, name };
