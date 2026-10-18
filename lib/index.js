/**
 * MCP server manager for DeepSeek Harness — host half.
 *
 * dsh already knows how to mount MCP servers: they are Loader entries whose
 * plugin is `@deepseek-ai/dsh-mcp-client`, declared in the user patch layers
 * (`$DSH_HOME/cordis.patch.yml` and `<profile>/cordis.patch.yml`). The Loader
 * reconciles when either file changes, so "add / edit / enable / disable /
 * delete a server" is a file edit plus one hot reload — no plugin-tree surgery
 * and no restart.
 *
 * This half therefore owns no server list of its own. It exposes one JSON route
 * the Settings page talks to:
 *
 *   POST /dsh-mcp-config/api  { op: 'state' | 'save' | 'enabled' | 'remove' | 'test', ... }
 *
 * `test` opens a throwaway MCP session with the given config (see probe.js), which
 * is how a credential edit is verified without touching the live connection.
 *
 * @module dsh-mcp-config
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import * as patch from './patch.js'
import {
  FLOW_TTL_MS,
  OAUTH_CALLBACK_PATH,
  OAUTH_STATE_FILENAME,
  beginAuthorization,
  createOAuthStore,
  createProvider,
  escapeHtml,
  finishAuthorization,
  newFlowState,
} from './oauth.js'
import { DEFAULT_PROBE_TIMEOUT_MS, loadProbeModules, probeServer } from './probe.js'

/** Cordis plugin name used by loader diagnostics. */
const name = 'mcp-config'

/** The browser bundle resolves everything through the Host's route registry. */
const inject = ['webServer']

/** Same-origin JSON endpoint consumed by the Settings page. */
const API_PATH = '/dsh-mcp-config/api'

/** Largest accepted request body; a server config is small. */
const BODY_LIMIT_BYTES = 1024 * 1024

/** Loader entry ids are ours to name; keep them filesystem- and tool-name-safe. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** `serverName` rule enforced by dsh-mcp-client (tool names are prefixed by it). */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Default tool-call timeout, matching dsh-mcp-client. */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000

/** Config keys the page owns; everything else in an existing config is preserved. */
const MANAGED_KEYS = new Set([
  'transport',
  'serverName',
  'command',
  'args',
  'env',
  'cwd',
  'url',
  'headers',
  'toolCallTimeoutMs',
])

/* ------------------------------------------------------------- module load -- */

/** Per-name module cache; the resolution path must not be walked per request. */
const moduleCache = new Map()

/**
 * Candidate `package.json` paths to resolve Host-owned modules from.
 *
 * The plugin is linked into a profile whose dependency tree does not contain
 * `yaml` or the MCP SDK; the Host installation does. `profileContext.installAnchor`
 * names it directly, `process.argv[1]` is the dsh bin path under that install,
 * and `which dsh` covers unit tests and odd launchers.
 *
 * @param ctx - plugin context; `profileContext` may be absent.
 * @returns resolver anchors, most specific first.
 */
