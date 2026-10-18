/**
 * Shared test helpers.
 *
 * The plugin resolves `yaml`, the MCP SDK, and `@deepseek-ai/dsh-subprocess` from
 * the Host installation, never from its own dependency tree. Tests resolve the
 * same modules the same way, so an assertion here exercises the code path the
 * Harness will actually take.
 *
 * @module test/helpers
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Absolute path of the dsh installation's `package.json`.
 *
 * @returns the resolver anchor.
 */
export function dshAnchor() {
  if (typeof process.env.DSH_ANCHOR === 'string' && process.env.DSH_ANCHOR !== '') return process.env.DSH_ANCHOR
  const bin = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()
  return join(dirname(realpathSync(bin)), '..', 'package.json')
}

/**
 * Require one module out of the Host installation.
 *
 * @param specifier - bare module name.
 * @returns the module namespace.
 */
export function hostRequire(specifier) {
  return createRequire(dshAnchor())(specifier)
}

/** A home-layer patch shaped like the real `$DSH_HOME/cordis.patch.yml`. */
export const HOME_PATCH = `# home-level user patch
- insert:
    # stdio server, mirrors what the app ships with
    - id: mcp-demo
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: demo-mcp
        transport: stdio
        command: node
        args: ['/tmp/demo-mcp/dist/index.js']
        env:
          DEMO_HOME: /tmp/demo
        toolCallTimeoutMs: 300000

    - id: mcp-knowledge
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: knowledge-demo
        transport: streamable-http
        url: https://example.test/mcp
        headers:
          Authorization: 'Bearer test-token'
- id: proxy-config
  config:
    proxy: http://127.0.0.1:7890
- id: guarded
  # a patch expression must survive a round-trip
  disabled: !!js "1 === 2"
`

/** A profile-layer patch shaped like the real `profiles/web/cordis.patch.yml`. */
export const PROFILE_PATCH = `# profile-level user patch
- id: mcp-config
  config: {}
- id: unrelated
  disabled: true
`

/**
 * Create a throwaway `$DSH_HOME` / profile pair.
 *
 * @param options - `{ home, profile }` file contents; both default to the fixtures.
 * @returns paths plus a cleanup function.
 */
export function makeFixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mcp-config-'))
  const home = join(root, 'home')
  const profile = join(root, 'profiles', 'web')
  mkdirSync(home, { recursive: true })
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(home, 'cordis.patch.yml'), options.home ?? HOME_PATCH)
  writeFileSync(join(profile, 'cordis.patch.yml'), options.profile ?? PROFILE_PATCH)
  return {
    root,
    home,
    profile,
    homePatch: join(home, 'cordis.patch.yml'),
    profilePatch: join(profile, 'cordis.patch.yml'),
    cleanup: () => { rmSync(root, { recursive: true, force: true }) },
  }
}

/**
 * Build a fake plugin context exposing exactly what the Host half reads.
 *
 * @param fixture - result of {@link makeFixture}.
 * @param options - `entries` and `toolNames` to expose as live state.
 * @returns `{ ctx, routes, entries }`.
 */
export function makeContext(fixture, options = {}) {
  const routes = new Map()
  const entries = options.entries ?? []
  const toolNames = options.toolNames ?? []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name === 'profileContext') {
        return {
          home: fixture.home,
          dir: fixture.profile,
          patchPath: fixture.profilePatch,
          installAnchor: dshAnchor(),
        }
      }
      if (name === 'loader') return { entries: () => entries[Symbol.iterator]() }
      if (name === 'tools') return { schemas: () => toolNames.map((toolName) => ({ name: toolName })) }
      return undefined
    },
    webServer: {
      port: options.port ?? 65535,
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    effect(execute) {
      const dispose = execute()
      return () => dispose?.()
    },
  }
  return { ctx, routes, entries }
}

/**
 * Invoke a registered route with a JSON body and collect the answer.
 *
 * @param route - registered route record.
 * @param body - request body object.
 * @returns `{ status, json }`.
 */
export async function callRoute(route, body) {
  const chunks = [Buffer.from(JSON.stringify(body))]
  const request = {
    method: 'POST',
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  let captured = null
  const response = {
    writeHead(status, headers) {
      captured = { status, headers, body: '' }
    },
    end(payload) {
      captured.body = String(payload ?? '')
    },
  }
  await route.handler(request, response)
  return { status: captured.status, json: captured.body === '' ? null : JSON.parse(captured.body) }
}

/**
 * Invoke a registered GET route (the OAuth callback) with a query string.
 *
 * @param route - registered route record.
 * @param rawUrl - request URL including the query string.
 * @returns `{ status, contentType, body }`.
 */
export async function callGet(route, rawUrl) {
  const request = { method: 'GET', url: rawUrl }
  let captured = null
  const response = {
    writeHead(status, headers) {
      captured = { status, headers, body: '' }
    },
    end(payload) {
      captured.body = String(payload ?? '')
    },
  }
  await route.handler(request, response)
  return { status: captured.status, contentType: captured.headers['content-type'] ?? '', body: captured.body }
}
