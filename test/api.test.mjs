/**
 * End-to-end tests for the Host half: every Settings action goes through the
 * registered JSON route and is asserted against the patch files on disk, which is
 * exactly what the Loader's watcher will reconcile.
 *
 * @module test/api.test
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  API_PATH,
  buildConfig,
  collectState,
  apply,
  hashOf,
  validateServerInput,
} from '../lib/index.js'
import { MCP_CLIENT_PLUGIN, listRows, parsePatch } from '../lib/patch.js'
import { callRoute, hostRequire, makeContext, makeFixture } from './helpers.mjs'

const yaml = hostRequire('yaml')
const DUMMY_SERVER = fileURLToPath(new URL('./dummy-mcp-server.mjs', import.meta.url))

/**
 * Build a fixture plus a live route.
 *
 * @param options - live entries and tool names.
 * @returns fixture, route, and helpers.
 */
function setup(options = {}) {
  const fixture = makeFixture()
  const { ctx, routes } = makeContext(fixture, options)
  apply(ctx)
  const route = routes.get(API_PATH)
  assert.ok(route !== undefined, 'the Host half must register its route')
  const read = (which) => readRows(which === 'home' ? fixture.homePatch : fixture.profilePatch)
  return { fixture, ctx, route, read }
}

/**
 * Parse one patch file into rows.
 *
 * @param path - file path.
 * @returns row references.
 */
function readRows(path) {
  return listRows(yaml, parsePatch(yaml, readFileSync(path, 'utf8')))
}

test('state lists both patch layers with sources and hashes', async () => {
  const { fixture, route } = setup()
  try {
    const { status, json } = await callRoute(route, { op: 'state' })
    assert.equal(status, 200)
    assert.equal(json.ok, true)
    assert.deepEqual(json.servers.map((server) => server.serverName), ['demo-mcp', 'knowledge-demo'])
    assert.deepEqual(json.servers.map((server) => server.source), ['home', 'home'])
    assert.equal(json.servers[0].editable, true)
    assert.equal(json.servers[0].config.command, 'node')
    assert.equal(json.servers[1].transport, 'streamable-http')
    assert.equal(json.files.home.hash, hashOf(readFileSync(fixture.homePatch, 'utf8')))
    assert.equal(json.files.profile.path, fixture.profilePatch)
    assert.equal(json.files.home.error, null)
  } finally {
    fixture.cleanup()
  }
})

test('live tool prefixes become the connection status', async () => {
  const { fixture, route } = setup({
    entries: [
      { options: { id: 'mcp-demo', name: MCP_CLIENT_PLUGIN, config: { serverName: 'demo-mcp' } }, disabled: false, fiber: { state: 2 } },
    ],
    toolNames: ['mcp__demo-mcp__GetObject', 'mcp__demo-mcp__SearchObject', 'read_file'],
  })
  try {
    const { json } = await callRoute(route, { op: 'state' })
    const demo = json.servers.find((server) => server.id === 'mcp-demo')
    assert.equal(demo.live.mounted, true)
    assert.equal(demo.live.toolCount, 2)
    const knowledge = json.servers.find((server) => server.id === 'mcp-knowledge')
    assert.equal(knowledge.live.mounted, false)
  } finally {
    fixture.cleanup()
  }
})

test('a loader entry without a patch row is listed read-only', async () => {
  const { fixture, route } = setup({
    entries: [
      { options: { id: 'from-bundle', name: MCP_CLIENT_PLUGIN, config: { serverName: 'bundle-srv', transport: 'stdio' } }, disabled: false, fiber: { state: 2 } },
    ],
    toolNames: [],
  })
  try {
    const { json } = await callRoute(route, { op: 'state' })
    const bundle = json.servers.find((server) => server.id === 'from-bundle')
    assert.equal(bundle.source, 'loader')
    assert.equal(bundle.editable, false)
    assert.equal(bundle.serverName, 'bundle-srv')
  } finally {
    fixture.cleanup()
  }
})

