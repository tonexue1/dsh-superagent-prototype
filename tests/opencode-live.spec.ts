/** Optional real-harness contract test. A deterministic local model exercises OpenCode's actual tool loop. */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { startRuntime, feishu } from './fixtures/host.ts'
import { waitUntil } from './fixtures/async.ts'

it.skipIf(!process.env.OPENCODE_TEST_BIN)('runs a real OpenCode tool turn and bridges its structured report into a completed Ticket', async () => {
  const data = mkdtempSync(join(tmpdir(), 'opencode-contract-'))
  const calls: string[] = []
  let toolTurns = 0
  const model = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { stream?: boolean; tools?: { function: { name: string } }[] }
    const names = body.tools?.map(tool => tool.function.name) ?? []
    calls.push(`${req.url} ${names.join(',')}`)
    const structured = names.find(name => /structured/i.test(name))
    const tool = names.length ? ++toolTurns === 1 ? 'bash' : structured : undefined
    const args = tool === 'bash' ? { command: "printf 'OPENCODE_WORKER_OK' > harness-smoke.txt", description: 'Write isolated harness smoke marker' }
      : { state: 'ready', summary: 'OPENCODE_REAL_HARNESS_OK' }
    const message = tool ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${toolTurns}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }
      : { role: 'assistant', content: 'Smoke verification' }
    const finish = tool ? 'tool_calls' : 'stop'
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, ...message.tool_calls![0] }] } : message
      const chunk = (value: unknown, finish_reason: string | null) => ({ id: 'chatcmpl-smoke', object: 'chat.completion.chunk', created: 1,
        model: 'worker', choices: [{ index: 0, delta: value, finish_reason }] })
      res.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`)
      res.write(`data: ${JSON.stringify(chunk({}, finish))}\n\n`)
      res.end('data: [DONE]\n\n')
    } else {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ id: 'chatcmpl-smoke', object: 'chat.completion', created: 1, model: 'worker',
        choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }))
    }
  })
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
  const port = (model.address() as { port: number }).port
  for (const name of ['config', 'cache', 'data', 'state']) mkdirSync(join(data, name))
  const child = spawn(process.env.OPENCODE_TEST_BIN!, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: data, env: { ...process.env, OPENCODE_SERVER_PASSWORD: '', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true',
      XDG_CONFIG_HOME: join(data, 'config'), XDG_CACHE_HOME: join(data, 'cache'), XDG_DATA_HOME: join(data, 'data'), XDG_STATE_HOME: join(data, 'state'),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'fixture/worker', small_model: 'fixture/worker', share: 'disabled', autoupdate: false,
        provider: { fixture: { npm: '@ai-sdk/openai-compatible', name: 'Local contract fixture',
          options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'fixture-only' },
          models: { worker: { name: 'Fixture worker', limit: { context: 64000, output: 4096 } } } } } }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  let h: Awaited<ReturnType<typeof startRuntime>> | undefined
  try {
    await waitUntil(() => /http:\/\/127\.0\.0\.1:\d+/.test(output), 20_000)
    const baseUrl = /http:\/\/127\.0\.0\.1:\d+/.exec(output)![0]
    h = await startRuntime()
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, backend: 'opencode', opencode: {
      baseUrl, model: { providerID: 'fixture', modelID: 'worker' },
    } } })
    const { ticket } = await h.acceptedTicket(feishu('1', '@bot 验证执行器，在当前目录生成 harness-smoke.txt，内容 OPENCODE_WORKER_OK'))
    await waitUntil(() => !!h!.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report, 45_000)
    const final = h.runtime.store.tickets.get(ticket.id)!
    expect(final.assignments.at(-1)?.report, JSON.stringify({ output, calls })).toMatchObject({ state: 'ready', summary: 'OPENCODE_REAL_HARNESS_OK' })
    expect(final.ended?.outcome).toBe('completed')
    expect(readFileSync(join(ticket.execution!.directory, 'harness-smoke.txt'), 'utf8')).toBe('OPENCODE_WORKER_OK')
    expect(toolTurns).toBeGreaterThanOrEqual(2)
  } finally {
    await h?.stop()
    child.kill('SIGTERM')
    await new Promise<void>(resolve => child.exitCode !== null ? resolve() : child.once('close', () => resolve()))
    model.closeAllConnections()
    await new Promise<void>(resolve => model.close(() => resolve()))
    rmSync(data, { recursive: true, force: true })
  }
}, 70_000)
