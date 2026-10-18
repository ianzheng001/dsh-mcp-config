// Browser entry for the local UI harness.
//
// It reproduces the four things the real Web shell gives a client plugin: a
// `window.__ModuleLoader__` registration point, `require('react')` from the
// platform table, a `slots` service, and a same-origin JSON route. Everything
// past that — the page itself, the Host route, the patch files — is the real
// code under test.
import { createRoot } from 'react-dom/client'
import React from 'react'
import '../../lib/client.js'

const harness = window.__HARNESS__
const registered = harness.registered

if (registered === null) {
  harness.fail(window.__MCP_REGISTER_ERROR__ ?? window.__MCP_FACTORY_ERROR__ ?? 'client bundle did not register')
} else {
  const modules = { react: React }
  const mod = registered.factory((name) => {
    if (Object.hasOwn(modules, name)) return modules[name]
    throw new Error(`harness: unexpected module request “${name}”`)
  })

  const slots = {
    entries: [],
    inject(_key, run) {
      return run()
    },
    register(options, component) {
      slots.entries.push({ options, component })
      return () => {}
    },
  }

  try {
    mod.apply({ slots })
    const first = slots.entries[0]
    if (first === undefined) throw new Error('client plugin registered no settings section')
    harness.ready({ id: first.options.id, label: first.options.label, order: first.options.order })
    createRoot(document.getElementById('root')).render(React.createElement(first.component, { close() {} }))
  } catch (error) {
    harness.fail(String((error && error.stack) || error))
  }
}
