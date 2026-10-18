/**
 * Connection probe for one MCP server configuration.
 *
 * This is the "authenticate" half of the manager: it opens a real MCP session
 * with the exact transport, headers, and environment the runtime would use, then
 * reports either what the server answered (`initialize` + `tools/list`) or the
 * precise failure — a 401 from an expired token reads very differently from a
 * missing executable, and both are what a credential edit needs to see.
 *
 * The probe is deliberately independent of the live connection: it spawns its own
 * child process / HTTP session and closes it again, so testing a server never
 * disturbs the connection the model is currently using.
 *
 * @module dsh-mcp-config/probe
 */

/** Client identity announced to the probed server. */
const PROBE_CLIENT = { name: 'dsh-mcp-config', version: '0.2.0' }

/** Default budget for one probe; a dead TCP connect or a hung spawn must not hang the page. */
export const DEFAULT_PROBE_TIMEOUT_MS = 20000

/** Cap on retained stderr lines, so a chatty server cannot flood the response. */
const MAX_STDERR_LINES = 40

/**
 * Resolve the modules a probe needs.
 *
 * All four come from the Harness installation, not from this plugin's own
 * dependency tree: a second copy of the MCP SDK would negotiate a different
 * protocol revision than the runtime and report states the runtime never sees.
 *
 * @param load - resolver that returns a module by name.
 * @returns the module table consumed by {@link probeServer}.
 */
export async function loadProbeModules(load) {
  const [client, stdio, subprocess] = await Promise.all([
    load('@modelcontextprotocol/client'),
    load('@modelcontextprotocol/client/stdio'),
    load('@deepseek-ai/dsh-subprocess'),
  ])
  return {
    Client: client.Client,
    StreamableHTTPClientTransport: client.StreamableHTTPClientTransport,
    StdioClientTransport: stdio.StdioClientTransport,
    scrubbedParentEnv: subprocess.scrubbedParentEnv,
  }
}

/**
 * Turn one plain config into a ready transport.
 *
 * @param modules - module table from {@link loadProbeModules}.
 * @param config - server config (`transport`, plus transport-specific fields).
 * @returns a transport the MCP client can connect.
 */
function createTransport(modules, config) {
  if (config.transport === 'streamable-http') {
    return new modules.StreamableHTTPClientTransport(new URL(String(config.url)), {
      requestInit: { headers: config.headers ?? {} },
    })
  }
  return new modules.StdioClientTransport({
    command: String(config.command),
    args: Array.isArray(config.args) ? config.args.map((arg) => String(arg)) : [],
    // Same scrub the runtime applies: no inherited credentials, no stale DSH_*.
    env: { ...modules.scrubbedParentEnv(), ...(config.env ?? {}) },
    cwd: config.cwd === undefined || config.cwd === '' ? undefined : String(config.cwd),
    stderr: 'pipe',
  })
}

/**
 * Keep the tail of a child's stderr for the failure report.
 *
 * @param transport - started MCP transport.
 * @param sink - array mutated in place.
 */
function captureStderr(transport, sink) {
  const stream = transport.stderr
  if (stream === null || stream === undefined || typeof stream.on !== 'function') return
  stream.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      sink.push(trimmed)
    }
    if (sink.length > MAX_STDERR_LINES) sink.splice(0, sink.length - MAX_STDERR_LINES)
  })
}

/**
 * Human-readable failure text, preferring the MCP SDK's own message.
 *
 * @param error - thrown value.
 * @returns one line safe to render.
 */
function messageOf(error) {
  if (error === null || error === undefined) return '未知错误'
  const text = String(error.message ?? error)
  const cause = error.cause
  return cause === null || cause === undefined ? text : `${text}（${String(cause.message ?? cause)}）`
}

/**
 * Open one MCP session, list its tools, and close it again.
 *
 * @param modules - module table from {@link loadProbeModules}.
 * @param config - server config; the same shape the Loader entry carries.
 * @param options - `timeoutMs` budget for the whole probe.
 * @returns `{ ok, serverInfo, tools, elapsedMs, stderr }` on success,
 *          `{ ok: false, error, elapsedMs, stderr }` on failure. Never throws.
 */
export async function probeServer(modules, config, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS)
  const startedAt = Date.now()
  const stderr = []
  let transport
  let client
  let timer

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`连接超时（${String(timeoutMs)} ms 内没有完成握手）`))
    }, timeoutMs)
    timer.unref?.()
  })

  const run = async () => {
    transport = createTransport(modules, config)
    captureStderr(transport, stderr)
    client = new modules.Client(PROBE_CLIENT, { capabilities: {}, versionNegotiation: { mode: 'auto' } })
    await client.connect(transport)
    const serverInfo = client.getServerVersion?.() ?? {}
    let tools = []
    try {
      const listed = await client.listTools()
      tools = Array.isArray(listed?.tools) ? listed.tools : []
    } catch (error) {
      // A server may legitimately expose no tools; only the handshake is decisive.
      return {
        ok: true,
        serverInfo,
        capabilities: client.getServerCapabilities?.() ?? {},
        instructions: client.getInstructions?.() ?? '',
        tools: [],
        toolsError: messageOf(error),
        elapsedMs: Date.now() - startedAt,
        stderr,
      }
    }
    return {
      ok: true,
      serverInfo,
      capabilities: client.getServerCapabilities?.() ?? {},
      instructions: client.getInstructions?.() ?? '',
      tools: tools.map((tool) => ({ name: String(tool.name), description: String(tool.description ?? '') })),
      elapsedMs: Date.now() - startedAt,
      stderr,
    }
  }

  try {
    return await Promise.race([run(), timeout])
  } catch (error) {
    return { ok: false, error: messageOf(error), elapsedMs: Date.now() - startedAt, stderr }
  } finally {
    clearTimeout(timer)
    try {
      await client?.close?.()
    } catch {
      // A closing transport that already failed is not a new failure.
    }
  }
}
