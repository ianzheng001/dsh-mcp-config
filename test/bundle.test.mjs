/**
 * Bundle-shape tests for `lib/client.js`.
 *
 * The Web shell does not load one `<script>` per plugin: it concatenates every
 * missing bundle of a boot batch into a single combo URL (`/plugins/??a/x.js,b/y.js`),
 * so all of those files share ONE top-level scope. A bundle that declares a
 * top-level `const factory` therefore breaks the whole combo as soon as a second
 * bundle does the same — the browser reports
 * `Identifier 'factory' has already been declared` and every entry in the batch
 * fails to import with no useful message.
 *
 * These tests reproduce that transport in plain Node: concatenate the bundle with
 * a sibling of the same hand-written shape and require it to compile.
 *
 * @module test/bundle.test
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url))

/** A minimal sibling bundle in the classic hand-written shape. */
const SIBLING = `const factory = (require) => {
  var module = { exports: {} }
  module.exports = { name: 'sibling', apply() {} }
  return module.exports
}
window.__ModuleLoader__.load({ id: 'sibling', factory })
`

/**
 * Execute the bundle with a stub module table and collect registrations.
 *
 * @param text - bundle source.
 * @returns the ids the bundle registered.
 */
function registrationsOf(text) {
  const ids = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(row) {
          ids.push(row.id)
        },
      },
    },
  }
  // `new Function` compiles in the global scope; the bundle only touches `window`.
  const run = new Function('window', text)
  run(sandbox.window)
  return ids
}

test('the bundle compiles both alone and concatenated with a sibling bundle', () => {
  const text = readFileSync(BUNDLE, 'utf8')
  assert.doesNotThrow(() => new Function(text), 'the bundle must be valid script source')
  assert.doesNotThrow(
    () => new Function(`${text}\n${SIBLING}\n`),
    'a combo of two bundles must compile: no top-level bindings may collide',
  )
  assert.doesNotThrow(
    () => new Function(`${SIBLING}\n${text}\n`),
    'order must not matter for the combo',
  )
})

test('the bundle stays quiet until load() materializes the factory', () => {
  const text = readFileSync(BUNDLE, 'utf8')
  const ids = registrationsOf(text)
  assert.deepEqual(ids, ['mcp-config', 'dsh-mcp-config'], 'both the Loader entry id and the package name register')
})

test('the factory returns a plugin whose services and slot are the expected ones', () => {
  const text = readFileSync(BUNDLE, 'utf8')
  const factories = new Map()
  const window = { __ModuleLoader__: { load(row) { factories.set(row.id, row.factory) } } }
  new Function('window', text)(window)
  const fakeReact = {
    createElement: () => null,
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: () => ({ current: null }),
  }
  const plugin = factories.get('mcp-config')((specifier) => {
    if (specifier === 'react') return fakeReact
    throw new Error(`unexpected require(${specifier})`)
  })
  assert.equal(plugin.name, 'dsh-mcp-config-client')
  assert.deepEqual(plugin.inject, ['slots'])
  assert.equal(typeof plugin.apply, 'function')

  const sections = []
  plugin.apply({
    slots: {
      inject(_key, run) { return run() },
      register(options, component) {
        sections.push({ options, component })
        return () => {}
      },
    },
  })
  assert.equal(sections.length, 1)
  assert.equal(sections[0].options.name, 'settings.section')
  assert.equal(sections[0].options.id, 'mcp-servers')
  assert.equal(typeof sections[0].component, 'function')
})
