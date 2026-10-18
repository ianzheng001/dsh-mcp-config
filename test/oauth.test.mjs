/**
 * End-to-end OAuth authorization tests.
 *
 * A local mock plays both roles the real flow needs — the OAuth-protected MCP
 * endpoint and the authorization server — so this covers the whole chain the
 * Settings page triggers: 401 challenge → RFC 9728 discovery → dynamic client
 * registration → PKCE authorize → loopback callback → token exchange → the
 * access token persisted as the server's `Authorization` header.
 *
 * @module test/oauth.test
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  API_PATH,
  apply,
  collectState,
} from '../lib/index.js'
import { OAUTH_CALLBACK_PATH, OAUTH_STATE_FILENAME } from '../lib/oauth.js'
import { listRows, parsePatch } from '../lib/patch.js'
import { callGet, callRoute, hostRequire, makeContext, makeFixture } from './helpers.mjs'
import { ACCESS_TOKEN, createMockOAuthServer } from './mock-oauth-mcp-server.mjs'

const yaml = hostRequire('yaml')

/**
 * Fixture whose single server is the mock's protected endpoint.
 *
 * @param url - mock MCP endpoint URL.
 * @returns fixture plus a helpers bundle.
 */
function setup(url) {
  const fixture = makeFixture({
    home: `- insert:
    - id: mcp-oauth
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: oauth-srv
        transport: streamable-http
        url: ${url}
`,
    profile: `- id: unrelated
  disabled: true
`,
  })
  const { ctx, routes } = makeContext(fixture)
  apply(ctx)
  return {
    fixture,
    ctx,
    api: routes.get(API_PATH),
    callback: routes.get(OAUTH_CALLBACK_PATH),
    readRows: () => listRows(yaml, parsePatch(yaml, readFileSync(fixture.homePatch, 'utf8'))),
  }
}

test('the mock really protects the endpoint until a token is presented', async () => {
  const mock = createMockOAuthServer()
  const port = await mock.listen(0)
  try {
    const { api, fixture } = setup(`http://127.0.0.1:${String(port)}/mcp`)
    try {
      const { json } = await callRoute(api, {
        op: 'test',
        server: { id: 'mcp-oauth', serverName: 'oauth-srv', transport: 'streamable-http', url: `http://127.0.0.1:${String(port)}/mcp` },
      })
      assert.equal(json.ok, true)
      assert.equal(json.result.ok, false, 'an unauthenticated probe must fail')
      assert.match(json.result.error, /401|unauthori[sz]ed|invalid_token/i)
    } finally {
      fixture.cleanup()
    }
  } finally {
    await mock.close()
  }
})

test('oauth-start discovers the AS and returns an authorize URL', async () => {
  const mock = createMockOAuthServer()
  const port = await mock.listen(0)
  try {
    const { api, fixture } = setup(`http://127.0.0.1:${String(port)}/mcp`)
    try {
      const { json } = await callRoute(api, { op: 'oauth-start', id: 'mcp-oauth' })
      assert.equal(json.ok, true, JSON.stringify(json))
      assert.equal(json.status, 'redirect')
      assert.match(json.authorizationUrl, /\/authorize\?/)
      assert.equal(json.state.length > 8, true)
      assert.equal(mock.state.registrations.length, 1, 'dynamic client registration was attempted')
      const registration = mock.state.registrations[0]
      assert.ok(Array.isArray(registration.redirect_uris))
      assert.match(registration.redirect_uris[0], /^http:\/\/127\.0\.0\.1:65535\/dsh-mcp-config\/oauth\/callback$/)
    } finally {
      fixture.cleanup()
    }
  } finally {
    await mock.close()
  }
})

