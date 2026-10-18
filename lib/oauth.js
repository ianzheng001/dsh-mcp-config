/**
 * Interactive OAuth for one MCP server.
 *
 * dsh's MCP client only accepts static headers, so a server that answers `401`
 * can never connect on its own. This module runs the authorization-code flow the
 * MCP SDK already implements (RFC 9728 discovery → dynamic client registration →
 * PKCE authorize → token), then hands the resulting access token back so the
 * caller can persist it as the server's `Authorization` header and let the normal
 * Loader reload put the live connection up.
 *
 * Flow:
 *
 *   beginAuthorization()  → transport.start() → 401 → discovery/DCR →
 *                           provider.redirectToAuthorization(url) → 'redirect'
 *   user opens that URL, approves, the AS redirects to our loopback callback
 *   finishAuthorization() → transport.finishAuth(code, iss) → tokens persisted
 *
 * Tokens and client registrations live OUTSIDE the patch files, in
 * `<DSH_HOME>/mcp-config-oauth.json` (mode 0600), keyed by Loader entry id.
 *
 * @module dsh-mcp-config/oauth
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Loopback path the authorization server redirects back to. */
export const OAUTH_CALLBACK_PATH = '/dsh-mcp-config/oauth/callback'

/** File holding client registrations and tokens (never the patch files). */
export const OAUTH_STATE_FILENAME = 'mcp-config-oauth.json'

/** How long one interactive authorization may stay pending. */
export const FLOW_TTL_MS = 5 * 60 * 1000

/**
 * Merge a timeout into a promise.
 *
 * @param promise - work to bound.
 * @param ms - budget.
 * @param label - text used when the budget is exhausted.
 * @returns the promise's value.
 */
