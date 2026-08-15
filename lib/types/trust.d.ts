/**
 * Browser-trust fence for the /api/shell upgrade route. Copied from
 * @deepseek-ai/dsh-client-connection/src/api-request-trust.ts so this plugin
 * stays self-contained when published: loopback Host plus any configured
 * `trustedHosts` authorities, with Origin/Fetch-Metadata cross-site defense.
 */
import type { IncomingHttpHeaders } from 'node:http';
/** The request facts the fence reads from either HTTP representation. */
interface ApiTrustRequest {
    headers: IncomingHttpHeaders | Headers;
}
/**
 * Decide whether one /api/shell upgrade may proceed.
 * @param request - Node HTTP request facts.
 * @param trustedHosts - non-loopback authorities this deployment serves.
 * @returns true when the Host is ours (loopback or trusted) and any attached browser markers are same-origin.
 */
export declare function isTrustedApiRequest(request: ApiTrustRequest, trustedHosts: readonly string[]): boolean;
export {};
//# sourceMappingURL=trust.d.ts.map