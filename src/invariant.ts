/**
 * Package-owned doctor/invariant companion for dsh-web-shell.
 * @module dsh-web-shell/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { IncomingHttpHeaders } from 'node:http'
import { isTrustedApiRequest } from './trust.ts'

const PACKAGE_NAME = 'dsh-web-shell'

/** Cordis companion plugin name. */
export const name = 'web-shell-invariant'
/** Service required before the companion can register its check. */
export const inject = ['invariants']

/** Minimal web-server face used by the doctor; keeps this companion version-tolerant. */
export interface WebShellDoctorInput {
  /** Configured web-server bind host. */
  bindHost?: string | undefined
  /** Authorities accepted by the `/api/shell` trust fence. */
  trustedHosts: readonly string[]
}

/** One named doctor assertion. */
export interface WebShellDoctorCheck {
  name: string
  ok: boolean
  message: string
}

/** Result returned by the standalone dsh doctor integration. */
export interface WebShellDoctorReport {
  ok: boolean
  checks: readonly WebShellDoctorCheck[]
}

function request(headers: IncomingHttpHeaders): { headers: IncomingHttpHeaders } {
  return { headers }
}

function authorityIsParseable(authority: string): boolean {
  try {
    const url = new URL(`http://${authority}`)
    return url.hostname !== ''
      && url.pathname === '/'
      && url.search === ''
      && url.hash === ''
      && url.username === ''
      && url.password === ''
      && !/[/\\\s]/.test(authority)
  } catch {
    return false
  }
}

function check(name: string, ok: boolean, message: string): WebShellDoctorCheck {
  return { name, ok, message }
}

/**
 * Verify the exact request fence used by `/api/shell` without opening a port.
 *
 * This is intentionally a matrix over the production predicate rather than a
 * second implementation of the policy. A future `dsh doctor` command can call
 * this function with the resolved `webServer`/`webRuntime` values.
 */
export function checkWebShellTrust(input: WebShellDoctorInput): WebShellDoctorReport {
  const checks: WebShellDoctorCheck[] = []
  const trustedHosts = input.trustedHosts
  const invalidAuthorities = trustedHosts.filter(authority => !authorityIsParseable(authority))
  checks.push(check(
    'trusted-host-syntax',
    invalidAuthorities.length === 0,
    invalidAuthorities.length === 0
      ? 'all trustedHosts entries are host authorities'
      : `invalid trustedHosts entries: ${invalidAuthorities.map(value => JSON.stringify(value)).join(', ')}`,
  ))

  const loopback = isTrustedApiRequest(request({ host: '127.0.0.1' }), trustedHosts)
  checks.push(check(
    'loopback-host',
    loopback,
    loopback ? 'loopback Host is accepted' : 'loopback Host was rejected',
  ))

  const missingHost = isTrustedApiRequest(request({}), trustedHosts)
  checks.push(check(
    'host-required',
    !missingHost,
    !missingHost ? 'requests without Host are rejected' : 'requests without Host were accepted',
  ))

  const untrusted = isTrustedApiRequest(request({ host: 'attacker.invalid' }), trustedHosts)
  checks.push(check(
    'untrusted-host',
    !untrusted,
    !untrusted ? 'unlisted non-loopback Host is rejected' : 'unlisted non-loopback Host was accepted',
  ))

  const trusted = trustedHosts.find(authorityIsParseable)
  if (trusted === undefined) {
    checks.push(check(
      'trusted-host-acceptance',
      input.bindHost !== '0.0.0.0',
      input.bindHost === '0.0.0.0'
        ? '0.0.0.0 requires at least one valid trustedHosts authority'
        : 'no non-loopback trusted host is configured; loopback-only deployment is valid',
    ))
  } else {
    const sameOrigin = isTrustedApiRequest(
      request({ host: trusted, origin: `http://${trusted}` }),
      trustedHosts,
    )
    checks.push(check(
      'trusted-host-acceptance',
      sameOrigin,
      sameOrigin ? 'configured trusted Host with same-origin Origin is accepted' : 'configured trusted Host was rejected',
    ))
  }

  const crossOrigin = trusted === undefined
    ? false
    : isTrustedApiRequest(
      request({ host: trusted, origin: 'http://attacker.invalid' }),
      trustedHosts,
    )
  checks.push(check(
    'origin-fence',
    !crossOrigin,
    !crossOrigin ? 'cross-origin Origin is rejected' : 'cross-origin Origin was accepted',
  ))

  const fetchCrossSite = trusted === undefined
    ? false
    : isTrustedApiRequest(
      request({ host: trusted, 'sec-fetch-site': 'cross-site' }),
      trustedHosts,
    )
  checks.push(check(
    'fetch-metadata-fence',
    !fetchCrossSite,
    !fetchCrossSite ? 'Sec-Fetch-Site: cross-site is rejected' : 'Sec-Fetch-Site: cross-site was accepted',
  ))

  return { ok: checks.every(result => result.ok), checks }
}

/** Install the doctor matrix as a runtime invariant when the required Web rows exist. */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.on('internal/plugin', () => {
    const webServer = ctx.get('webServer') as { host?: string } | undefined
    const webRuntime = ctx.get('webRuntime') as { trustedHosts?: readonly string[] } | undefined
    if (webServer === undefined || webRuntime === undefined) return
    const report = checkWebShellTrust({
      bindHost: webServer.host,
      trustedHosts: webRuntime.trustedHosts ?? [],
    })
    if (!report.ok) {
      const failures = report.checks
        .filter(result => !result.ok)
        .map(result => `${result.name}: ${result.message}`)
        .join('; ')
      fail(`the /api/shell trust fence failed its doctor checks (${failures})`)
    }
  }, { global: true })
}

/** Register the dsh-web-shell doctor/invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
