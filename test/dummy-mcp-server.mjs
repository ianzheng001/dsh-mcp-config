// Minimal MCP stdio server used by the plugin's smoke test.
//
// It implements just enough of the protocol for `@deepseek-ai/dsh-mcp-client`
// to connect and list one tool, and appends a line to the marker file named by
// MCP_SMOKE_LOG on startup and on every request, so a test can prove the child
// really spawned and completed the handshake.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const log = (line) => {
  const target = process.env.MCP_SMOKE_LOG
  if (target !== undefined && target !== '') appendFileSync(target, `${new Date().toISOString()} ${line}\n`)
}

log('started')

const reply = (id, result) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

const server = createInterface({ input: process.stdin })
server.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  log(`request ${String(message.method ?? 'response')}`)
  if (message.id === undefined) return
  switch (message.method) {
    case 'initialize':
      reply(message.id, {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'dummy-smoke', version: '0.0.1' },
      })
      break
    case 'tools/list':
      reply(message.id, {
        tools: [{
          name: 'smoke_ping',
          description: 'Returns pong; only exists to prove the server connected.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        }],
      })
      break
    case 'tools/call':
      reply(message.id, { content: [{ type: 'text', text: 'pong' }] })
      break
    case 'ping':
      reply(message.id, {})
      break
    default:
      reply(message.id, {})
  }
})
