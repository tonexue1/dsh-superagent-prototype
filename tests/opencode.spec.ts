import { createServer, type ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExecutorConfigSchema } from '../src/policy.ts'
import { startRuntime, feishu } from './fixtures/host.ts'
import { deferred, waitUntil } from './fixtures/async.ts'

describe('worker backend settings', () => {
  it('keeps existing installations on DSH when no backend is configured', () => {
    expect(ExecutorConfigSchema.parse({})).toMatchObject({ backend: 'dsh' })
  })

  it('accepts an OpenCode endpoint and its own provider/model identifiers', () => {
    const parsed = ExecutorConfigSchema.safeParse({ backend: 'opencode', opencode: {
      baseUrl: 'http://127.0.0.1:4096', model: { providerID: 'local', modelID: 'worker' },
    } })
    expect(parsed.success).toBe(true)
  })

  it.each(['file:///tmp/server', 'http://user:secret@localhost:4096', 'http://localhost:4096/?token=secret'])
  ('rejects a non-HTTP endpoint or credentials in its URL: %s', baseUrl => {
    expect(ExecutorConfigSchema.safeParse({ backend: 'opencode', opencode: { baseUrl } }).success).toBe(false)
  })
})

describe('OpenCode workers through the real Engine and outbox', () => {
  let h: Awaited<ReturnType<typeof startRuntime>>
  const calls: { method: string; url: URL; body: Record<string, unknown> }[] = []
  const pending: { response: ServerResponse; message: Record<string, unknown> }[] = []
  let history: unknown[] = []
  let session = 0
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    const url = new URL(req.url!, 'http://localhost')
    calls.push({ method: req.method!, url, body })
    res.setHeader('content-type', 'application/json')
    if (req.method === 'POST' && url.pathname === '/session') return void res.end(JSON.stringify({ id: `ses_${++session}` }))
    if (url.pathname.endsWith('/abort')) {
      for (const item of pending.splice(0)) item.response.end(JSON.stringify({ info: { error: { name: 'MessageAbortedError' } }, parts: [] }))
      return void res.end('true')
    }
    if (req.method === 'GET') return void res.end(JSON.stringify(history))
    pending.push({ response: res, message: body })
  })
  const answer = (report: unknown) => {
    const item = pending.shift()!
    const response = { info: { id: `msg_reply${history.length}`, role: 'assistant', parentID: item.message.messageID, structured: report, finish: 'stop' }, parts: [] }
    history.push({ info: { id: item.message.messageID, role: 'user' }, parts: item.message.parts }, response)
    item.response.end(JSON.stringify(response))
  }
  beforeEach(async () => {
    calls.length = 0; pending.length = 0; history = []; session = 0
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    h = await startRuntime()
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, backend: 'opencode', maxWorkers: 1,
      opencode: { baseUrl: `http://127.0.0.1:${address.port}`, model: { providerID: 'local', modelID: 'worker' } } } })
  })
  afterEach(async () => {
    await h?.stop()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('creates an external session, delivers the original request, and records its structured result', async () => {
    const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修复登录失败'))
    await waitUntil(() => pending.length === 1, 1000)
    expect(h.agents.has(sessionId)).toBe(false)
    const request = pending[0]!.message
    expect(JSON.stringify(request.parts)).toContain('修复登录失败')
    expect(request.model).toEqual({ providerID: 'local', modelID: 'worker' })
    expect(calls[0]!.url.searchParams.get('directory')).toBe(ticket.execution!.directory)
    const detail = await h.api('GET', `tickets/${ticket.id}`)
    expect(detail.body.sessionId).toBe('')
    answer({ state: 'ready', summary: '登录修复完成，测试通过' })
    await waitUntil(() => !!h.runtime.store.tickets.get(ticket.id)?.ended)
    expect(h.runtime.store.tickets.get(ticket.id)).toMatchObject({ execution: { backend: 'opencode' }, ended: { outcome: 'completed' } })
    expect(JSON.stringify(h.relays(h.runtime.masterId))).toContain('登录修复完成')
  })

  it('pins follow-ups to the original backend and session after the default backend changes', async () => {
    const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修复登录失败'))
    await waitUntil(() => pending.length === 1, 1000)
    answer({ state: 'blocked', summary: '需要错误信息', human_action: '手机上显示什么错误？' })
    await waitUntil(() => !!h.runtime.store.tickets.get(ticket.id)?.attention)
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, backend: 'dsh' } })
    h.runtime.receive(feishu('2', '显示超时', { root_id: 'om_1', mentions: [] }))
    await h.runtime.idle()
    await waitUntil(() => pending.length === 1)
    expect(calls.filter(call => call.method === 'POST' && call.url.pathname === '/session')).toHaveLength(1)
    expect(calls.at(-1)!.url.pathname).toBe('/session/ses_1/message')
    expect(JSON.stringify(pending[0]!.message.parts)).toContain('显示超时')
    answer({ state: 'ready', summary: '已修复超时', human_action: null })
    await waitUntil(() => !!h.runtime.store.tickets.get(ticket.id)?.ended)
  })

  it('aborts the external turn on a human stop and rejects a late completion', async () => {
    const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修复登录失败'))
    await waitUntil(() => pending.length === 1, 1000)
    h.runtime.engine.stopTicket(ticket.id)
    await waitUntil(() => calls.some(call => call.url.pathname === '/session/ses_1/abort'))
    expect(h.runtime.store.tickets.get(ticket.id)).toMatchObject({ ended: { by: 'human', outcome: 'stopped' } })
  })

  it('keeps malformed model output as a failed task instead of declaring success', async () => {
    const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修复登录失败'))
    await waitUntil(() => pending.length === 1, 1000)
    answer({ text: '大概好了' })
    await waitUntil(() => h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report?.state === 'failed')
    expect(h.runtime.store.tickets.get(ticket.id)?.ended).toBeUndefined()
  })

  it('releases capacity after an internal progress report so the next queued ticket can start', async () => {
    await h.acceptedTicket(feishu('1', '@bot 修复登录失败'))
    await waitUntil(() => pending.length === 1)
    const two = await h.acceptedTicket(feishu('5', '@bot 修复导出失败'))
    expect(calls.filter(call => call.url.pathname === '/session')).toHaveLength(1)
    expect(h.runtime.store.tickets.get(two.ticket.id)?.assignments.at(-1)?.state).toBe('pending')
    answer({ state: 'progress', summary: '已检查，等待进一步输入' })
    await waitUntil(() => calls.filter(call => call.url.pathname === '/session').length === 2, 1000)
    await waitUntil(() => pending.length === 1)
    answer({ state: 'ready', summary: '导出修复完成' })
    await waitUntil(() => !!h.runtime.store.tickets.get(two.ticket.id)?.ended)
  })

  it('does not cancel remote work when the transaction stopping its Ticket rolls back', async () => {
    const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修复登录失败'))
    await waitUntil(() => pending.length === 1)
    expect(() => h.runtime.store.atomic(() => {
      h.runtime.engine.stopTicket(ticket.id)
      throw new Error('rollback')
    })).toThrow('rollback')
    await h.runtime.idle()
    expect(h.runtime.store.tickets.get(ticket.id)?.ended).toBeUndefined()
    expect(calls.filter(call => call.url.pathname.endsWith('/abort'))).toHaveLength(0)
    answer({ state: 'ready', summary: '完成' })
    await waitUntil(() => h.runtime.store.tickets.get(ticket.id)?.ended?.outcome === 'completed')
  })

  it('holds a launch paused during workspace preparation and starts it after resume', async () => {
    const prepare = deferred()
    h.hooks.prepare = prepare.promise
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, prepare: 'prepare-worktree' } })
    const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修复登录失败'))
    await waitUntil(() => h.subprocess.spawn.mock.calls.some(([spec]) => spec.argv[0] === 'sh'))
    await h.runtime.settings.pause(true, 'panel')
    prepare.resolve()
    await waitUntil(() => h.runtime.executor.activeCount() === 0)
    expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)).toMatchObject({ state: 'pending' })
    expect(pending).toHaveLength(0)
    await h.runtime.settings.pause(false, 'panel')
    await waitUntil(() => pending.length === 1)
    answer({ state: 'ready', summary: '完成' })
    await waitUntil(() => !!h.runtime.store.tickets.get(ticket.id)?.ended)
  })

  it('resumes a completed Ticket in the same persisted OpenCode session', async () => {
    const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修复登录失败'))
    await waitUntil(() => pending.length === 1)
    answer({ state: 'ready', summary: '完成' })
    await waitUntil(() => !!h.runtime.store.tickets.get(ticket.id)?.ended)
    await waitUntil(() => h.runtime.executor.activeCount() === 0)
    h.runtime.receive(feishu('2', '还是超时，请继续检查', { root_id: 'om_1', mentions: [] }))
    await h.runtime.idle()
    await waitUntil(() => pending.length === 1)
    expect(calls.filter(call => call.method === 'POST' && call.url.pathname === '/session')).toHaveLength(1)
    expect(h.runtime.store.tickets.get(ticket.id)?.assignments).toHaveLength(2)
    answer({ state: 'ready', summary: '补充修复完成' })
    await waitUntil(() => h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report?.summary === '补充修复完成')
  })

  it('refuses further external turns when a command restriction cannot be enforced by its server', async () => {
    const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修复登录失败'))
    await waitUntil(() => pending.length === 1)
    answer({ state: 'progress', summary: '已检查' })
    await waitUntil(() => h.runtime.executor.activeCount() === 0)
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, blockedCommands: ['curl'] } })
    h.runtime.receive(feishu('2', '继续检查', { root_id: 'om_1', mentions: [] }))
    await h.runtime.idle()
    await waitUntil(() => h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report?.state === 'failed', 1000)
    expect(pending).toHaveLength(0)
    expect(h.runtime.store.tickets.get(ticket.id)?.ended).toBeUndefined()
  })
})