test('save creates a row in the requested layer', async () => {
  const { fixture, route, read } = setup()
  try {
    const before = (await callRoute(route, { op: 'state' })).json
    const { json } = await callRoute(route, {
      op: 'save',
      originalId: '',
      target: 'profile',
      hashes: { home: before.files.home.hash, profile: before.files.profile.hash },
      server: {
        id: 'mcp-local',
        serverName: 'local-tools',
        transport: 'stdio',
        command: process.execPath,
        args: [DUMMY_SERVER],
        env: { MCP_SMOKE_LOG: '/tmp/never-written.log' },
        toolCallTimeoutMs: 12345,
      },
    })
    assert.equal(json.ok, true, JSON.stringify(json))
    const created = read('profile').find((row) => row.id === 'mcp-local')
    assert.ok(created !== undefined, 'the profile patch must carry the new row')
    assert.equal(created.name, MCP_CLIENT_PLUGIN)
    assert.equal(created.config.serverName, 'local-tools')
    assert.deepEqual(created.config.args, [DUMMY_SERVER])
    assert.equal(created.config.toolCallTimeoutMs, 12345)
    const listed = json.state.servers.find((server) => server.id === 'mcp-local')
    assert.equal(listed.source, 'profile')
    assert.match(readFileSync(fixture.profilePatch, 'utf8'), /# profile-level user patch/, 'existing comments survive')
  } finally {
    fixture.cleanup()
  }
})

test('save creates into the home insert block by default', async () => {
  const { fixture, route, read } = setup()
  try {
    const before = (await callRoute(route, { op: 'state' })).json
    const { json } = await callRoute(route, {
      op: 'save',
      originalId: '',
      hashes: { home: before.files.home.hash, profile: before.files.profile.hash },
      server: { id: 'mcp-extra', serverName: 'extra', transport: 'streamable-http', url: 'https://example.test/extra' },
    })
    assert.equal(json.ok, true, JSON.stringify(json))
    const created = read('home').find((row) => row.id === 'mcp-extra')
    assert.ok(created !== undefined)
    assert.equal(created.kind, 'insert', 'it joins the existing insert list')
    assert.equal(readFileSync(fixture.homePatch, 'utf8').match(/- insert:/g).length, 1)
  } finally {
    fixture.cleanup()
  }
})

test('save edits an existing row in place and keeps unmanaged keys', async () => {
  const { fixture, route, read } = setup()
  try {
    const before = (await callRoute(route, { op: 'state' })).json
    const demo = before.servers.find((server) => server.id === 'mcp-demo')
    const { json } = await callRoute(route, {
      op: 'save',
      originalId: 'mcp-demo',
      hashes: { home: before.files.home.hash, profile: before.files.profile.hash },
      server: {
        id: 'mcp-demo',
        serverName: 'demo-mcp',
        transport: 'stdio',
        command: 'node',
        args: ['/tmp/demo-mcp/dist/index.js'],
        env: { DEMO_HOME: '/tmp/demo' },
        toolCallTimeoutMs: 60000,
      },
    })
    assert.equal(json.ok, true, JSON.stringify(json))
    const edited = read('home').find((row) => row.id === 'mcp-demo')
    assert.equal(edited.config.toolCallTimeoutMs, 60000)
    assert.equal(demo.config.failOnStartupError, undefined)
    assert.doesNotMatch(readFileSync(fixture.homePatch, 'utf8'), /disabled: true/)
  } finally {
    fixture.cleanup()
  }
})

test('save rejects invalid and duplicate server names', async () => {
  const { fixture, route } = setup()
  try {
    const before = (await callRoute(route, { op: 'state' })).json
    const hashes = { home: before.files.home.hash, profile: before.files.profile.hash }
    const duplicate = await callRoute(route, {
      op: 'save',
      originalId: '',
      hashes,
      server: { id: 'mcp-dup', serverName: 'demo-mcp', transport: 'stdio', command: 'node' },
    })
    assert.equal(duplicate.json.ok, false)
    assert.equal(duplicate.json.code, 'invalid')
    assert.ok(duplicate.json.errors.some((message) => message.includes('demo-mcp')))

    const emptyCommand = await callRoute(route, {
      op: 'save',
      originalId: '',
      hashes,
      server: { id: 'mcp-bad', serverName: 'bad-one', transport: 'stdio', command: '  ' },
    })
    assert.equal(emptyCommand.json.ok, false)
    assert.equal(emptyCommand.json.code, 'invalid')
  } finally {
    fixture.cleanup()
  }
})

test('a stale file hash is a conflict, not a clobber', async () => {
  const { fixture, route } = setup()
  try {
    const { json } = await callRoute(route, {
      op: 'enabled',
      id: 'mcp-demo',
      enabled: false,
      hashes: { home: 'not-the-current-hash', profile: 'x' },
    })
    assert.equal(json.ok, false)
    assert.equal(json.code, 'conflict')
    assert.ok(json.state !== undefined, 'the refusal carries fresh state so the page can recover')
    assert.match(readFileSync(fixture.homePatch, 'utf8'), /serverName: demo-mcp/)
  } finally {
    fixture.cleanup()
  }
})

test('enabled flips disabled on and off in place', async () => {
  const { fixture, route, read } = setup()
  try {
    let state = (await callRoute(route, { op: 'state' })).json
    const off = await callRoute(route, {
      op: 'enabled',
      id: 'mcp-demo',
      enabled: false,
      hashes: { home: state.files.home.hash, profile: state.files.profile.hash },
    })
    assert.equal(off.json.ok, true, JSON.stringify(off.json))
    assert.equal(read('home').find((row) => row.id === 'mcp-demo').disabled, true)

    state = off.json.state
    const on = await callRoute(route, {
      op: 'enabled',
      id: 'mcp-demo',
      enabled: true,
      hashes: { home: state.files.home.hash, profile: state.files.profile.hash },
    })
    assert.equal(on.json.ok, true, JSON.stringify(on.json))
    const row = read('home').find((entry) => entry.id === 'mcp-demo')
    assert.equal(row.disabled, false)
    assert.equal(on.json.state.servers.find((server) => server.id === 'mcp-demo').disabled, false)
  } finally {
    fixture.cleanup()
  }
})

test('remove deletes the row and keeps unrelated entries', async () => {
  const { fixture, route, read } = setup()
  try {
    const before = (await callRoute(route, { op: 'state' })).json
    const { json } = await callRoute(route, {
      op: 'remove',
      id: 'mcp-knowledge',
      hashes: { home: before.files.home.hash, profile: before.files.profile.hash },
    })
    assert.equal(json.ok, true, JSON.stringify(json))
    assert.equal(read('home').some((row) => row.id === 'mcp-knowledge'), false)
    assert.equal(read('home').some((row) => row.id === 'mcp-demo'), true, 'siblings survive')
    assert.equal(read('home').some((row) => row.id === 'proxy-config'), true, 'other plugins survive')
    assert.equal(json.state.servers.some((server) => server.id === 'mcp-knowledge'), false)
  } finally {
    fixture.cleanup()
  }
})

test('remove on an unknown id reports not-found', async () => {
  const { fixture, route } = setup()
  try {
    const { json } = await callRoute(route, { op: 'remove', id: 'nope', hashes: {} })
    assert.equal(json.ok, false)
    assert.equal(json.code, 'not-found')
  } finally {
    fixture.cleanup()
  }
})

test('unknown ops are refused', async () => {
  const { fixture, route } = setup()
  try {
    const { json } = await callRoute(route, { op: 'launch-missiles' })
    assert.equal(json.ok, false)
    assert.equal(json.code, 'bad-op')
  } finally {
    fixture.cleanup()
  }
})

test('test op handshakes with a real stdio server', async () => {
  const { fixture, route } = setup()
  try {
    const { json } = await callRoute(route, {
      op: 'test',
      server: {
        id: 'probe',
        serverName: 'probe-target',
        transport: 'stdio',
        command: process.execPath,
        args: [DUMMY_SERVER],
      },
    })
    assert.equal(json.ok, true, JSON.stringify(json))
    assert.equal(json.result.ok, true, JSON.stringify(json.result))
    assert.equal(json.result.serverInfo.name, 'dummy-smoke')
    assert.deepEqual(json.result.tools.map((tool) => tool.name), ['smoke_ping'])
  } finally {
    fixture.cleanup()
  }
})

test('test op reports a broken command instead of throwing', async () => {
  const { fixture, route } = setup()
  try {
    const { json } = await callRoute(route, {
      op: 'test',
      server: { id: 'probe', serverName: 'missing', transport: 'stdio', command: '/nonexistent/mcp-binary-xyz', args: [] },
    })
    assert.equal(json.ok, true, 'the op itself succeeded')
    assert.equal(json.result.ok, false)
    assert.match(json.result.error, /mcp-binary-xyz|ENOENT|not found|spawn/i)
    assert.equal(json.result.elapsedMs >= 0, true)
  } finally {
    fixture.cleanup()
  }
})

test('buildConfig drops managed fields of the other transport and keeps extras', () => {
  const stdio = buildConfig(
    { id: 'x', serverName: 'x', transport: 'stdio', command: 'node', args: [], env: {}, toolCallTimeoutMs: 0 },
    { transport: 'stdio', failOnStartupError: true, maxInstructionBytes: 4096, url: 'stale' },
  )
  assert.equal(stdio.toolCallTimeoutMs, 60000)
  assert.equal(stdio.failOnStartupError, true)
  assert.equal(stdio.maxInstructionBytes, 4096)
  assert.equal(Object.hasOwn(stdio, 'url'), false)

  const http = buildConfig(
    { id: 'y', serverName: 'y', transport: 'streamable-http', url: 'https://example.test/mcp', headers: { A: '1' } },
    { transport: 'stdio', failOnStartupError: true },
  )
  assert.equal(http.url, 'https://example.test/mcp')
  assert.deepEqual(http.headers, { A: '1' })
  assert.equal(http.failOnStartupError, undefined, 'stdio extras are not carried into another transport')
})

test('validateServerInput enforces the tool-name contract', () => {
  const files = { home: { rows: [] }, profile: { rows: [] } }
  assert.deepEqual(validateServerInput(
    { id: 'ok-id_1', serverName: 'ok_name-1', transport: 'stdio', command: 'node' },
    { files, originalId: '' },
  ), [])
  assert.match(validateServerInput({ id: 'bad id', serverName: 's', transport: 'stdio', command: 'node' }, { files, originalId: '' })[0], /id/)
  assert.match(validateServerInput({ id: 'a', serverName: 'bad name!', transport: 'stdio', command: 'node' }, { files, originalId: '' })[0], /serverName/)
  assert.match(validateServerInput({ id: 'a', serverName: 's', transport: 'streamable-http', url: 'ftp://x' }, { files, originalId: '' })[0], /http/)
})

test('collectState survives a malformed patch file and reports it', async () => {
  const fixture = makeFixture({ home: '- insert: [\n' })
  try {
    const { ctx } = makeContext(fixture)
    const state = await collectState(ctx, async (specifier) => hostRequire(specifier))
    assert.equal(state.ok, true)
    assert.match(state.files.home.error, /YAML/)
    assert.deepEqual(state.servers.map((server) => server.id), [])
  } finally {
    fixture.cleanup()
  }
})
