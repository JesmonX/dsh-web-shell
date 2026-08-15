/**
 * Package-owned doctor/invariant companion for dsh-web-shell.
 * @module dsh-web-shell/invariant
 */
import type { Context } from '@deepseek-ai/cordis';
/** Cordis companion plugin name. */
export declare const name = "web-shell-invariant";
/** Service required before the companion can register its check. */
export declare const inject: string[];
/** Minimal web-server face used by the doctor; keeps this companion version-tolerant. */
export interface WebShellDoctorInput {
    /** Configured web-server bind host. */
    bindHost?: string | undefined;
    /** Authorities accepted by the `/api/shell` trust fence. */
    trustedHosts: readonly string[];
}
/** One named doctor assertion. */
export interface WebShellDoctorCheck {
    name: string;
    ok: boolean;
    message: string;
}
/** Result returned by the standalone dsh doctor integration. */
export interface WebShellDoctorReport {
    ok: boolean;
    checks: readonly WebShellDoctorCheck[];
}
/**
 * Verify the exact request fence used by `/api/shell` without opening a port.
 *
 * This is intentionally a matrix over the production predicate rather than a
 * second implementation of the policy. A future `dsh doctor` command can call
 * this function with the resolved `webServer`/`webRuntime` values.
 */
export declare function checkWebShellTrust(input: WebShellDoctorInput): WebShellDoctorReport;
/** Register the dsh-web-shell doctor/invariant companion. */
export declare const apply: (ctx: Context) => Promise<() => void>;
//# sourceMappingURL=invariant.d.ts.map