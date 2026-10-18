/**
 * Patch-file operations for MCP Loader rows.
 *
 * dsh mounts MCP servers as ordinary Loader entries whose plugin is
 * `@deepseek-ai/dsh-mcp-client`. Those entries live in the user patch layers
 * (`$DSH_HOME/cordis.patch.yml` for every profile, `<profile>/cordis.patch.yml`
 * for one), and the running app reconciles them whenever either file changes.
 * So the manager writes those files directly and lets the Loader's own HMR put
 * the servers up or down; nothing here spawns anything.
 *
 * The `yaml` module is injected rather than imported: inside the Harness it must
 * come from the host installation (the plugin's own dependency tree is not on
 * the resolution path), while unit tests pass whatever copy they can install.
 *
 * @module dsh-mcp-config/patch
 */

/** Loader entry name that mounts one MCP server. */
export const MCP_CLIENT_PLUGIN = '@deepseek-ai/dsh-mcp-client'

/**
 * `!!js` expressions are part of the patch vocabulary (the Loader evaluates
 * them). Registering the tag keeps such values on round-trip instead of
 * turning them into parse errors or plain strings.
 */
const JS_TAG = { tag: 'tag:yaml.org,2002:js', resolve: (value) => value }

/**
 * Parse one patch file into an editable document.
 *
 * @param yaml - the `yaml` module namespace.
 * @param text - file content (may be empty).
 * @returns the document; comments and tags survive a later {@link stringifyPatch}.
 * @throws when the file is not valid YAML.
 */
export function parsePatch(yaml, text) {
  const doc = yaml.parseDocument(String(text ?? ''), { customTags: [JS_TAG] })
  const error = doc.errors[0]
  if (error !== undefined) throw new Error(`YAML 解析失败：${error.message}`)
  return doc
}

/**
 * Serialize an edited document the way dsh's own config editor does.
 *
 * @param doc - document produced by {@link parsePatch}.
 * @returns file content with exactly one trailing newline.
 */
export function stringifyPatch(doc) {
  const text = String(doc)
  return text.endsWith('\n') ? text : `${text}\n`
}

/**
 * Read one scalar as text.
 *
 * @param node - a YAML map node.
 * @param key - field name.
 * @returns the string value, or an empty string when absent.
 */
function readText(node, key) {
  const value = node.get(key)
  if (value === null || value === undefined) return ''
  if (typeof value === 'object' && typeof value.toJSON === 'function') {
    const plain = value.toJSON()
    return plain === null || plain === undefined ? '' : String(plain)
  }
  return String(value)
}

/**
 * Read a `config` map as a plain object.
 *
 * @param node - a YAML map node.
 * @returns plain config, or an empty object.
 */
function readConfig(node) {
  const value = node.get('config')
  if (value === null || value === undefined) return {}
  const plain = typeof value.toJSON === 'function' ? value.toJSON() : value
  if (plain === null || typeof plain !== 'object' || Array.isArray(plain)) return {}
  return plain
}

/**
 * Build the reference handed to callers and to the mutators.
 *
 * @param node - the row map.
 * @param parent - the sequence owning the row.
 * @param index - position inside `parent`.
 * @param blockIndex - position of the owning `- insert:` item, or -1 for a top-level row.
 * @param root - the document's root sequence.
 * @returns the row reference.
 */
function rowRef(node, parent, index, blockIndex, root) {
  const name = readText(node, 'name')
  const disabledValue = node.get('disabled')
  const disabled = disabledValue === true || disabledValue === 'true'
  return {
    id: readText(node, 'id'),
    name,
    disabled,
    config: readConfig(node),
    isDefinition: name === MCP_CLIENT_PLUGIN,
    kind: blockIndex >= 0 ? 'insert' : 'row',
    node,
    parent,
    index,
    blockIndex,
    root,
  }
}