test('the full flow persists tokens, writes the header, and the server then answers', async () => {
  const mock = createMockOAuthServer()
  const port = await mock.listen(0)
  try {
    const { api, callback, fixture, readRows } = setup(`http://127.0.0.1:${String(port)}/mcp`)
    try {
      const started = (await callRoute(api, { op: 'oauth-start', id: 'mcp-oauth' })).json
      assert.equal(started.status, 'redirect', JSON.stringify(started))

      // Play the browser: hit /authorize, follow the AS redirect to our callback.
      const authorize = await fetch(started.authorizationUrl, { redirect: 'manual' })
      assert.equal(authorize.status, 302)
      const location = authorize.headers.get('location')
      assert.ok(location !== null)
      const callbackUrl = new URL(location)
      assert.equal(`${callbackUrl.pathname}${callbackUrl.search}`, `${OAUTH_CALLBACK_PATH}${callbackUrl.search}`)
      assert.equal(callbackUrl.searchParams.get('state'), started.state)

      // The browser then loads the callback URL; our handler exchanges the code.
      const page = await callGet(callback, `${callbackUrl.pathname}${callbackUrl.search}`)
      assert.equal(page.status, 200, page.body)
      assert.match(page.contentType, /text\/html/)
      assert.match(page.body, /授权成功/)

      // The access token became the row's Authorization header.
      const row = readRows().find((entry) => entry.id === 'mcp-oauth')
      assert.equal(row.config.headers.Authorization, `Bearer ${ACCESS_TOKEN}`)

      // Tokens are stored outside the patch file.
      const stored = JSON.parse(readFileSync(`${fixture.home}/${OAUTH_STATE_FILENAME}`, 'utf8'))
      assert.equal(stored.servers['mcp-oauth'].tokens.access_token, ACCESS_TOKEN)
      assert.ok(stored.servers['mcp-oauth'].clientInformation.client_id.startsWith('mock-client-'))

      // Status reports the live probe result for the now-authorized server.
      const status = (await callRoute(api, { op: 'oauth-status', state: started.state })).json
      assert.equal(status.status, 'authorized', JSON.stringify(status))
      assert.equal(status.probe.ok, true, JSON.stringify(status.probe))
      assert.deepEqual(status.probe.tools.map((tool) => tool.name), ['mock_protected_tool'])

      // And the state view now advertises the authorization.
      const state = (await callRoute(api, { op: 'state' })).json
      assert.equal(state.servers[0].oauth.authorized, true)
      assert.equal(state.servers[0].oauth.clientRegistered, true)
      assert.match(state.oauthCallback, /\/dsh-mcp-config\/oauth\/callback$/)
    } finally {
      fixture.cleanup()
    }
  } finally {
    await mock.close()
  }
})

test('state reports an unauthenticated http server as not authorized', async () => {
  const mock = createMockOAuthServer()
  const port = await mock.listen(0)
  try {
    const fixture = makeFixture({
      home: `- insert:
    - id: mcp-oauth
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: oauth-srv
        transport: streamable-http
        url: http://127.0.0.1:${String(port)}/mcp
`,
    })
    const { ctx } = makeContext(fixture)
    try {
      const state = await collectState(ctx, async (name) => hostRequire(name))
      assert.equal(state.servers[0].oauth.available, true)
      assert.equal(state.servers[0].oauth.authorized, false)
    } finally {
      fixture.cleanup()
    }
  } finally {
    await mock.close()
  }
})

test('a token-endpoint failure surfaces as an authorization error page', async () => {
  const mock = createMockOAuthServer()
  const port = await mock.listen(0)
  try {
    const { api, callback, fixture } = setup(`http://127.0.0.1:${String(port)}/mcp`)
    try {
      const started = (await callRoute(api, { op: 'oauth-start', id: 'mcp-oauth' })).json
      mock.state.failToken = true
      const authorize = await fetch(started.authorizationUrl, { redirect: 'manual' })
      const callbackUrl = new URL(authorize.headers.get('location'))
      const page = await callGet(callback, `${callbackUrl.pathname}${callbackUrl.search}`)
      assert.equal(page.status, 500)
      assert.match(page.body, /授权失败/)
      const status = (await callRoute(api, { op: 'oauth-status', state: started.state })).json
      assert.equal(status.status, 'error')
      assert.match(status.message, /invalid_grant|token/i)
    } finally {
      fixture.cleanup()
    }
  } finally {
    await mock.close()
  }
})

test('oauth-start refuses stdio servers and unknown ids', async () => {
  const fixture = makeFixture()
  const { ctx, routes } = makeContext(fixture)
  apply(ctx)
  const api = routes.get(API_PATH)
  try {
    const stdio = (await callRoute(api, { op: 'oauth-start', id: 'mcp-demo' })).json
    assert.equal(stdio.ok, false)
    assert.equal(stdio.code, 'transport')
    const missing = (await callRoute(api, { op: 'oauth-start', id: 'nope' })).json
    assert.equal(missing.code, 'not-found')
  } finally {
    fixture.cleanup()
  }
})

test('oauth-forget clears stored credentials', async () => {
  const mock = createMockOAuthServer()
  const port = await mock.listen(0)
  try {
    const { api, callback, fixture } = setup(`http://127.0.0.1:${String(port)}/mcp`)
    try {
      const started = (await callRoute(api, { op: 'oauth-start', id: 'mcp-oauth' })).json
      const authorize = await fetch(started.authorizationUrl, { redirect: 'manual' })
      const callbackUrl = new URL(authorize.headers.get('location'))
      await callGet(callback, `${callbackUrl.pathname}${callbackUrl.search}`)
      const forget = (await callRoute(api, { op: 'oauth-forget', id: 'mcp-oauth' })).json
      assert.equal(forget.ok, true)
      const state = (await callRoute(api, { op: 'state' })).json
      assert.equal(state.servers[0].oauth.authorized, false)
    } finally {
      fixture.cleanup()
    }
  } finally {
    await mock.close()
  }
})
