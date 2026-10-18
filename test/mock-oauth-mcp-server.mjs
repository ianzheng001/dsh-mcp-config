/**
 * Mock OAuth-protected MCP server for the authentication tests.
 *
 * Three things in one process, on one loopback port:
 *
 * 1. an RFC 9728 protected-resource metadata document plus an RFC 8414
 *    authorization-server metadata document (so the client's discovery works),
 * 2. a minimal OAuth authorization server: dynamic client registration,
 *    `/authorize` (immediately "approves" and redirects with a code) and `/token`
 *    (code + PKCE verifier → access token), and
 * 3. a Streamable HTTP MCP endpoint that answers `401` with a
 *    `WWW-Authenticate: Bearer resource_metadata=...` challenge until a real
 *    bearer token arrives — that challenge is what makes the interactive flow start.
 *
 * Run standalone for manual poking: `node test/mock-oauth-mcp-server.mjs --port 65510`
 *
 * @module test/mock-oauth-mcp-server
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

/** The one bearer token this mock accepts. */
export const ACCESS_TOKEN = 'mock-access-token'
export const REFRESH_TOKEN = 'mock-refresh-token'

/**
 * Build the mock without listening (tests drive it directly).
 *
 * @param options - `{ port }` used inside URLs; defaults to the actual bound port at listen time.
 * @returns `{ server, state, listen, close }`.
 */
export function createMockOAuthServer() {
  const state = {
    port: 0,
    registrations: [],
    codes: new Map(),
    tokens: new Set(),
    requests: [],
    /** Set to force /token or /authorize failures in a test. */
    failToken: false,
    /** Authorization requests received, in order. */
    authorizations: [],
  }

  const base = () => `http://127.0.0.1:${String(state.port)}`

  const json = (res, status, body, headers = {}) => {
    const text = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers })
    res.end(text)
  }

  const readBody = async (req) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf8')
  }

  /** Handle one JSON-RPC message and write the MCP response. */
  const handleMcp = async (req, res) => {
    const body = JSON.parse(await readBody(req))
    const reply = (result) => json(res, 200, { jsonrpc: '2.0', id: body.id, result })
    if (body.id === undefined) {
      res.writeHead(202).end()
      return
    }
    switch (body.method) {
      case 'initialize':
        return reply({
          protocolVersion: body.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-oauth-server', version: '1.0.0' },
        })
      case 'tools/list':
        return reply({ tools: [{ name: 'mock_protected_tool', description: 'Only exists behind OAuth.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] })
      case 'tools/call':
        return reply({ content: [{ type: 'text', text: 'authorized' }] })
      case 'ping':
        return reply({})
      default:
        return reply({})
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base())
    state.requests.push(`${req.method ?? '?'} ${url.pathname}`)

    if (url.pathname === '/.well-known/oauth-protected-resource') {
      return json(res, 200, { resource: `${base()}/mcp`, authorization_servers: [base()] })
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(res, 200, {
        issuer: base(),
        authorization_endpoint: `${base()}/authorize`,
        token_endpoint: `${base()}/token`,
        registration_endpoint: `${base()}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      })
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      const registration = JSON.parse(await readBody(req))
      state.registrations.push(registration)
      return json(res, 201, {
        client_id: `mock-client-${String(state.registrations.length)}`,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: registration.redirect_uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
      })
    }
    if (url.pathname === '/authorize') {
      state.authorizations.push(Object.fromEntries(url.searchParams))
      const redirect = url.searchParams.get('redirect_uri')
      const code = randomUUID()
      state.codes.set(code, { challenge: url.searchParams.get('code_challenge'), method: url.searchParams.get('code_challenge_method') })
      if (redirect === null) return json(res, 400, { error: 'invalid_request' })
      const target = new URL(redirect)
      target.searchParams.set('code', code)
      const echo = url.searchParams.get('state')
      if (echo !== null) target.searchParams.set('state', echo)
      res.writeHead(302, { location: target.toString() })
      res.end()
      return
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req))
      if (state.failToken) return json(res, 400, { error: 'invalid_grant' })
      if (form.get('grant_type') === 'authorization_code') {
        const code = form.get('code')
        const entry = state.codes.get(code)
        if (entry === undefined) return json(res, 400, { error: 'invalid_grant' })
        state.codes.delete(code)
        if (entry.challenge !== null) {
          // The verifier must hash (S256) to the stored challenge.
          const { createHash } = await import('node:crypto')
          const verifier = form.get('code_verifier') ?? ''
          const digest = createHash('sha256').update(verifier).digest('base64url')
          if (digest !== entry.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE mismatch' })
        }
      } else if (form.get('grant_type') !== 'refresh_token') {
        return json(res, 400, { error: 'unsupported_grant_type' })
      }
      state.tokens.add(ACCESS_TOKEN)
      return json(res, 200, {
        access_token: ACCESS_TOKEN,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: REFRESH_TOKEN,
        scope: 'mcp',
      })
    }
    if (url.pathname === '/mcp') {
      const authorization = req.headers.authorization
      if (authorization !== `Bearer ${ACCESS_TOKEN}`) {
        return json(res, 401, { error: 'invalid_token' }, {
          'www-authenticate': `Bearer resource_metadata="${base()}/.well-known/oauth-protected-resource"`,
        })
      }
      if (req.method === 'GET') {
        res.writeHead(405).end()
        return
      }
      try {
        await handleMcp(req, res)
      } catch (error) {
        json(res, 500, { error: String(error.message ?? error) })
      }
      return
    }
    json(res, 404, { error: 'not_found' })
  })

  return {
    state,
    server,
    listen: (port = 0) => new Promise((resolve) => {
      server.listen(port, '127.0.0.1', () => {
        state.port = server.address().port
        resolve(state.port)
      })
    }),
    close: () => new Promise((resolve) => { server.close(() => resolve()) }),
  }
}

if (process.argv[1]?.endsWith('mock-oauth-mcp-server.mjs') === true) {
  const index = process.argv.indexOf('--port')
  const mock = createMockOAuthServer()
  const port = await mock.listen(index >= 0 ? Number(process.argv[index + 1]) : 0)
  console.log(`mock oauth mcp server: http://127.0.0.1:${String(port)}/mcp`)
}