/**
 * Every MCP-related row of one patch file, in file order.
 *
 * Rows may be top-level patch entries (`- id: x  config: ...`) or entries in an
 * `- insert:` list, which is how the home layer declares new servers.
 *
 * @param yaml - the `yaml` module namespace.
 * @param doc - parsed patch document.
 * @returns the row references; non-map entries are skipped.
 */
export function listRows(yaml, doc) {
  const root = doc.contents
  if (!yaml.isSeq(root)) return []
  const rows = []
  root.items.forEach((item, topIndex) => {
    if (!yaml.isMap(item)) return
    const insert = item.get('insert')
    if (yaml.isSeq(insert)) {
      insert.items.forEach((child, childIndex) => {
        if (yaml.isMap(child)) rows.push(rowRef(child, insert, childIndex, topIndex, root))
      })
      return
    }
    if (item.has('id')) rows.push(rowRef(item, root, topIndex, -1, root))
  })
  return rows
}

/**
 * First definition row for one id (a row that carries the mcp-client plugin name).
 *
 * @param rows - result of {@link listRows}.
 * @param id - Loader entry id.
 * @returns the row, or undefined.
 */
export function findDefinition(rows, id) {
  return rows.find((row) => row.isDefinition && row.id === id)
}

/**
 * Any row for one id, definition first.
 *
 * @param rows - result of {@link listRows}.
 * @param id - Loader entry id.
 * @returns the row, or undefined.
 */
export function findRow(rows, id) {
  return findDefinition(rows, id) ?? rows.find((row) => row.id === id)
}

/**
 * Turn one server on or off by writing or clearing the `disabled` key.
 *
 * @param row - row reference to mutate.
 * @param disabled - desired state.
 */
export function setDisabled(row, disabled) {
  if (disabled) row.node.set('disabled', true)
  else row.node.delete('disabled')
}

/**
 * Replace a row's `config` map.
 *
 * @param doc - the row's document.
 * @param row - row reference to mutate.
 * @param config - plain config object.
 */
export function setConfig(doc, row, config) {
  row.node.set('config', doc.createNode(config))
}

/**
 * Rename a row's Loader entry id.
 *
 * @param row - row reference to mutate.
 * @param id - new id.
 */
export function renameRow(row, id) {
  row.node.set('id', id)
}

/**
 * Ensure the document has a root sequence to append to.
 *
 * @param doc - parsed patch document.
 * @returns the root sequence.
 */
function ensureRoot(doc) {
  const root = doc.contents
  if (root === null || root === undefined) {
    doc.contents = doc.createNode([])
    return doc.contents
  }
  return root
}

/**
 * Append one new server definition.
 *
 * A file that already declares servers through an `- insert:` list gets the row
 * appended to that list (that is the home layer's shape); otherwise a top-level
 * `- id / name / config` row is added (the profile layer's shape).
 *
 * @param doc - parsed patch document.
 * @param yaml - the `yaml` module namespace.
 * @param server - `{ id, config }` to add.
 */
export function appendRow(yaml, doc, server) {
  const root = ensureRoot(doc)
  if (!yaml.isSeq(root)) throw new Error('patch 文件顶层不是 YAML 序列，拒绝写入')
  const node = doc.createNode({ id: server.id, name: MCP_CLIENT_PLUGIN, config: server.config })
  const block = root.items.find((item) => yaml.isMap(item) && yaml.isSeq(item.get('insert')))
  if (block !== undefined) {
    block.get('insert').add(node)
    return
  }
  const wrapper = doc.createNode({ insert: [] })
  wrapper.get('insert').add(node)
  root.add(wrapper)
}

/**
 * Delete one row, dropping the now-empty `- insert:` wrapper with it.
 *
 * @param row - row reference to remove.
 */
export function deleteRow(row) {
  row.parent.items.splice(row.index, 1)
  if (row.blockIndex >= 0 && row.parent.items.length === 0) row.root.items.splice(row.blockIndex, 1)
}
