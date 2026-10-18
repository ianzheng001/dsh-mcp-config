// dsh-mcp-config — browser half (web bundle, ModuleLoader CJS format).
//
// Registers the "MCP 服务器" settings section. The page is a thin client over the
// Host route `/dsh-mcp-config/api`: the Host owns the patch files, the Loader owns
// mounting, and this page only renders state and posts intents.
//
// Hand-written CJS in the same shape tsdown emits: the Loader materializes the
// factory with a `require` bound to the frozen platform module table, so
// `require('react')` is the only cross-bundle request and no build step exists.
;(() => {
const factory = (require) => {
  try {
  var module = { exports: {} }
  var exports = module.exports
  Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
  const React = require('react')
  const h = React.createElement
  const { useCallback, useEffect, useRef, useState } = React

  /** Host JSON route (same origin). */
  const API = '/dsh-mcp-config/api'

  /** `serverName` rule enforced by dsh-mcp-client. */
  const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
  const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
  const DEFAULT_TIMEOUT = 60000

  /** Value keys that are masked until the user asks to see them. */
  const SECRET_KEY = /token|secret|password|passwd|apikey|api_key|authorization|cookie|credential/i

  const CSS = [
    '.mcp-wrap{font-size:13px;line-height:1.6;display:flex;flex-direction:column;gap:14px;padding:4px 2px;color:inherit;max-width:820px}',
    '.mcp-title{margin:0;font-size:16px;font-weight:600}',
    '.mcp-sub{opacity:.72;font-size:12px}',
    '.mcp-card{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:9px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}',
    '.mcp-card.off{opacity:.72}',
    '.mcp-head{display:flex;align-items:center;gap:9px;flex-wrap:wrap}',
    '.mcp-name{font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}',
    '.mcp-chip{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.5));white-space:nowrap;opacity:.85}',
    '.mcp-chip.http{border-color:rgba(88,166,255,.55)}',
    '.mcp-chip.on{background:rgba(46,160,67,.14);border-color:rgba(46,160,67,.5)}',
    '.mcp-chip.bad{background:rgba(248,81,73,.12);border-color:rgba(248,81,73,.45)}',
    '.mcp-chip.off{opacity:.55}',
    '.mcp-spacer{flex:1}',
    '.mcp-row{display:flex;flex-direction:column;gap:4px}',
    '.mcp-row>span{font-size:12px;opacity:.8}',
    '.mcp-row small{font-size:11px;opacity:.6}',
    '.mcp-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 12px}',
    '.mcp-grid .full{grid-column:1/-1}',
    '.mcp-input,.mcp-area,.mcp-select{font-size:12px;padding:5px 8px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.5));background:transparent;color:inherit;width:100%;box-sizing:border-box}',
    '.mcp-input,.mcp-area,.mcp-select{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
    '.mcp-area{resize:vertical;min-height:54px}',
    '.mcp-btn{font-size:12px;padding:4px 12px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.5));background:transparent;color:inherit;cursor:pointer;white-space:nowrap}',
    '.mcp-btn:disabled{opacity:.45;cursor:default}',
    '.mcp-btn.tiny{padding:2px 8px;font-size:11px}',
    '.mcp-btn.primary{border-color:rgba(88,166,255,.7)}',
    '.mcp-btn.danger{border-color:rgba(248,81,73,.6);color:rgba(248,81,73,.95)}',
    '.mcp-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
    '.mcp-msg{padding:8px 10px;border-radius:6px;font-size:12px;white-space:pre-wrap;word-break:break-word}',
    '.mcp-msg.ok{background:rgba(46,160,67,.14);border:1px solid rgba(46,160,67,.4)}',
    '.mcp-msg.err{background:rgba(248,81,73,.13);border:1px solid rgba(248,81,73,.42)}',
    '.mcp-err{font-size:11px;color:rgba(248,81,73,.95)}',
    '.mcp-dict{display:flex;flex-direction:column;gap:6px}',
    '.mcp-dict-row{display:grid;grid-template-columns:minmax(0,0.9fr) minmax(0,1.3fr) auto auto;gap:6px;align-items:center}',
    '.mcp-tools{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;opacity:.85;display:flex;flex-wrap:wrap;gap:4px 10px;max-height:120px;overflow:auto}',
    '.mcp-empty{border:1px dashed var(--dsw-alias-border-l2,rgba(128,128,128,.45));border-radius:9px;padding:18px;text-align:center;opacity:.75;font-size:12px}',
    '.mcp-files{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;opacity:.6;word-break:break-all}',
    '.mcp-switch{display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer}',
    '.mcp-radio{display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer}',
  ].join('')

  /** Inject the page stylesheet once per document. */
  function ensureCss() {
    if (typeof document === 'undefined' || document.getElementById('mcp-css') !== null) return
    const tag = document.createElement('style')
    tag.id = 'mcp-css'
    tag.textContent = CSS
    document.head.appendChild(tag)
  }

  /** Promise-based pause used between state polls. */
  const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

  /**
   * POST one intent to the Host and unwrap its JSON answer.
   *
   * @param op - operation name.
   * @param payload - operation fields.
   * @returns the Host payload; rejects with a rendered message on refusal.
   */
  async function post(op, payload) {
    let response
    try {
      response = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, ...payload }),
      })
    } catch (error) {
      throw new Error(`无法连接 Host 路由（${String(error.message ?? error)}）`)
    }
    let data
    try {
      data = await response.json()
    } catch {
      throw new Error(`Host 返回了非 JSON 响应（HTTP ${String(response.status)}）`)
    }
    if (data?.ok === true) return data
    const detail = Array.isArray(data?.errors) && data.errors.length > 0 ? `：${data.errors.join('；')}` : ''
    const error = new Error(`${String(data?.message ?? 'Host 拒绝了请求')}${detail}`)
    error.payload = data
    throw error
  }

  /**
   * One dictionary entry edited as a key/value pair.
   *
   * @param dict - stored dictionary.
   * @returns editable rows.
   */
  function toDictRows(dict) {
    if (dict === null || typeof dict !== 'object') return []
    return Object.entries(dict).map(([key, value]) => ({ key, value: String(value) }))
  }

  /**
   * Collapse edited rows back into the stored dictionary.
   *
   * @param rows - edited rows.
   * @returns the dictionary to save.
   */
  function fromDictRows(rows) {
    const dict = {}
    for (const row of rows) {
      const key = String(row.key ?? '').trim()
      if (key === '') continue
      dict[key] = String(row.value ?? '')
    }
    return dict
  }

  /**
   * Build the editable draft of one server.
   *
   * @param server - server as returned by the Host, or a fresh template.
   * @returns the draft row.
   */
  function toDraft(server) {
    const config = server.config ?? {}
    return {
      id: String(server.id ?? ''),
      serverName: String(server.serverName ?? server.id ?? ''),
      transport: server.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
      command: String(config.command ?? ''),
      args: Array.isArray(config.args) ? config.args.join('\n') : '',
      cwd: String(config.cwd ?? ''),
      env: toDictRows(config.env),
      url: String(config.url ?? ''),
      headers: toDictRows(config.headers),
      toolCallTimeoutMs: Number(config.toolCallTimeoutMs ?? DEFAULT_TIMEOUT),
      disabled: server.disabled === true,
    }
  }

  /**
   * Turn a draft back into the payload the Host validates.
   *
   * @param draft - edited draft.
   * @returns host payload server object.
   */
  function toServer(draft) {
    return {
      id: String(draft.id).trim(),
      serverName: String(draft.serverName).trim(),
      transport: draft.transport,
      command: String(draft.command).trim(),
      args: String(draft.args).split('\n').map((line) => line.trim()).filter((line) => line !== ''),
      cwd: String(draft.cwd).trim(),
      env: fromDictRows(draft.env),
      url: String(draft.url).trim(),
      headers: fromDictRows(draft.headers),
      toolCallTimeoutMs: Number(draft.toolCallTimeoutMs) || DEFAULT_TIMEOUT,
      disabled: draft.disabled === true,
    }
  }

  /**
   * Draft-level validation, mirroring the Host rules so a save is not attempted
   * with an obvious mistake.
   *
   * @param draft - edited draft.
   * @returns messages; empty when acceptable.
   */
  function draftErrors(draft) {
    const errors = []
    const id = String(draft.id).trim()
    const serverName = String(draft.serverName).trim()
    if (id === '') errors.push('id 不能为空')
    else if (!ID_PATTERN.test(id)) errors.push('id 只能含字母、数字、_ 和 -')
    if (serverName === '') errors.push('serverName 不能为空')
    else if (!SERVER_NAME_PATTERN.test(serverName)) errors.push('serverName 只能含字母、数字、_ 和 -，最长 32')
    if (draft.transport === 'stdio') {
      if (String(draft.command).trim() === '') errors.push('command 不能为空')
    } else if (String(draft.url).trim() === '') {
      errors.push('url 不能为空')
    }
    return errors
  }

  /** One key/value dictionary editor with masked secret values. */
  function DictEditor(props) {
    const { rows, onChange, keyPlaceholder, valuePlaceholder } = props
    const [revealed, setRevealed] = useState(() => new Set())

    const update = (index, patchRow) => {
      onChange(rows.map((row, position) => (position === index ? { ...row, ...patchRow } : row)))
    }
    const remove = (index) => () => {
      onChange(rows.filter((_, position) => position !== index))
    }
    const add = () => {
      onChange([...rows, { key: '', value: '' }])
    }
    const toggle = (index) => () => {
      setRevealed((current) => {
        const next = new Set(current)
        if (next.has(index)) next.delete(index)
        else next.add(index)
        return next
      })
    }

    return h('div', { className: 'mcp-dict' },
      rows.map((row, index) => {
        const secret = SECRET_KEY.test(String(row.key))
        const show = !secret || revealed.has(index)
        return h('div', { className: 'mcp-dict-row', key: String(index) },
          h('input', {
            className: 'mcp-input',
            value: row.key,
            spellCheck: false,
            placeholder: keyPlaceholder ?? 'KEY',
            onChange: (event) => update(index, { key: event.target.value }),
          }),
          h('input', {
            className: 'mcp-input',
            value: row.value,
            spellCheck: false,
            type: show ? 'text' : 'password',
            placeholder: valuePlaceholder ?? 'value',
            onChange: (event) => update(index, { value: event.target.value }),
          }),
          secret
            ? h('button', { className: 'mcp-btn tiny', type: 'button', title: '显示/隐藏', onClick: toggle(index) }, show ? '隐藏' : '显示')
            : h('span', null),
          h('button', { className: 'mcp-btn tiny danger', type: 'button', onClick: remove(index) }, '×'),
        )
      }),
      h('div', { className: 'mcp-actions' },
        h('button', { className: 'mcp-btn tiny', type: 'button', onClick: add }, '＋ 添加一项'),
      ),
    )
  }

  /** One labelled text input. */
  function Field(props) {
    const { label, hint, value, onChange, disabled, placeholder, full, type } = props
    return h('label', { className: 'mcp-row' + (full ? ' full' : '') },
      h('span', null, label),
      h('input', {
        className: 'mcp-input',
        value,
        type: type ?? 'text',
        spellCheck: false,
        disabled: disabled === true,
        placeholder: placeholder ?? '',
        onChange: (event) => onChange(event.target.value),
      }),
      hint !== undefined ? h('small', null, hint) : null,
    )
  }

  /** Render one probe result. */
  function ProbeResult(props) {
    const result = props.result
    if (result === null || result === undefined) return null
    if (result.ok !== true) {
      return h('div', { className: 'mcp-msg err' },
        `连接失败（${String(result.elapsedMs ?? 0)} ms）：${String(result.error ?? '未知错误')}`,
        Array.isArray(result.stderr) && result.stderr.length > 0
          ? h('div', { className: 'mcp-tools', style: { marginTop: '6px' } }, result.stderr.slice(-8).join('\n'))
          : null,
      )
    }
    const info = result.serverInfo ?? {}
    const tools = Array.isArray(result.tools) ? result.tools : []
    return h('div', { className: 'mcp-msg ok' },
      `握手成功（${String(result.elapsedMs ?? 0)} ms）：${String(info.name ?? 'server')} ${String(info.version ?? '')} · ${String(tools.length)} 个工具`,
      tools.length > 0
        ? h('div', { className: 'mcp-tools', style: { marginTop: '6px' } },
            tools.slice(0, 24).map((tool) => h('span', { key: tool.name }, tool.name)),
            tools.length > 24 ? h('span', null, `… 另有 ${String(tools.length - 24)} 个`) : null,
          )
        : null,
      result.toolsError !== undefined
        ? h('div', { className: 'mcp-sub', style: { marginTop: '4px' } }, `工具列表不可用：${String(result.toolsError)}`)
        : null,
    )
  }

  /**
   * The editor shared by "edit an existing server" and "add a new one".
   *
   * @param props - `{ draft, setDraft, mode, errors, onTest, testing, probe, onSave, onCancel, saving, target, setTarget }`
   */
  function ServerEditor(props) {
    const { draft, setDraft, mode, errors, onTest, testing, probe, onSave, onCancel, saving, target, setTarget } = props
    const { authorizing, onAuthorize } = props
    const patch = (next) => setDraft((current) => ({ ...current, ...next }))
    const invalid = errors.length > 0

    return h('div', { className: 'mcp-grid' },
      h(Field, { label: 'id（Loader 条目 id）', hint: '唯一标识；改它会重建条目', value: draft.id, onChange: (value) => patch({ id: value }) }),
      h(Field, {
        label: 'serverName（工具名前缀）',
        hint: '模型看到的工具名是 mcp__<serverName>__<tool>',
        value: draft.serverName,
        onChange: (value) => patch({ serverName: value }),
      }),

      h('label', { className: 'mcp-row' },
        h('span', null, 'transport'),
        h('select', {
          className: 'mcp-select',
          value: draft.transport,
          onChange: (event) => patch({ transport: event.target.value }),
        },
          h('option', { key: 'stdio', value: 'stdio' }, 'stdio（本地进程）'),
          h('option', { key: 'http', value: 'streamable-http' }, 'streamable-http（远程 URL）'),
        ),
      ),
      h(Field, {
        label: 'toolCallTimeoutMs',
        value: String(draft.toolCallTimeoutMs),
        type: 'number',
        onChange: (value) => patch({ toolCallTimeoutMs: Number(value) || DEFAULT_TIMEOUT }),
      }),

      draft.transport === 'stdio'
        ? [
            h(Field, { key: 'command', label: 'command', hint: '可执行文件，例如 node', value: draft.command, onChange: (value) => patch({ command: value }) }),
            h(Field, { key: 'cwd', label: 'cwd（可选）', value: draft.cwd, onChange: (value) => patch({ cwd: value }) }),
            h('label', { key: 'args', className: 'mcp-row full' },
              h('span', null, 'args（一行一个参数）'),
              h('textarea', {
                className: 'mcp-area',
                value: draft.args,
                spellCheck: false,
                onChange: (event) => patch({ args: event.target.value }),
              }),
            ),
            h('div', { key: 'env', className: 'mcp-row full' },
              h('span', null, 'env（认证和配置走这里）'),
              h(DictEditor, {
                rows: draft.env,
                keyPlaceholder: 'MY_AUTH_ACCOUNT',
                valuePlaceholder: 'value',
                onChange: (rows) => patch({ env: rows }),
              }),
            ),
          ]
        : [
            h(Field, { key: 'url', label: 'url', full: true, value: draft.url, onChange: (value) => patch({ url: value }) }),
            h('div', { key: 'headers', className: 'mcp-row full' },
              h('span', null, 'headers（Authorization: Bearer … 放这里）'),
              h(DictEditor, {
                rows: draft.headers,
                keyPlaceholder: 'Authorization',
                valuePlaceholder: 'Bearer …',
                onChange: (rows) => patch({ headers: rows }),
              }),
            ),
            h('div', { key: 'oauth', className: 'mcp-grid full' },
              h(Field, {
                label: 'OAuth client id（可选）',
                hint: '仅用于交互式认证；留空走动态客户端注册',
                value: draft.oauthClientId ?? '',
                onChange: (value) => patch({ oauthClientId: value }),
              }),
              h(Field, {
                label: 'OAuth client secret（可选）',
                hint: '只在授权服务器要求 client_secret 时填',
                value: draft.oauthClientSecret ?? '',
                onChange: (value) => patch({ oauthClientSecret: value }),
              }),
            ),
          ],

      mode === 'create'
        ? h('div', { key: 'target', className: 'mcp-actions full' },
            h('span', { className: 'mcp-sub' }, '写入位置：'),
            h('label', { className: 'mcp-radio' },
              h('input', { type: 'radio', checked: target === 'home', onChange: () => setTarget('home') }),
              h('span', null, 'home（所有 profile 生效）'),
            ),
            h('label', { className: 'mcp-radio' },
              h('input', { type: 'radio', checked: target === 'profile', onChange: () => setTarget('profile') }),
              h('span', null, '当前 profile'),
            ),
          )
        : null,

      errors.length > 0 ? h('div', { className: 'mcp-err full' }, errors.join('；')) : null,
      probe !== null ? h('div', { className: 'full' }, h(ProbeResult, { result: probe })) : null,

      h('div', { className: 'mcp-actions full' },
        h('button', { className: 'mcp-btn', type: 'button', disabled: testing || invalid, onClick: onTest }, testing ? '测试中…' : '测试连接'),
        draft.transport === 'streamable-http'
          ? h('button', {
              className: 'mcp-btn',
              type: 'button',
              disabled: authorizing || invalid,
              onClick: () => onAuthorize({ clientId: draft.oauthClientId, clientSecret: draft.oauthClientSecret }),
            }, authorizing ? '认证中…' : '认证（OAuth）')
          : null,
        h('button', { className: 'mcp-btn primary', type: 'button', disabled: saving || invalid, onClick: onSave }, saving ? '保存中…' : mode === 'create' ? '创建' : '保存'),
        h('button', { className: 'mcp-btn', type: 'button', disabled: saving, onClick: onCancel }, '取消'),
      ),
    )
  }

  /** Status chip for one server row. */
  function StatusChip(props) {
    const server = props.server
    if (server.disabled === true) return h('span', { className: 'mcp-chip off' }, '已停用')
    const tools = Number(server.live?.toolCount ?? 0)
    if (tools > 0) return h('span', { className: 'mcp-chip on' }, `已连接 · ${String(tools)} 个工具`)
    if (server.transport === 'streamable-http' || server.transport === 'stdio') {
      return h('span', { className: 'mcp-chip bad' }, '已启用 · 未连接')
    }
    return h('span', { className: 'mcp-chip off' }, '未知状态')
  }

  /** One server card: header, status, and the inline editor. */
  function ServerCard(props) {
    const { server, hashes, onToggle, onRemove, onSave, onAuthorize, authorizing, pending } = props
    const [editing, setEditing] = useState(false)
    const [confirming, setConfirming] = useState(false)
    const [draft, setDraft] = useState(null)
    const [probe, setProbe] = useState(null)
    const [testing, setTesting] = useState(false)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState(null)

    const startEdit = () => {
      setDraft(toDraft(server))
      setProbe(null)
      setError(null)
      setEditing(true)
    }
    const cancel = () => {
      setEditing(false)
      setProbe(null)
      setError(null)
    }
    const runTest = async () => {
      setTesting(true)
      setProbe(null)
      setError(null)
      try {
        const answer = await post('test', { server: toServer(draft) })
        setProbe(answer.result)
      } catch (failure) {
        setError(failure.message)
      } finally {
        setTesting(false)
      }
    }
    const save = async () => {
      setSaving(true)
      setError(null)
      try {
        await onSave(toServer(draft), server.id, draft.disabled, hashes)
        setEditing(false)
      } catch (failure) {
        setError(failure.message)
      } finally {
        setSaving(false)
      }
    }
    const drop = async () => {
      if (!confirming) {
        setConfirming(true)
        return
      }
      setError(null)
      try {
        await onRemove(server.id, hashes)
      } catch (failure) {
        setError(failure.message)
        setConfirming(false)
      }
    }

    // Arming "确认删除" disarms itself: a second click must land on the same
    // button, and an onBlur reset would fire between mousedown and click.
    useEffect(() => {
      if (!confirming) return undefined
      const timer = setTimeout(() => setConfirming(false), 4000)
      return () => clearTimeout(timer)
    }, [confirming])

    const errors = draft === null ? [] : draftErrors(draft)
    const readOnly = server.editable === false

    return h('div', { className: 'mcp-card' + (server.disabled ? ' off' : '') },
      h('div', { className: 'mcp-head' },
        !readOnly
          ? h('label', { className: 'mcp-switch' },
              h('input', {
                type: 'checkbox',
                checked: server.disabled !== true,
                disabled: pending,
                onChange: (event) => onToggle(server, event.target.checked, hashes).catch((failure) => setError(failure.message)),
              }),
              h('span', null, server.disabled ? '停用' : '启用'),
            )
          : null,
        h('span', { className: 'mcp-name' }, server.serverName === '' ? '(未命名)' : server.serverName),
        h('span', { className: 'mcp-chip' + (server.transport === 'streamable-http' ? ' http' : '') }, server.transport === '' ? '?' : server.transport),
        h('span', { className: 'mcp-chip src' }, server.source === 'home' ? 'home' : server.source === 'profile' ? 'profile' : 'plugin'),
        server.oauth?.authorized === true ? h('span', { className: 'mcp-chip on' }, 'OAuth 已认证') : null,
        h(StatusChip, { server }),
        h('span', { className: 'mcp-spacer' }),
        !readOnly
          ? h('button', {
              className: 'mcp-btn',
              type: 'button',
              disabled: pending || editing,
              onClick: () => (editing ? cancel() : startEdit()),
            }, editing ? '收起' : '编辑')
          : null,
        server.oauth?.available === true && !readOnly
          ? h('button', {
              className: 'mcp-btn',
              type: 'button',
              disabled: pending || authorizing,
              title: '走 OAuth 授权码流程（浏览器打开授权页）',
              onClick: () => onAuthorize({}),
            }, authorizing ? '认证中…' : server.oauth.authorized === true ? '重新认证' : '认证')
          : null,
        !readOnly
          ? h('button', {
              className: 'mcp-btn danger',
              type: 'button',
              disabled: pending || editing,
              onClick: drop,
            }, confirming ? '确认删除' : '删除')
          : null,
      ),

      h('div', { className: 'mcp-files' },
        readOnly
          ? `${server.id} · 由插件包提供，只读`
          : `${server.id}${server.overridden ? ' · 有 profile 覆盖行' : ''}${server.disabled ? ' · disabled: true' : ''}`,
      ),

      editing && draft !== null
        ? h(ServerEditor, {
            draft,
            setDraft,
            mode: 'edit',
            errors,
            onTest: runTest,
            testing,
            probe,
            onSave: save,
            onCancel: cancel,
            saving,
            authorizing,
            onAuthorize,
          })
        : null,

      !editing && probe !== null ? h(ProbeResult, { result: probe }) : null,
      error !== null ? h('div', { className: 'mcp-msg err' }, error) : null,
    )
  }

  /** A brand-new server card. */
  function NewServerCard(props) {
    const { onSave, onCancel, saving } = props
    const [target, setTarget] = useState('home')
    const [draft, setDraft] = useState(() => toDraft({ id: '', serverName: '', transport: 'stdio', config: {}, disabled: false }))
    const [probe, setProbe] = useState(null)
    const [testing, setTesting] = useState(false)
    const [error, setError] = useState(null)

    const errors = draftErrors(draft)

    const runTest = async () => {
      setTesting(true)
      setProbe(null)
      setError(null)
      try {
        const answer = await post('test', { server: toServer(draft) })
        setProbe(answer.result)
      } catch (failure) {
        setError(failure.message)
      } finally {
        setTesting(false)
      }
    }
    const save = async () => {
      setError(null)
      try {
        await onSave(toServer(draft), '', false, null, target)
      } catch (failure) {
        setError(failure.message)
      }
    }

    return h('div', { className: 'mcp-card' },
      h('div', { className: 'mcp-head' },
        h('span', { className: 'mcp-name' }, draft.serverName === '' ? '新增 MCP 服务器' : draft.serverName),
        h('span', { className: 'mcp-chip' }, draft.transport),
        h('span', { className: 'mcp-spacer' }),
        h('button', { className: 'mcp-btn', type: 'button', disabled: saving, onClick: onCancel }, '关闭'),
      ),
      h(ServerEditor, {
        draft,
        setDraft,
        mode: 'create',
        errors,
        onTest: runTest,
        testing,
        probe,
        onSave: save,
        onCancel,
        saving,
        target,
        setTarget,
        authorizing: false,
        onAuthorize: () => setError('先保存这个服务器，再点「认证」'),
      }),
      error !== null ? h('div', { className: 'mcp-msg err' }, error) : null,
    )
  }

  /** The settings page for this plugin. */
  function McpPage() {
    const [state, setState] = useState(null)
    const [error, setError] = useState(null)
    const [notice, setNotice] = useState(null)
    const [pending, setPending] = useState(false)
    const [adding, setAdding] = useState(false)
    const [saving, setSaving] = useState(false)
    const [authorizingId, setAuthorizingId] = useState(null)
    const stateRef = useRef(null)
    stateRef.current = state

    const load = useCallback(async () => {
      const data = await post('state')
      setState(data)
      setError(null)
      return data
    }, [])

    useEffect(() => {
      load().catch((failure) => setError(failure.message))
    }, [load])

    /**
     * Poll after a write: the Loader reconciles the patch file asynchronously, so
     * the page keeps reading state until the expected shape settles.
     */
    const waitFor = useCallback(async (predicate) => {
      setPending(true)
      try {
        const deadline = Date.now() + 10000
        for (;;) {
          const data = await load()
          if (predicate(data)) return data
          if (Date.now() > deadline) return data
          await sleep(400)
        }
      } finally {
        setPending(false)
      }
    }, [load])

    const toggle = useCallback(async (server, enabled, hashes) => {
      setNotice(null)
      try {
        const answer = await post('enabled', { id: server.id, enabled, hashes })
        if (answer.state) setState(answer.state)
        await waitFor((data) => {
          const row = (data.servers ?? []).find((entry) => entry.id === server.id)
          return row === undefined || row.disabled === !enabled
        })
        setNotice({ kind: 'ok', text: enabled ? `已启用 “${server.serverName}”，Loader 正在挂载。` : `已停用 “${server.serverName}”。` })
      } catch (failure) {
        setNotice({ kind: 'err', text: failure.message })
        await load().catch(() => {})
        throw failure
      }
    }, [load, waitFor])

    const save = useCallback(async (server, originalId, disabled, hashes, target) => {
      setNotice(null)
      setSaving(true)
      try {
        const answer = await post('save', {
          server: { ...server, disabled },
          originalId,
          target,
          hashes: hashes ?? (stateRef.current === null ? undefined : {
            home: stateRef.current.files.home.hash,
            profile: stateRef.current.files.profile.hash,
          }),
        })
        if (answer.state) setState(answer.state)
        setAdding(false)
        await waitFor((data) => (data.servers ?? []).some((entry) => entry.id === server.id))
        setNotice({ kind: 'ok', text: `已保存 “${server.serverName}”，Loader 正在同步。` })
      } catch (failure) {
        setNotice({ kind: 'err', text: failure.message })
        await load().catch(() => {})
        throw failure
      } finally {
        setSaving(false)
      }
    }, [load, waitFor])

    const remove = useCallback(async (id, hashes) => {
      setNotice(null)
      try {
        const answer = await post('remove', { id, hashes })
        if (answer.state) setState(answer.state)
        await waitFor((data) => !(data.servers ?? []).some((entry) => entry.id === id))
        setNotice({ kind: 'ok', text: `已删除 “${id}”。` })
      } catch (failure) {
        setNotice({ kind: 'err', text: failure.message })
        await load().catch(() => {})
        throw failure
      }
    }, [load, waitFor])

    /**
     * Run the interactive OAuth flow for one server.
     *
     * The popup is opened synchronously (a click handler must keep its user
     * gesture) and then pointed at the authorize URL once the Host returns it;
     * the flow itself finishes on the Host's loopback callback, so this only polls.
     */
    const authorize = useCallback(async (server, override) => {
      if (authorizingId !== null) return
      setAuthorizingId(server.id)
      setNotice(null)
      const popup = typeof window === 'undefined' ? null : window.open('', '_blank', 'width=520,height=720')
      try {
        const answer = await post('oauth-start', {
          id: server.id,
          clientId: override?.clientId,
          clientSecret: override?.clientSecret,
        })
        if (answer.status === 'authorized') {
          if (popup !== null && popup !== undefined) popup.close()
          await load()
          setNotice({ kind: 'ok', text: answer.message ?? '认证完成。' })
          return
        }
        const target = answer.authorizationUrl
        if (popup !== null && popup !== undefined) popup.location.href = target
        else window.open(target, '_blank', 'noopener')
        setNotice({ kind: 'ok', text: '已打开授权页，完成登录后这里会自动更新。' })
        const deadline = Date.now() + 4 * 60 * 1000
        for (;;) {
          await sleep(1200)
          const status = await post('oauth-status', { state: answer.state })
          if (status.status === 'authorized') {
            await waitFor((data) => (data.servers ?? []).some((row) => row.id === server.id && Number(row.live?.toolCount ?? 0) > 0))
            setNotice({ kind: 'ok', text: '认证成功，server 已挂载。' })
            return
          }
          if (status.status === 'error' || status.status === 'expired') {
            setNotice({ kind: 'err', text: status.message ?? '认证失败' })
            return
          }
          if (Date.now() > deadline) {
            setNotice({ kind: 'err', text: '授权超时，请重新点「认证」。' })
            return
          }
        }
      } catch (failure) {
        if (popup !== null && popup !== undefined) popup.close()
        setNotice({ kind: 'err', text: failure.message })
      } finally {
        setAuthorizingId(null)
      }
    }, [authorizingId, load, waitFor])

    const refresh = useCallback(async () => {
      setNotice(null)
      try {
        await load()
        setNotice({ kind: 'ok', text: '已重新读取配置。' })
      } catch (failure) {
        setNotice({ kind: 'err', text: failure.message })
      }
    }, [load])

    if (error !== null && state === null) {
      return h('div', { className: 'mcp-wrap' },
        h('h2', { className: 'mcp-title' }, 'MCP 服务器'),
        h('div', { className: 'mcp-msg err' }, error),
        h('div', { className: 'mcp-sub' }, '页面通过 /dsh-mcp-config/api 与 Host 通信；旧版 Host 尚未注册该路由时会出现这个提示，重启 dsh 后生效。'),
      )
    }
    if (state === null) {
      return h('div', { className: 'mcp-wrap' }, h('div', { className: 'mcp-sub' }, '正在读取 MCP 配置…'))
    }

    const servers = Array.isArray(state.servers) ? state.servers : []
    const enabled = servers.filter((server) => server.disabled !== true).length
    const hashes = { home: state.files.home.hash, profile: state.files.profile.hash }
    const brokenFile = [state.files.home, state.files.profile].find((file) => file.error !== null && file.error !== undefined)

    return h('div', { className: 'mcp-wrap' },
      h('div', null,
        h('h2', { className: 'mcp-title' }, 'MCP 服务器'),
        h('div', { className: 'mcp-sub' },
          '这些服务器是 dsh 的 Loader 条目，定义在 patch 文件里。启用/停用/修改会写回文件，dsh 立即热加载，不用重启。'),
      ),

      brokenFile !== undefined
        ? h('div', { className: 'mcp-msg err' }, `${brokenFile.path}：${String(brokenFile.error)}`)
        : null,

      servers.length === 0 && !adding
        ? h('div', { className: 'mcp-empty' }, '没有找到 MCP 服务器。点下面的「新增服务器」开始。')
        : servers.map((server) => h(ServerCard, {
            key: server.id,
            server,
            hashes,
            onToggle: toggle,
            onSave: save,
            onRemove: remove,
            onAuthorize: (override) => authorize(server, override),
            authorizing: authorizingId === server.id,
            pending,
          })),

      adding
        ? h(NewServerCard, {
            saving,
            onCancel: () => setAdding(false),
            onSave: save,
          })
        : null,

      h('div', { className: 'mcp-actions' },
        h('button', { className: 'mcp-btn', type: 'button', disabled: pending || adding, onClick: () => setAdding(true) }, '新增服务器'),
        h('button', { className: 'mcp-btn', type: 'button', disabled: pending, onClick: refresh }, '重新读取'),
        h('span', { className: 'mcp-sub' }, `${String(servers.length)} 个服务器，${String(enabled)} 个启用`),
        pending ? h('span', { className: 'mcp-sub' }, '正在等待 Loader 同步…') : null,
      ),

      notice !== null ? h('div', { className: 'mcp-msg ' + notice.kind }, notice.text) : null,

      h('div', { className: 'mcp-sub' },
        h('div', null, 'home：', h('span', { className: 'mcp-files' }, state.files.home.path)),
        h('div', null, 'profile：', h('span', { className: 'mcp-files' }, state.files.profile.path)),
      ),
    )
  }

  module.exports = {
    name: 'dsh-mcp-config-client',
    /** The settings shell provides the slot registry this page registers into. */
    inject: ['slots'],
    apply(ctx) {
      ensureCss()
      const slots = ctx.slots
      if (slots === undefined) return
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'mcp-servers', order: 21, label: 'MCP 服务器' },
        McpPage,
      ))
    },
  }
  return module.exports
  } catch (error) {
    window.__MCP_FACTORY_ERROR__ = String((error && error.stack) || error)
    throw error
  }
}

// The boot graph row is the Loader ENTRY id (`mcp-config`, inserted by this
// package's bundle patch), not the package name: the client runner imports the
// entry's `name`, and the entry is named by its id. Registering the package name
// as well is inert here and keeps the bundle usable if it is ever mounted under
// that id instead.
try {
  window.__ModuleLoader__.load({ id: 'mcp-config', factory })
  window.__ModuleLoader__.load({ id: 'dsh-mcp-config', factory })
} catch (error) {
  window.__MCP_REGISTER_ERROR__ = String((error && error.stack) || error)
  throw error
}
})()
