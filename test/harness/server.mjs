/**
 * Local UI harness for the Settings page.
 *
 * Serves the real `lib/client.js` bundle to a real browser against the real Host
 * half (`lib/index.js`) running on a throwaway copy of the two patch files, so an
 * interaction here exercises the same code the Harness will run — without writing
 * to the user's live configuration.
 *
 * Usage:
 *   node test/harness/server.mjs [--port 65499]
 *
 * The page is a stand-in for the Web shell: one registration point, `react` on
 * the platform table, a `slots` service, and the plugin's own JSON route.
 *
 * @module test/harness/server
 */
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { copyFileSync, existsSync, mkdirSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { API_PATH, apply } from '../../lib/index.js'
import { OAUTH_CALLBACK_PATH } from '../../lib/oauth.js'
import { dshAnchor } from '../helpers.mjs'
import { createMockOAuthServer } from '../mock-oauth-mcp-server.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, 'bundle.js')

/**
 * Copy the user's live patch files into a scratch profile so the harness shows
 * real servers while every write stays local to the scratch directory.
 *
 * @returns fixture paths.
 */
function makeFixture(oauthUrl) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mcp-config-ui-'))
  const home = join(root, 'home')
  const profile = join(root, 'profiles', 'web')
  mkdirSync(home, { recursive: true })
  mkdirSync(profile, { recursive: true })
  const realHome = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cordis.patch.yml')
  const realProfile = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'web', 'cordis.patch.yml')
  copyFileSync(existsSync(realHome) ? realHome : join(HERE, 'home.patch.yml'), join(home, 'cordis.patch.yml'))
  if (existsSync(realProfile)) copyFileSync(realProfile, join(profile, 'cordis.patch.yml'))
  else writeFileSync(join(profile, 'cordis.patch.yml'), '# scratch profile\n[]\n')
  // One server that always answers, so "测试连接" has a deterministic target.
  const patchPath = join(home, 'cordis.patch.yml')
  writeFileSync(patchPath, `${readFileSync(patchPath, 'utf8')}
- insert:
    - id: mcp-harness-dummy
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: harness-dummy
        transport: stdio
        command: ${JSON.stringify(process.execPath)}
        args: ['${join(HERE, '..', 'dummy-mcp-server.mjs')}']
    # Protected by the mock authorization server: exercises the OAuth button.
    - id: mcp-harness-oauth
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: harness-oauth
        transport: streamable-http
        url: ${oauthUrl}
`)
  return { root, home, profile, homePatch: patchPath, profilePatch: join(profile, 'cordis.patch.yml') }
}

/**
 * Build the browser bundle once per harness start.
 *
 * The React runtime comes from an existing local install; the shipped Web shell
 * supplies its own, so this is the stand-in only.
 *
 * @param reactRoot - directory containing the `react` and `react-dom` packages.
 */
function bundle(reactRoot) {
  const esbuild = join(reactRoot, '.bin', 'esbuild')
  execFileSync(esbuild, [
    join(HERE, 'entry.js'),
    '--bundle',
    '--format=esm',
    '--platform=browser',
    '--target=chrome110',
    '--outfile=' + BUNDLE,
    '--alias:react=' + join(reactRoot, 'react'),
    '--alias:react-dom=' + join(reactRoot, 'react-dom'),
    '--log-level=warning',
  ], { stdio: 'inherit' })
}

/**
 * Build a plugin context exposing only what the Host half reads.
 *
 * @param fixture - scratch paths.
 * @returns `{ ctx, route }`.
 */
function makeHost(fixture) {
  const routes = new Map()
  const ctx = {
    logger: { info() {}, warn(...args) { console.error('[host]', ...args) }, error(...args) { console.error('[host]', ...args) } },
    get(name) {
      if (name === 'profileContext') {
        return { home: fixture.home, dir: fixture.profile, patchPath: fixture.profilePatch, installAnchor: dshAnchor() }
      }
      if (name === 'loader') return { entries: () => [][Symbol.iterator]() }
      if (name === 'tools') return { schemas: () => [] }
      return undefined
    },
    webServer: {
      port: PORT,
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
  apply(ctx)
  return { ctx, route: routes.get(API_PATH), oauthCallback: routes.get(OAUTH_CALLBACK_PATH), routes }
}

/** The stand-in shell page. */
const PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<title>dsh-mcp-config UI harness</title>
<style>
  body{margin:0;padding:24px;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#1c1c1e;color:#e8e8ed}
  #root{max-width:900px;margin:0 auto}
  #harness-error{white-space:pre-wrap;color:#ff6b6b;font-family:ui-monospace,monospace;padding:12px;border:1px solid #ff6b6b55;border-radius:8px;margin-bottom:16px}
  #harness-meta{font-family:ui-monospace,monospace;font-size:11px;opacity:.55;margin-bottom:16px}
</style>
</head>
<body>
<div id="root"></div>
<script>
  window.__HARNESS__ = {
    registered: null,
    ready(info) {
      document.getElementById('harness-meta').textContent =
        'section id=' + info.id + ' label=' + info.label + ' order=' + String(info.order)
    },
    fail(text) {
      const box = document.createElement('div')
      box.id = 'harness-error'
      box.textContent = text
      document.body.prepend(box)
    },
  }
  window.__ModuleLoader__ = {
    load(row) {
      window.__HARNESS__.registered = { id: row.id, factory: row.factory }
    },
  }
  const meta = document.createElement('div')
  meta.id = 'harness-meta'
  meta.textContent = 'loading…'
  document.body.insertBefore(meta, document.getElementById('root'))
</script>
<script type="module" src="/harness.js"></script>
</body>
</html>`

const argv = process.argv.slice(2)
const portIndex = argv.indexOf('--port')
const PORT = portIndex >= 0 ? Number(argv[portIndex + 1]) : 65499
const port = PORT
const reactRoot = process.env.HARNESS_REACT
  ?? join(homedir(), 'git', 'company_projects', 'tool_pwa_notes', 'node_modules')

const mockOAuth = createMockOAuthServer()
const mockPort = await mockOAuth.listen(0)
const fixture = makeFixture(`http://127.0.0.1:${String(mockPort)}/mcp`)
bundle(reactRoot)
const host = makeHost(fixture)

createServer((req, res) => {
  if (req.url === '/' || req.url?.startsWith('/?')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
    return
  }
  if (req.url === '/harness.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
    res.end(readFileSync(BUNDLE))
    return
  }
  if (req.url === API_PATH) {
    host.route.handler(req, res)
    return
  }
  if (req.url?.startsWith(OAUTH_CALLBACK_PATH)) {
    host.oauthCallback.handler(req, res)
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
}).listen(port, '127.0.0.1', () => {
  console.log(`harness: http://127.0.0.1:${String(port)}`)
  console.log(`harness fixture: ${fixture.root}`)
  console.log(`harness home patch: ${fixture.homePatch}`)
})