function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}（${String(ms)} ms 超时）`)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * File-backed credential store.
 *
 * @param filePath - absolute path of the JSON state file.
 * @returns `{ read, write, clear }`.
 */
export function createOAuthStore(filePath) {
  // Read-through (no cache): the file is tiny and the same record may be reached
  // through more than one store instance (Host route vs. probe).
  const load = async () => {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'))
      return { servers: parsed?.servers ?? {} }
    } catch {
      return { servers: {} }
    }
  }

  const flush = async (data) => {
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  }

  return {
    path: filePath,
    /**
     * Read one server's stored credentials.
     *
     * @param serverId - Loader entry id.
     * @returns the record, or undefined.
     */
    async read(serverId) {
      const data = await load()
      const record = data.servers[serverId]
      return record === undefined ? undefined : { ...record }
    },
    /**
     * Merge fields into one server's record.
     *
     * @param serverId - Loader entry id.
     * @param changes - fields to store.
     */
    async write(serverId, changes) {
      const data = await load()
      data.servers[serverId] = { ...(data.servers[serverId] ?? {}), ...changes }
      await flush(data)
    },
    /**
     * Forget one server's registration and tokens.
     *
     * @param serverId - Loader entry id.
     */
    async clear(serverId) {
      const data = await load()
      delete data.servers[serverId]
      await flush(data)
    },
    /** Every stored record, keyed by Loader entry id. */
    async all() {
      const data = await load()
      return { ...data.servers }
    },
  }
}

/**
 * Build the MCP `OAuthClientProvider` for one server.
 *
 * `clientId`/`clientSecret` are the escape hatch for authorization servers that
 * do not support dynamic registration (enterprise OIDC servers usually require
 * a pre-registered client): when present, `clientInformation()` answers from
 * configuration and the SDK never calls the registration endpoint.
 *
 * @param options - `{ store, serverId, redirectUrl, state, clientId, clientSecret, onAuthorizationUrl }`.
 * @returns the provider object.
 */
export function createProvider(options) {
  const { store, serverId, redirectUrl, state, clientId, clientSecret, onAuthorizationUrl } = options
  const session = { codeVerifier: undefined }

  const provider = {
    get redirectUrl() {
      return redirectUrl
    },
    get clientMetadata() {
      const metadata = {
        client_name: 'DeepSeek Harness MCP manager',
        redirect_uris: [redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: clientSecret === undefined ? 'none' : 'client_secret_post',
      }
      return metadata
    },
    state() {
      return state
    },
    async clientInformation() {
      if (clientId !== undefined && clientId !== '') {
        return clientSecret === undefined ? { client_id: clientId } : { client_id: clientId, client_secret: clientSecret }
      }
      const record = await store.read(serverId)
      return record?.clientInformation
    },
    async saveClientInformation(clientInformation) {
      await store.write(serverId, { clientInformation })
    },
    async tokens() {
      const record = await store.read(serverId)
      return record?.tokens
    },
    async saveTokens(tokens) {
      await store.write(serverId, { tokens, authorizedAt: new Date().toISOString() })
    },
    async saveCodeVerifier(codeVerifier) {
      session.codeVerifier = codeVerifier
      // Persisted as well: the callback leg may run after a Host restart.
      await store.write(serverId, { codeVerifier })
    },
    async codeVerifier() {
      if (session.codeVerifier !== undefined) return session.codeVerifier
      const record = await store.read(serverId)
      return record?.codeVerifier ?? ''
    },
    // Persisting discovery keeps the SEP-2352 check that the callback leg really
    // belongs to the authorization server this flow started against.
    async saveDiscoveryState(discoveryState) {
      await store.write(serverId, { discoveryState })
    },
    async discoveryState() {
      const record = await store.read(serverId)
      return record?.discoveryState
    },
    async redirectToAuthorization(authorizationUrl) {
      onAuthorizationUrl(authorizationUrl)
    },
    async invalidateCredentials(scope) {
      if (scope === 'all' || scope === 'tokens') await store.write(serverId, { tokens: undefined })
      if (scope === 'all' || scope === 'client') await store.write(serverId, { clientInformation: undefined })
      if (scope === 'all' || scope === 'verifier') session.codeVerifier = undefined
    },
  }
  return provider
}

/**
 * Start one interactive authorization attempt.
 *
 * Resolves as soon as the transport either connects (the server does not need
 * OAuth, or stored tokens are still valid) or produces an authorization URL.
 *
 * @param options - `{ modules, url, provider, timeoutMs }`.
 * @returns `{ status: 'authorized'|'redirect', transport, authorizationUrl? }`.
 * @throws when the connection fails for a reason other than needing authorization.
 */
export async function beginAuthorization(options) {
  const { modules, url, provider, timeoutMs = 20000 } = options
  let authorizationUrl = null
  let resolvedProvider = provider
  if (typeof resolvedProvider.redirectToAuthorization === 'function') {
    const original = resolvedProvider
    resolvedProvider = {
      ...original,
      redirectToAuthorization: (target) => {
        authorizationUrl = String(target)
        return original.redirectToAuthorization(target)
      },
    }
  }
  const transport = new modules.StreamableHTTPClientTransport(new URL(url), { authProvider: resolvedProvider })
  // `start()` alone does not issue a request, so the 401 challenge only appears
  // once a real handshake is attempted: `connect()` runs initialize.
  const client = new modules.Client(
    { name: 'dsh-mcp-config', version: '0.2.0' },
    { capabilities: {}, versionNegotiation: { mode: 'auto' } },
  )
  try {
    await withTimeout(client.connect(transport), timeoutMs, '等待服务器授权响应')
    return { status: 'authorized', transport, client, provider: resolvedProvider }
  } catch (error) {
    if (authorizationUrl !== null) {
      // The SDK stops at the redirect; the SAME transport instance must complete
      // the exchange later (it holds the PKCE verifier and discovery state).
      return { status: 'redirect', transport, client, provider: resolvedProvider, authorizationUrl: new URL(authorizationUrl) }
    }
    await Promise.resolve(client.close?.()).catch(() => {})
    throw error
  }
}

/**
 * Complete one authorization: exchange the code, persist tokens, close the transport.
 *
 * @param options - `{ transport, code, iss }`.
 * @returns nothing; tokens are in the provider's store afterwards.
 */
export async function finishAuthorization(options) {
  const { transport, code, iss } = options
  try {
    await withTimeout(transport.finishAuth(code, iss), 20000, '换取 access token')
  } finally {
    await Promise.resolve(transport.close?.()).catch(() => {})
  }
}

/**
 * Generate a state value that ties one callback back to its flow.
 *
 * @returns an opaque random state.
 */
export function newFlowState() {
  return randomUUID()
}

/**
 * Escape text for the tiny completion page.
 *
 * @param value - any text.
 * @returns HTML-safe text.
 */
export function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
