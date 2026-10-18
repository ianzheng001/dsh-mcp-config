/**
 * Unit tests for the patch-file layer: row discovery, mutation, and the promise
 * that a write touches only the row it names (comments, tags, and unrelated
 * entries survive).
 *
 * @module test/patch.test
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MCP_CLIENT_PLUGIN,
  appendRow,
  deleteRow,
  findDefinition,
  findRow,
  listRows,
  parsePatch,
  renameRow,
  setConfig,
  setDisabled,
  stringifyPatch,
} from '../lib/patch.js'
import { HOME_PATCH, hostRequire } from './helpers.mjs'

const yaml = hostRequire('yaml')

/** Parse the home fixture fresh for each test. */
function home() {
  return parsePatch(yaml, HOME_PATCH)
}

test('listRows finds insert rows and top-level rows', () => {
  const rows = listRows(yaml, home())
  assert.deepEqual(rows.map((row) => row.id), ['mcp-demo', 'mcp-knowledge', 'proxy-config', 'guarded'])
  const demo = rows[0]
  assert.equal(demo.isDefinition, true)
  assert.equal(demo.name, MCP_CLIENT_PLUGIN)
  assert.equal(demo.kind, 'insert')
  assert.equal(demo.config.serverName, 'demo-mcp')
  assert.deepEqual(demo.config.args, ['/tmp/demo-mcp/dist/index.js'])
  assert.equal(rows[2].isDefinition, false, 'non-mcp rows are still addressable')
})

test('findDefinition prefers the row that carries the plugin name', () => {
  const rows = listRows(yaml, home())
  assert.equal(findDefinition(rows, 'mcp-demo').id, 'mcp-demo')
  assert.equal(findDefinition(rows, 'proxy-config'), undefined)
  assert.equal(findRow(rows, 'proxy-config').id, 'proxy-config')
})

test('setDisabled writes and clears the flag', () => {
  const doc = home()
  const row = findDefinition(listRows(yaml, doc), 'mcp-demo')
  setDisabled(row, true)
  assert.equal(findDefinition(listRows(yaml, doc), 'mcp-demo').disabled, true)
  assert.match(stringifyPatch(doc), /id: mcp-demo\n\s+name: '@deepseek-ai\/dsh-mcp-client'[\s\S]*disabled: true/)
  setDisabled(findDefinition(listRows(yaml, doc), 'mcp-demo'), false)
  assert.equal(findDefinition(listRows(yaml, doc), 'mcp-demo').disabled, false)
  assert.doesNotMatch(stringifyPatch(doc), /disabled: true/)
})

test('setConfig replaces config, keeps comments and the js tag', () => {
  const doc = home()
  const row = findDefinition(listRows(yaml, doc), 'mcp-demo')
  setConfig(doc, row, { serverName: 'demo-mcp', transport: 'stdio', command: 'node', args: [], toolCallTimeoutMs: 1000 })
  const text = stringifyPatch(doc)
  assert.match(text, /# home-level user patch/)
  assert.match(text, /# stdio server, mirrors what the app ships with/)
  assert.match(text, /# a patch expression must survive a round-trip/)
  assert.match(text, /disabled: !!js "1 === 2"/)
  assert.match(text, /toolCallTimeoutMs: 1000/)
  assert.doesNotMatch(text, /toolCallTimeoutMs: 300000/)
})

test('renameRow changes the id only', () => {
  const doc = home()
  const row = findDefinition(listRows(yaml, doc), 'mcp-demo')
  renameRow(row, 'mcp-demo-2')
  const ids = listRows(yaml, doc).map((entry) => entry.id)
  assert.ok(ids.includes('mcp-demo-2'))
  assert.ok(!ids.includes('mcp-demo'))
  assert.match(stringifyPatch(doc), /serverName: demo-mcp/)
})

test('appendRow uses the existing insert block and creates one when absent', () => {
  const withBlock = home()
  appendRow(yaml, withBlock, { id: 'mcp-extra', config: { serverName: 'extra', transport: 'stdio', command: 'node' } })
  const ids = listRows(yaml, withBlock).map((row) => row.id)
  assert.ok(ids.includes('mcp-extra'))
  assert.equal((stringifyPatch(withBlock).match(/- insert:/g) ?? []).length, 1, 'no second insert block is created')

  const bare = parsePatch(yaml, '- id: unrelated\n  disabled: true\n')
  appendRow(yaml, bare, { id: 'mcp-new', config: { serverName: 'new', transport: 'stdio', command: 'node' } })
  const text = stringifyPatch(bare)
  assert.match(text, /- insert:/)
  assert.match(text, /id: mcp-new/)
  assert.equal(listRows(yaml, bare).find((row) => row.id === 'mcp-new').isDefinition, true)
})

test('deleteRow drops the row and an emptied insert block', () => {
  const doc = parsePatch(yaml, `- insert:
    - id: only
      name: '${MCP_CLIENT_PLUGIN}'
      config:
        serverName: only
        transport: stdio
        command: node
- id: keep
  disabled: true
`)
  deleteRow(findDefinition(listRows(yaml, doc), 'only'))
  assert.deepEqual(listRows(yaml, doc).map((row) => row.id), ['keep'])
  assert.doesNotMatch(stringifyPatch(doc), /- insert:/)
})

test('empty file parses and accepts the first row', () => {
  const doc = parsePatch(yaml, '')
  assert.deepEqual(listRows(yaml, doc), [])
  appendRow(yaml, doc, { id: 'first', config: { serverName: 'first', transport: 'stdio', command: 'node' } })
  assert.equal(listRows(yaml, doc).length, 1)
})

test('malformed YAML is reported, not silently repaired', () => {
  assert.throws(() => parsePatch(yaml, '- insert: [\n'), /YAML 解析失败/)
})