function anchorsOf(ctx) {
  const anchors = []
  const fromProfile = ctx.get?.('profileContext')?.installAnchor
  if (typeof fromProfile === 'string' && fromProfile !== '') anchors.push(fromProfile)
  const argv1 = process.argv[1]
  if (typeof argv1 === 'string' && argv1.endsWith(join('lib', 'bin.js'))) {
    anchors.push(join(dirname(argv1), '..', 'package.json'))
  }
  if (typeof process.env.DSH_ANCHOR === 'string' && process.env.DSH_ANCHOR !== '') {
    anchors.push(process.env.DSH_ANCHOR)
  }
  try {
    const bin = execFileSync('which', ['dsh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (bin !== '') anchors.push(join(dirname(realpathSync(bin)), '..', 'package.json'))
  } catch {
    // No dsh on PATH: the remaining anchors still work inside the Host.
  }
  return anchors
}

/**
 * Resolve one Host-owned module.
 *
 * @param ctx - plugin context.
 * @param specifier - bare module name.
 * @returns the module namespace.
 * @throws when no anchor can resolve it and the local import fails too.
 */
export async function loadHostModule(ctx, specifier) {
  const cached = moduleCache.get(specifier)
  if (cached !== undefined) return cached
  const failures = []
  for (const anchor of anchorsOf(ctx)) {
    try {
      const resolved = createRequire(anchor)(specifier)
      moduleCache.set(specifier, resolved)
      return resolved
    } catch (error) {
      failures.push(`${anchor}: ${String(error.message ?? error)}`)
    }
  }
  try {
    const imported = await import(specifier)
    moduleCache.set(specifier, imported)
    return imported
  } catch (error) {
    failures.push(`import: ${String(error.message ?? error)}`)
  }
  throw new Error(`dsh-mcp-config 无法从 Host 安装加载 “${specifier}”：${failures.join('；')}`)
}

/**
 * Build the loader used by every handler.
 *
 * @param ctx - plugin context.
 * @returns async module resolver.
 */
function modulesOf(ctx) {
  return (specifier) => loadHostModule(ctx, specifier)
}

/* -------------------------------------------------------------------- files -- */

/**
 * SHA-256 of one file's text, used as the write precondition.
 *
 * @param text - file content.
 * @returns hex digest.
 */
export function hashOf(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

/**
 * The two user patch files this manager owns.
 *
 * @param ctx - plugin context.
 * @returns home and profile patch locations.
 */
export function patchPaths(ctx) {
  const profile = ctx.get?.('profileContext')
  const home = profile?.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const profilePatch = profile?.patchPath
    ?? (typeof profile?.dir === 'string' ? join(profile.dir, 'cordis.patch.yml') : '')
  return {
    home: join(home, 'cordis.patch.yml'),
    profile: profilePatch,
    profileDir: profile?.dir ?? '',
    homeDir: home,
  }
}

/**
 * Read and parse one patch file.
 *
 * A missing file is a normal state (the manager then creates it on first write);
 * a malformed file is reported, not thrown, so the page can explain it.
 *
 * @param ctx - plugin context.
 * @param load - module resolver.
 * @param filePath - absolute path.
 * @param key - `home` or `profile`.
 * @returns parsed file record.
 */
async function readPatchFile(ctx, load, filePath, key) {
  let text = ''
  let exists = true
  let mode = 0o600
  try {
    text = await readFile(filePath, 'utf8')
    mode = (await stat(filePath)).mode & 0o777
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    exists = false
  }
  const record = { key, path: filePath, text, hash: hashOf(text), exists, mode, doc: null, rows: [], error: null }
  if (filePath === '') {
    record.error = '当前会话没有 profile 补丁文件路径'
    return record
  }
  try {
    const yaml = await load('yaml')
    record.doc = patch.parsePatch(yaml, text)
    record.rows = patch.listRows(yaml, record.doc)
  } catch (error) {
    record.error = String(error.message ?? error)
  }
  return record
}

/**
 * Read both patch files.
 *
 * @param ctx - plugin context.
 * @param load - module resolver.
 * @returns `{ home, profile }` file records.
 */
async function readFiles(ctx, load) {
  const paths = patchPaths(ctx)
  return {
    home: await readPatchFile(ctx, load, paths.home, 'home'),
    profile: await readPatchFile(ctx, load, paths.profile, 'profile'),
  }
}

/**
 * Write one patch file atomically, keeping its permission bits.
 *
 * A temp file in the same directory plus `rename` means the Loader's watcher can
 * never observe a half-written patch.
 *
 * @param filePath - target path.
 * @param text - full new content.
 * @param mode - permission bits to apply.
 */
async function writePatchFile(filePath, text, mode) {
  const directory = dirname(filePath)
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, `.${basename(filePath)}.tmp-${String(process.pid)}-${String(Date.now())}`)
  await writeFile(temporary, text, { mode })
  await rename(temporary, filePath)
}

/* -------------------------------------------------------------------- state -- */

/**
 * Live facts for every mounted mcp-client entry, keyed by Loader entry id.
 *
 * `toolCount` is read from the tool registry rather than from the connection:
 * a registered tool prefix is the only observable proof that the handshake and
 * `tools/list` both succeeded.
 *
 * @param ctx - plugin context.
 * @returns id → live facts.
 */
function readLive(ctx) {
  const live = new Map()
  const loader = ctx.get?.('loader')
  if (loader === undefined) return live
  let toolNames = []
  try {
    const tools = ctx.get?.('tools')
    toolNames = tools?.schemas?.()?.map((schema) => String(schema.name)) ?? []
  } catch {
    toolNames = []
  }
  for (const entry of loader.entries()) {
    if (entry.options?.name !== patch.MCP_CLIENT_PLUGIN) continue
    const config = entry.options.config ?? {}
    const serverName = String(config.serverName ?? '')
    const prefix = `mcp__${serverName}__`
    live.set(entry.options.id, {
      mounted: true,
      disabled: entry.disabled === true,
      active: entry.fiber?.state === 2,
      serverName,
      transport: String(config.transport ?? ''),
      toolCount: toolNames.filter((toolName) => toolName.startsWith(prefix)).length,
    })
  }
  return live
}

/**
 * Merge both patch files plus live Loader facts into the list the page renders.
 *
 * Patch semantics copied from the Loader's own patch application: a row carrying
 * the plugin name defines a server, any other row with the same id overrides
 * fields on it (`disabled` in practice), and an entry that no patch row defines
 * comes from a bundle layer and is read-only here.
 *
 * @param files - `{ home, profile }` file records.
 * @param live - id → live facts.
 * @returns server rows sorted by serverName.
 */
export function collectServers(files, live) {
  const definitions = new Map()
  const overrides = new Map()
  for (const file of Object.values(files)) {
    for (const row of file.rows) {
      if (row.isDefinition) {
        if (!definitions.has(row.id)) definitions.set(row.id, { file, row })
      } else if (!overrides.has(row.id)) {
        overrides.set(row.id, { file, row })
      }
    }
  }

  const servers = []
  for (const [id, { file, row }] of definitions) {
    const override = overrides.get(id)
    const liveFacts = live.get(id)
    servers.push({
      id,
      serverName: String(row.config.serverName ?? ''),
      transport: String(row.config.transport ?? ''),
      disabled: row.disabled || override?.row.disabled === true,
      overridden: override !== undefined,
      source: file.key,
      editable: true,
      config: row.config,
      live: liveFacts ?? { mounted: false, disabled: false, active: false, serverName: '', transport: '', toolCount: 0 },
    })
  }

  for (const [id, liveFacts] of live) {
    if (definitions.has(id)) continue
    servers.push({
      id,
      serverName: liveFacts.serverName,
      transport: liveFacts.transport,
      disabled: liveFacts.disabled,
      overridden: false,
      source: 'loader',
      editable: false,
      config: {},
      live: liveFacts,
    })
  }

  return servers.sort((left, right) => left.serverName.localeCompare(right.serverName) || left.id.localeCompare(right.id))
}

/**
 * Everything one `state` call returns.
 *
 * @param ctx - plugin context.
 * @param load - module resolver.
 * @returns state payload.
 */
export async function collectState(ctx, load, store) {
  const files = await readFiles(ctx, load)
  const paths = patchPaths(ctx)
  const oauthStore = store ?? createOAuthStore(join(patchPaths(ctx).homeDir, OAUTH_STATE_FILENAME))
  let oauthRecords = {}
  try {
    oauthRecords = await oauthStore.all()
  } catch {
    oauthRecords = {}
  }
  return {
    ok: true,
    api: API_PATH,
    files: {
      home: { key: 'home', path: files.home.path, hash: files.home.hash, exists: files.home.exists, error: files.home.error },
      profile: {
        key: 'profile',
        path: files.profile.path,
        hash: files.profile.hash,
        exists: files.profile.exists,
        error: files.profile.error,
      },
    },
    paths,
    oauthCallback: oauthCallbackUrl(ctx),
    oauthStatePath: oauthStore.path,
    servers: collectServers(files, readLive(ctx)).map((server) => {
      const record = oauthRecords[server.id]
      return {
        ...server,
        oauth: {
          available: server.transport === 'streamable-http',
          clientRegistered: record?.clientInformation !== undefined,
          authorized: typeof record?.tokens?.access_token === 'string' && record.tokens.access_token !== '',
          authorizedAt: record?.authorizedAt ?? null,
        },
      }
    }),
  }
}

/* --------------------------------------------------------------- validation -- */

/**
 * Copy a dictionary of strings, dropping blank keys.
 *
 * @param value - candidate dictionary.
 * @returns a plain string dictionary.
 */
function stringDict(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const result = {}
  for (const [key, entry] of Object.entries(value)) {
    const trimmed = String(key).trim()
    if (trimmed === '') continue
    result[trimmed] = String(entry ?? '')
  }
  return result
}

/**
 * Build the config the Loader entry will carry.
 *
 * Fields the page does not manage (for example `failOnStartupError` or the
 * reconnect policy) are carried over unchanged when the transport stays the same,
 * so editing a server in the UI never silently drops hand-written options.
 *
 * @param input - page input: id, transport, serverName, and transport fields.
 * @param existing - the current config, when editing.
 * @returns the config object to store.
 */
export function buildConfig(input, existing) {
  const transport = input.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
  const timeout = Number(input.toolCallTimeoutMs)
  const config = {
    serverName: String(input.serverName ?? '').trim(),
    transport,
  }
  if (transport === 'stdio') {
    config.command = String(input.command ?? '').trim()
    config.args = Array.isArray(input.args) ? input.args.map((arg) => String(arg)) : []
    config.env = stringDict(input.env)
    if (String(input.cwd ?? '') !== '') config.cwd = String(input.cwd)
  } else {
    config.url = String(input.url ?? '').trim()
    config.headers = stringDict(input.headers)
  }
  config.toolCallTimeoutMs = Number.isFinite(timeout) && timeout > 0 ? Math.round(timeout) : DEFAULT_TOOL_CALL_TIMEOUT_MS
  if (existing !== undefined && existing !== null && existing.transport === transport) {
    for (const [key, value] of Object.entries(existing)) {
      if (!MANAGED_KEYS.has(key)) config[key] = value
    }
  }
  return config
}

/**
 * Validate one save request.
 *
 * @param input - page input.
 * @param context - `{ files, originalId }` used for uniqueness checks.
 * @returns human-readable errors; empty when the request is acceptable.
 */
export function validateServerInput(input, context) {
  const errors = []
  const id = String(input.id ?? '').trim()
  const serverName = String(input.serverName ?? '').trim()
  const transport = input.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
  const originalId = String(context.originalId ?? '')

  if (id === '') errors.push('id 不能为空')
  else if (!ID_PATTERN.test(id)) errors.push('id 只能包含字母、数字、_ 和 -，最长 64 字符')
  else if (id !== originalId && definitionsOf(context.files).has(id)) errors.push(`id “${id}” 已被另一个服务器占用`)

  if (serverName === '') errors.push('serverName 不能为空')
  else if (!SERVER_NAME_PATTERN.test(serverName)) errors.push('serverName 只能包含字母、数字、_ 和 -，最长 32 字符')
  else {
    const clash = [...definitionsOf(context.files).values()].find((entry) =>
      entry.row.id !== originalId
      && !entry.row.disabled
      && String(entry.row.config.serverName ?? '') === serverName)
    if (clash !== undefined) errors.push(`serverName “${serverName}” 已被启用的服务器 “${clash.row.id}” 使用`)
  }

  if (transport === 'stdio') {
    if (String(input.command ?? '').trim() === '') errors.push('stdio 服务器必须有 command')
  } else {
    const url = String(input.url ?? '').trim()
    if (url === '') errors.push('streamable-http 服务器必须有 url')
    else if (!/^https?:\/\//i.test(url)) errors.push('url 必须以 http:// 或 https:// 开头')
  }
  return errors
}

/**
 * Definition rows of the effective composition, keyed by id.
 *
 * @param files - `{ home, profile }` file records.
 * @returns id → `{ file, row }` for definining rows only.
 */
function definitionsOf(files) {
  const definitions = new Map()
  for (const file of Object.values(files)) {
    for (const row of file.rows) {
      if (row.isDefinition && !definitions.has(row.id)) definitions.set(row.id, { file, row })
    }
  }
  return definitions
}

/* -------------------------------------------------------------------- ops --- */

/**
 * Locate the row that owns one id, preferring a definition row over an override.
 *
 * @param files - `{ home, profile }` file records.
 * @param id - Loader entry id.
 * @returns `{ file, row }` or undefined.
 */
function locate(files, id) {
  const definition = definitionsOf(files).get(id)
  if (definition !== undefined) return definition
  for (const file of Object.values(files)) {
    for (const row of file.rows) {
      if (row.id === id) return { file, row }
    }
  }
  return undefined
}

/**
 * Reject a write that would clobber a manual edit made after the page read state.
 *
 * @param file - target file record.
 * @param hashes - per-file hashes the page last saw.
 * @returns a conflict payload, or undefined when the write may proceed.
 */
function conflictOf(file, hashes) {
  const expected = hashes?.[file.key]
  if (typeof expected !== 'string' || expected === '') return undefined
  if (expected === file.hash) return undefined
  return { ok: false, code: 'conflict', message: '文件已被其他方式修改，页面已重新读取；请再操作一次。' }
}

/**
 * `save`: create or update one server definition.
 *
 * @param ctx - plugin context.
 * @param load - module resolver.
 * @param payload - request body.
 * @returns result payload.
 */
async function opSave(ctx, load, payload) {
  const files = await readFiles(ctx, load)
  const input = payload.server ?? {}
  const originalId = String(payload.originalId ?? input.id ?? '')
  const errors = validateServerInput(input, { files, originalId })
  if (errors.length > 0) return { ok: false, code: 'invalid', errors, state: await collectState(ctx, load) }

  const existing = originalId === '' ? undefined : locate(files, originalId)
  const targetKey = existing !== undefined && existing.file.key !== 'loader'
    ? existing.file.key
    : payload.target === 'profile' ? 'profile' : 'home'
  const target = files[targetKey]
  const conflict = conflictOf(target, payload.hashes)
  if (conflict !== undefined) return { ...conflict, state: await collectState(ctx, load) }

  const yaml = await load('yaml')
  const id = String(input.id).trim()
  const config = buildConfig(input, existing?.row.config)

  if (existing !== undefined) {
    const row = patch.findDefinition(target.rows, existing.row.id) ?? patch.findRow(target.rows, existing.row.id)
    if (row === undefined) return { ok: false, code: 'stale', message: '目标行在写入前消失了，请刷新后重试' }
    if (row.id !== id) patch.renameRow(row, id)
    if (!row.isDefinition) row.node.set('name', patch.MCP_CLIENT_PLUGIN)
    patch.setConfig(target.doc, row, config)
    patch.setDisabled(row, input.disabled === true)
  } else {
    patch.appendRow(yaml, target.doc, { id, config })
    if (input.disabled === true) {
      const row = patch.findDefinition(patch.listRows(yaml, target.doc), id)
      if (row !== undefined) patch.setDisabled(row, true)
    }
  }

  const text = patch.stringifyPatch(target.doc)
  await writePatchFile(target.path, text, target.mode)
  return { ok: true, wrote: targetKey, hash: hashOf(text), state: await collectState(ctx, load) }
}

/**
 * `enabled`: flip one server on or off.
 *
 * @param ctx - plugin context.
 * @param load - module resolver.
 * @param payload - `{ id, enabled, hashes }`.
 * @returns result payload.
 */
async function opEnabled(ctx, load, payload) {
  const files = await readFiles(ctx, load)
  const id = String(payload.id ?? '')
  const found = locate(files, id)
  if (found === undefined) return { ok: false, code: 'not-found', message: `找不到 id 为 “${id}” 的 MCP 服务器` }
  const target = found.file
  const conflict = conflictOf(target, payload.hashes)
  if (conflict !== undefined) return { ...conflict, state: await collectState(ctx, load) }

  const row = patch.findRow(target.rows, id)
  if (row === undefined) return { ok: false, code: 'stale', message: '目标行在写入前消失了，请刷新后重试' }
  patch.setDisabled(row, payload.enabled !== true)
  const text = patch.stringifyPatch(target.doc)
  await writePatchFile(target.path, text, target.mode)
  return { ok: true, wrote: target.key, hash: hashOf(text), state: await collectState(ctx, load) }
}

/**
 * `remove`: delete a server definition (and any override row for it).
 *
 * @param ctx - plugin context.
 * @param load - module resolver.
 * @param payload - `{ id, hashes }`.
 * @returns result payload.
 */
async function opRemove(ctx, load, payload) {
  const files = await readFiles(ctx, load)
  const id = String(payload.id ?? '')
  const found = locate(files, id)
  if (found === undefined) return { ok: false, code: 'not-found', message: `找不到 id 为 “${id}” 的 MCP 服务器` }
  if (!found.row.isDefinition && found.file.key === 'loader') {
    return { ok: false, code: 'read-only', message: '这个服务器由插件包提供，不能在这里删除' }
  }
  const conflict = conflictOf(found.file, payload.hashes)
  if (conflict !== undefined) return { ...conflict, state: await collectState(ctx, load) }

  const yaml = await load('yaml')
  const wrote = []
  for (const file of Object.values(files)) {
    if (file.doc === null || file.path === '') continue
    let changed = false
    // Re-list after every deletion: indices shift as rows disappear.
    for (;;) {
      const row = patch.findRow(patch.listRows(yaml, file.doc), id)
      if (row === undefined) break
      patch.deleteRow(row)
      changed = true
    }
    const changedRows = changed && file.hash !== hashOf(patch.stringifyPatch(file.doc))
    if (!changedRows) continue
    const text = patch.stringifyPatch(file.doc)
    await writePatchFile(file.path, text, file.mode)
    wrote.push(file.key)
  }
  if (wrote.length === 0) return { ok: false, code: 'stale', message: '没有可删除的行，请刷新后重试' }
  return { ok: true, wrote, state: await collectState(ctx, load) }
}

/**
 * `test`: open a throwaway MCP session with the given config.
 *
 * @param ctx - plugin context.
 * @param load - module resolver.
 * @param payload - `{ server, timeoutMs }`.
 * @returns `{ ok: true, result }`; the probe's own verdict is `result.ok`.
 */
async function opTest(ctx, load, payload) {
  const config = buildConfig(payload.server ?? {}, undefined)
  const errors = []
  if (config.transport === 'stdio' && config.command === '') errors.push('command 为空')
  if (config.transport === 'streamable-http' && config.url === '') errors.push('url 为空')
  if (errors.length > 0) return { ok: false, code: 'invalid', errors }
  const modules = await loadProbeModules(load)
  const timeoutMs = Number(payload.timeoutMs)
  const result = await probeServer(modules, config, {
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_PROBE_TIMEOUT_MS,
  })
  return { ok: true, result }
}

/* ------------------------------------------------------------------- oauth -- */

/** Drop flows older than the interactive window so a stale map cannot grow forever. */
function pruneFlows(flows) {
  const now = Date.now()
  for (const [state, flow] of flows) {
    if (now - flow.createdAt <= FLOW_TTL_MS) continue
    Promise.resolve(flow.transport?.close?.()).catch(() => {})
    flows.delete(state)
  }
}

/**
 * The loopback URL the authorization server redirects back to.
 *
 * @param ctx - plugin context; the Web server owns the port.
 * @returns absolute callback URL, or '' when this instance has no Web server.
 */
function oauthCallbackUrl(ctx) {
  const port = ctx.webServer?.port
  if (typeof port !== 'number') return ''
  return `http://127.0.0.1:${String(port)}${OAUTH_CALLBACK_PATH}`
}

/**
 * Answer the browser's callback visit with a tiny human page.
 *
 * @param res - server response.
 * @param status - HTTP status.
 * @param html - page body.
 */
function sendHtml(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(html),
  })
  res.end(html)
}

/**
 * The completion page the authorization server's redirect lands on.
 *
 * @param title - headline.
 * @param detail - explanation.
 * @param ok - success styling.
 * @param autoClose - close the tab after a beat (opened by the settings page).
 * @returns HTML document.
 */
function callbackPage(title, detail, ok, autoClose = false) {
  const accent = ok ? '#2ea043' : '#f85149'
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#1c1c1e; color:#e8e8ed;
         font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif }
  main { max-width:520px; padding:28px 32px; border:1px solid ${accent}55; border-radius:14px; background:#242427 }
  h1 { margin:0 0 10px; font-size:18px; color:${accent} }
  p { margin:0; opacity:.85; word-break:break-word }
  small { display:block; margin-top:14px; opacity:.5 }
</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>
<small>dsh MCP manager</small></main>
${autoClose ? '<script>setTimeout(() => { try { window.close() } catch {} }, 1500)</script>' : ''}
</body></html>`
}

/**
 * Persist the OAuth access token as the server's `Authorization` header.
 *
 * The live connection can only carry static headers, so the reload that follows
 * this write is what actually makes the server connect.
 *
 * @param ctx - plugin context.
 * @param load - module resolver.
 * @param id - Loader entry id.
 * @param value - header value (`Bearer …`).
 */
async function writeAuthorizationHeader(ctx, load, id, value) {
  const files = await readFiles(ctx, load)
  const found = locate(files, id)
  if (found === undefined) throw new Error(`找不到 id 为 “${id}” 的服务器`)
  const row = patch.findRow(found.file.rows, id)
  if (row === undefined) throw new Error('目标行已消失，请刷新后重试')
  const config = { ...row.config, headers: { ...(row.config.headers ?? {}), Authorization: value } }
  patch.setConfig(found.file.doc, row, config)
  const text = patch.stringifyPatch(found.file.doc)
  await writePatchFile(found.file.path, text, found.file.mode)
}

/**
 * `oauth-start`: run discovery/registration and hand back the authorize URL.
 *
 * @param ctx - plugin context.
 * @param load - module resolver.
 * @param payload - `{ id, clientId?, clientSecret? }`.
 * @param options - `{ store, flows }` owned by the plugin instance.
 * @returns `{ ok, status: 'authorized'|'redirect', authorizationUrl?, state? }`.
 */
async function opOAuthStart(ctx, load, payload, options) {
  const { store, flows } = options
  const files = await readFiles(ctx, load)
  const id = String(payload.id ?? '')
  const found = locate(files, id)
  if (found === undefined) return { ok: false, code: 'not-found', message: `找不到 id 为 “${id}” 的服务器` }
  const config = found.row.config
  if (String(config.transport ?? '') !== 'streamable-http') {
    return { ok: false, code: 'transport', message: '只有 streamable-http 服务器需要 OAuth 认证' }
  }
  const url = String(config.url ?? '')
  if (url === '') return { ok: false, code: 'invalid', message: '该服务器没有 url' }
  const callback = oauthCallbackUrl(ctx)
  if (callback === '') return { ok: false, code: 'no-server', message: '当前实例没有 Web 端口，收不到 OAuth 回调' }

  pruneFlows(flows)
  const stored = await store.read(id)
  const givenClientId = typeof payload.clientId === 'string' && payload.clientId !== '' ? payload.clientId : undefined
  const givenClientSecret = typeof payload.clientSecret === 'string' && payload.clientSecret !== '' ? payload.clientSecret : undefined
  if (givenClientId !== undefined) await store.write(id, { clientOverride: { clientId: givenClientId, clientSecret: givenClientSecret } })
  const override = givenClientId === undefined ? stored?.clientOverride : { clientId: givenClientId, clientSecret: givenClientSecret }
  const state = newFlowState()
  const provider = createProvider({
    store,
    serverId: id,
    redirectUrl: callback,
    state,
    clientId: override?.clientId,
    clientSecret: override?.clientSecret,
    onAuthorizationUrl() {},
  })
  const modules = await load('@modelcontextprotocol/client')
  let started
  try {
    started = await beginAuthorization({ modules, url, provider })
  } catch (error) {
    return { ok: false, code: 'auth-failed', message: String(error?.message ?? error) }
  }

  if (started.status === 'authorized') {
    await Promise.resolve(started.client?.close?.() ?? started.transport.close?.()).catch(() => {})
    const tokens = await provider.tokens()
    const access = tokens?.access_token
    if (typeof access === 'string' && access !== '') await writeAuthorizationHeader(ctx, load, id, `Bearer ${access}`)
    return { ok: true, status: 'authorized', message: '该服务器不需要交互式授权，凭据已可用。' }
  }

  flows.set(state, {
    serverId: id,
    transport: started.transport,
    provider,
    status: 'pending',
    error: null,
    authorizationUrl: started.authorizationUrl,
    createdAt: Date.now(),
  })
  return { ok: true, status: 'redirect', state, authorizationUrl: started.authorizationUrl, callback }
}

/**
 * `oauth-status`: report (and finish reporting) one pending authorization.
 *
 * @param ctx - plugin context.
 * @param load - module resolver.
 * @param payload - `{ state }`.
 * @param options - `{ flows }`.
 * @returns `{ ok, status, error?, probe? }`.
 */
async function opOAuthStatus(ctx, load, payload, options) {
  const { flows } = options
  pruneFlows(flows)
  const state = String(payload.state ?? '')
  const flow = flows.get(state)
  if (flow === undefined) return { ok: true, status: 'expired', message: '授权请求已过期，请重新点击「认证」' }
  if (flow.status === 'pending') return { ok: true, status: 'pending', authorizationUrl: flow.authorizationUrl }
  if (flow.status === 'error') return { ok: true, status: 'error', message: flow.error }
  let probe = null
  try {
    const modules = await loadProbeModules(load)
    const files = await readFiles(ctx, load)
    const found = locate(files, flow.serverId)
    if (found !== undefined) probe = await probeServer(modules, found.row.config, {})
  } catch (error) {
    probe = { ok: false, error: String(error?.message ?? error) }
  }
  return { ok: true, status: 'authorized', probe }
}

/**
 * `oauth-forget`: drop stored registration and tokens for one server.
 *
 * @param payload - `{ id }`.
 * @param options - `{ store }`.
 * @returns `{ ok }`.
 */
async function opOAuthForget(payload, options) {
  const { store } = options
  const id = String(payload.id ?? '')
  await store.clear(id)
  return { ok: true, message: '已清除该 server 的 OAuth 凭据（patch 里的 Authorization 头需要单独删除）' }
}

/* -------------------------------------------------------------------- http -- */

/**
 * Read a JSON request body with a hard size cap.
 *
 * @param req - incoming request.
 * @returns parsed body.
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

/**
 * Answer one request.
 *
 * @param res - server response.
 * @param status - HTTP status.
 * @param payload - JSON-serializable body.
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Serialize mutations so two Settings clicks cannot interleave read-modify-write
 * cycles on the same file.
 *
 * @param run - operation to run.
 * @returns the operation's result.
 */
function createQueue() {
  let tail = Promise.resolve()
  return (run) => {
    const next = tail.then(run, run)
    tail = next.then(() => undefined, () => undefined)
    return next
  }
}

/**
 * Register the route and keep it for the plugin's lifetime.
 *
 * @param ctx - plugin context.
 */
function apply(ctx) {
  const load = modulesOf(ctx)
  const serialize = createQueue()
  const paths = patchPaths(ctx)
  const store = createOAuthStore(join(paths.homeDir, OAUTH_STATE_FILENAME))
  const flows = new Map()

  const callbackHandler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const state = url.searchParams.get('state') ?? ''
    const code = url.searchParams.get('code') ?? ''
    const failure = url.searchParams.get('error')
    const flow = flows.get(state)
    if (flow === undefined) {
      sendHtml(res, 404, callbackPage('授权失败', '找不到对应的授权请求，可能已过期。请回到设置页重新点「认证」。', false))
      return
    }
    if (failure !== null) {
      flow.status = 'error'
      flow.error = url.searchParams.get('error_description') ?? failure
      sendHtml(res, 400, callbackPage('授权失败', flow.error, false))
      return
    }
    if (code === '') {
      flow.status = 'error'
      flow.error = '回调地址里没有 code 参数'
      sendHtml(res, 400, callbackPage('授权失败', flow.error, false))
      return
    }
    try {
      const iss = url.searchParams.get('iss')
      await finishAuthorization({ transport: flow.transport, code, iss: iss === null ? undefined : iss })
      const tokens = await flow.provider.tokens()
      const access = tokens?.access_token
      if (typeof access !== 'string' || access === '') throw new Error('授权服务器没有返回 access_token')
      await writeAuthorizationHeader(ctx, load, flow.serverId, `Bearer ${access}`)
      flow.status = 'authorized'
      sendHtml(res, 200, callbackPage('授权成功', '已把 access token 写入该 server 的 Authorization 头，dsh 正在热加载。可以关闭这个页面。', true, true))
      ctx.logger?.info?.(`mcp-config: oauth authorized ${flow.serverId}`)
    } catch (error) {
      flow.status = 'error'
      flow.error = String(error?.message ?? error)
      sendHtml(res, 500, callbackPage('授权失败', flow.error, false))
      ctx.logger?.warn?.(`mcp-config: oauth failed for ${flow.serverId}: ${flow.error}`)
    }
  }

  const handler = async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, code: 'method', message: '只接受 POST' })
      return
    }
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      sendJson(res, 400, { ok: false, code: 'body', message: String(error.message ?? error) })
      return
    }
    const op = String(body.op ?? '')
    try {
      const result = await serialize(async () => {
        switch (op) {
          case 'state': return await collectState(ctx, load, store)
          case 'save': return await opSave(ctx, load, body)
          case 'enabled': return await opEnabled(ctx, load, body)
          case 'remove': return await opRemove(ctx, load, body)
          case 'test': return await opTest(ctx, load, body)
          case 'oauth-start': return await opOAuthStart(ctx, load, body, { store, flows })
          case 'oauth-status': return await opOAuthStatus(ctx, load, body, { flows })
          case 'oauth-forget': return await opOAuthForget(body, { store })
          default: return { ok: false, code: 'bad-op', message: `未知操作 “${op}”` }
        }
      })
      sendJson(res, 200, result)
    } catch (error) {
      ctx.logger?.warn?.(`mcp-config: ${op} failed: ${String(error?.stack ?? error)}`)
      sendJson(res, 200, { ok: false, code: 'error', message: String(error?.message ?? error) })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: API_PATH, handler }), 'mcp-config: settings api')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: OAUTH_CALLBACK_PATH, handler: callbackHandler }), 'mcp-config: oauth callback')
  ctx.effect(() => () => {
    for (const flow of flows.values()) Promise.resolve(flow.transport?.close?.()).catch(() => {})
    flows.clear()
  }, 'mcp-config: oauth flows')
  ctx.logger?.info?.(`mcp-config: MCP manager API at ${API_PATH}; OAuth callback at ${OAUTH_CALLBACK_PATH}`)
}

export { API_PATH, apply, inject, name }
