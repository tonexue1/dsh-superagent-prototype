/** OpenCode Server adapter. Each ticket owns a persistent external session and serialized turns. */
import { mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { key, latestAssignment, liveTicket, runningAssignment, waitsForPerson, type Assignment, type Ticket } from '../core/index.ts'
import { KV } from '../kv.ts'
import { Later } from '../app/effects.ts'
import type { Store } from '../app/store.ts'
import type { Tool } from '../app/tools/tool.ts'
import { resultRelay } from '../app/notices.ts'
import { runAsWorker, verifyDirectory } from '../infra/environment.ts'
import type { ExecutorHost } from './dsh.ts'

export interface OpenCodeHost extends ExecutorHost {
  readonly store: ExecutorHost['store'] & Pick<Store, 'get'>
  workerPrompt(ticket: Ticket): string
  workerTools(ticket: Ticket): Tool[]
  /** Other backends' active workers consume the same configured capacity. */
  otherActive(): number
  wakeQueue(): void
}
export interface OpenCodeBinding {
  id: string; baseUrl: string; directory: string
  model: { providerID: string; modelID: string } | null
}
type Response = { info: { id?: string; parentID?: string; role?: string; structured?: unknown; error?: unknown }; parts: unknown[] }
const ResponseSchema = z.object({ info: z.object({ id: z.string().optional(), parentID: z.string().optional(), role: z.string().optional(),
  structured: z.unknown().optional(), error: z.unknown().optional() }).passthrough(), parts: z.array(z.unknown()) })
const ReportSchema = z.object({
  state: z.enum(['progress', 'ready', 'blocked', 'failed', 'dropped']), summary: z.string().min(1),
  human_action: z.string().trim().min(1).max(1000).nullable().optional(),
  question_for_trigger_id: z.string().optional(), pr_number: z.number().int().positive().nullable().optional(),
  reply_to_trigger_id: z.string().optional(),
  handbacks: z.array(z.object({ trigger_id: z.string(), reason: z.string().min(1).max(300) }).strict()).optional(),
}).strict()
type Turn = { assignmentId: string; controller: AbortController; done: Promise<void> }

/** Runs ticket turns through OpenCode Server, bridges structured reports, and explicitly aborts remote work. */
export class OpenCodeExecutor {
  private readonly turns = new Map<string, Turn>()
  private readonly stopping = new Map<string, Promise<void>>()
  constructor(private readonly host: OpenCodeHost) {
    host.effects.handle('launch', payload => this.launch(payload.ticketId, payload.assignmentId), {
      limit: () => host.paused() ? 0 : Math.max(0, host.store.settings().executor.maxWorkers - this.activeCount() - host.otherActive()),
    })
    host.effects.handle('delivery', payload => this.deliverQueued(payload.ticketId), { limit: () => host.paused() ? 0 : 4, quiet: true })
  }
  start(ticket: Ticket, assignment: Assignment): void {
    this.host.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }
  deliver(ticket: Ticket, _assignment: Assignment): void { this.host.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id }) }
  private current(ticketId: string, assignmentId: string): Ticket | undefined {
    if (this.host.closing()) return
    const ticket = this.host.store.tickets.get(ticketId)
    return ticket && liveTicket(ticket) && latestAssignment(ticket)?.id === assignmentId ? ticket : undefined
  }
  private async request(binding: Pick<OpenCodeBinding, 'baseUrl' | 'directory'>, path: string, method: string, body?: unknown,
    signal = this.host.lifetime): Promise<unknown> {
    const url = new URL(`${binding.baseUrl.replace(/\/$/, '')}${path}`)
    url.searchParams.set('directory', binding.directory)
    const password = process.env.OPENCODE_SERVER_PASSWORD
    const headers = { 'content-type': 'application/json', ...(password
      ? { authorization: `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME ?? 'opencode'}:${password}`).toString('base64')}` } : {}) }
    const response = await fetch(url, { method, headers, signal, redirect: 'error', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    if (!response.ok) throw new Error(`OpenCode ${method} ${path}: HTTP ${response.status}`)
    return response.status === 204 ? undefined : response.json()
  }
  private async binding(ticket: Ticket, signal: AbortSignal): Promise<OpenCodeBinding> {
    const stored = this.host.store.get(KV.opencode.session(ticket.id))
    if (stored) return stored
    const config = this.host.store.settings().executor
    const directory = ticket.execution!.directory
    if (!await stat(directory).then(() => true, () => false)) {
      const command = config.prepare.trim()
      if (command) await runAsWorker(this.host.context.subprocess, ['sh', '-c', command], dirname(directory),
        AbortSignal.any([signal, AbortSignal.timeout(600_000)]), Object.fromEntries(this.host.environment(ticket).map(value => [value.key, value.value])))
      await mkdir(directory, { recursive: true })
    }
    await verifyDirectory(directory, this.host.context.subprocess, signal)
    const route = { baseUrl: config.opencode.baseUrl, directory }
    const created = z.object({ id: z.string().min(1) }).parse(await this.request(route, '/session', 'POST', {
      title: ticket.title,
      // Same execution authority as DSH workers. Questions use the structured report instead of an interactive TUI tool.
      permission: [{ permission: '*', pattern: '*', action: 'allow' }, { permission: 'question', pattern: '*', action: 'deny' }],
    }, AbortSignal.any([signal, AbortSignal.timeout(30_000)])))
    const binding = { ...route, id: created.id, model: config.opencode.model }
    this.host.store.set(KV.opencode.session(ticket.id), binding)
    const fresh = this.host.store.tickets.get(ticket.id)
    if (fresh?.execution) this.host.store.tickets.save({ ...fresh, execution: { ...fresh.execution, externalSession: { id: binding.id, baseUrl: binding.baseUrl } } })
    return binding
  }
  private async launch(ticketId: string, assignmentId: string): Promise<void> {
    const ticket = this.current(ticketId, assignmentId)
    if (!ticket || latestAssignment(ticket)?.state !== 'pending') return
    if (this.host.paused()) throw new Later('Processing is paused')
    const previous = this.stopping.get(ticketId)
    if (previous) await previous
    if (!this.current(ticketId, assignmentId)) return
    if (this.turns.has(ticketId)) throw new Later('Previous OpenCode turn is still settling')
    this.begin(ticketId, assignmentId, true)
  }
  private async deliverQueued(ticketId: string): Promise<void> {
    const ticket = this.host.store.tickets.get(ticketId), assignment = ticket && runningAssignment(ticket)
    if (!ticket || !assignment || !liveTicket(ticket) || !ticket.undelivered.length) return
    if (this.host.paused() || this.turns.has(ticketId)) throw new Later('OpenCode turn is busy or processing is paused')
    const human = ticket.inputs.some(input => ticket.undelivered.includes(input.id) && (input.kind === 'text' || input.kind === 'trigger' && input.human))
    if (this.activeCount() + this.host.otherActive() >= this.host.store.settings().executor.maxWorkers + (human ? 1 : 0)) throw new Later('No worker slot is free')
    this.begin(ticketId, assignment.id, false)
  }
  private begin(ticketId: string, assignmentId: string, launch: boolean): void {
    const controller = new AbortController()
    const turn: Turn = { assignmentId, controller, done: Promise.resolve() }
    this.turns.set(ticketId, turn)
    turn.done = this.run(ticketId, assignmentId, launch, AbortSignal.any([controller.signal, this.host.lifetime]))
      .catch(error => {
        if (!controller.signal.aborted && !this.host.lifetime.aborted && this.current(ticketId, assignmentId)) {
          if (error instanceof Later) {
            const ticket = this.current(ticketId, assignmentId)!
            if (launch) this.start(ticket, latestAssignment(ticket)!)
            else this.deliver(ticket, latestAssignment(ticket)!)
          } else this.failed(ticketId, String(error))
        }
      }).finally(() => {
        if (this.turns.get(ticketId) === turn) this.turns.delete(ticketId)
        const ticket = this.current(ticketId, assignmentId)
        if (ticket?.undelivered.length && !waitsForPerson(ticket)) this.deliver(ticket, latestAssignment(ticket)!)
        if (!this.host.closing()) this.host.wakeQueue()
      })
  }
  private async run(ticketId: string, assignmentId: string, launch: boolean, signal: AbortSignal): Promise<void> {
    let ticket = this.current(ticketId, assignmentId)
    if (!ticket) return
    if (this.host.store.settings().executor.blockedCommands.length) {
      throw new Error('OpenCode requires its own command policy; blockedCommands cannot be enforced by this adapter')
    }
    const binding = await this.binding(ticket, signal)
    if (!this.current(ticketId, assignmentId)) return
    if (launch && ticket.assignments.length > 1) await this.request(binding, `/session/${binding.id}/abort`, 'POST', undefined,
      AbortSignal.any([signal, AbortSignal.timeout(10_000)]))
    if (this.host.paused()) throw new Later('Processing is paused')
    if (launch) this.host.engine.assignmentStarted(ticketId, assignmentId)
    ticket = this.current(ticketId, assignmentId)!
    const inputs = ticket.inputs.filter(input => ticket!.undelivered.includes(input.id))
    const requestId = launch ? `assignment:${assignmentId}` : inputs.map(input => input.id).join(':')
    const messageID = `msg_${key('opencode', ticketId, requestId)}`
    const history = z.array(ResponseSchema).parse(await this.request(binding, `/session/${binding.id}/message`, 'GET', undefined,
      AbortSignal.any([signal, AbortSignal.timeout(30_000)])))
    let response: Response | undefined = history.find(message => message.info.parentID === messageID && (message.info.structured !== undefined || message.info.error))
    if (!response) {
      if (history.some(message => message.info.id === messageID)) throw new Error('An earlier OpenCode turn was interrupted; retry the ticket to continue without duplicating its input')
      const triggers = launch ? ticket.origin.triggerIds.flatMap(id => this.host.store.triggers.get(id) ?? []) : []
      const deliveries = inputs.map(input => input.kind === 'trigger' ? { ...input, trigger: this.host.store.triggers.get(input.triggerId) } : input)
      const text = JSON.stringify({ ticket_id: ticketId, title: ticket.title, assignment: ticket.execution?.assignment, mandate: ticket.mandate,
        ...(launch ? { original_requests: triggers } : {}), inputs: deliveries,
        ...(ticket.assignments.length > 1 ? { recovery: 'Inspect existing work and external state first; do not repeat completed actions.' } : {}) })
      signal.throwIfAborted()
      if (!this.current(ticketId, assignmentId)) return
      response = ResponseSchema.parse(await this.request(binding, `/session/${binding.id}/message`, 'POST', {
        messageID, ...(binding.model ? { model: binding.model } : {}), tools: { question: false },
        system: `${this.host.workerPrompt(ticket)}\n\nOpenCode adapter protocol takes precedence for communication: orchestrator_* tools are not installed here. `
          + 'Read AGENTS.md and the original requests. Use your native tools to perform only the authorized task. '
          + 'Return the required structured report. Put a concrete question in human_action and use blocked when you need a human. '
          + 'For out-of-scope follow-ups, return handbacks with their trigger_id and reason; do not execute that extra work. '
          + 'Never post task status or result comments directly; the host relays reports to the originating conversation.',
        format: { type: 'json_schema', schema: z.toJSONSchema(ReportSchema), retryCount: 2 }, parts: [{ type: 'text', text }],
      }, signal))
    }
    if (signal.aborted || !this.current(ticketId, assignmentId)) return
    if (response.info.error) throw new Error(`OpenCode turn failed: ${JSON.stringify(response.info.error)}`)
    const { handbacks, ...report } = ReportSchema.parse(response.info.structured)
    const ids = inputs.map(input => input.id)
    this.host.engine.inputsDelivered(ticketId, assignmentId, ids)
    this.host.engine.inputsRead(ticketId, ids)
    this.host.engine.turnEnded(ticketId, assignmentId)
    for (const handback of handbacks ?? []) await this.call(ticket, 'orchestrator_trigger_handback', handback, signal)
    await this.call(ticket, 'orchestrator_report', report, signal)
  }
  private async call(ticket: Ticket, name: string, args: unknown, signal: AbortSignal): Promise<unknown> {
    const tool = this.host.workerTools(ticket).find(tool => tool.name === name)
    if (!tool) throw new Error(`Missing worker bridge: ${name}`)
    return tool.execute(tool.schema.parse(args), signal)
  }
  private failed(ticketId: string, summary: string): void {
    const ticket = this.host.store.tickets.get(ticketId), assignment = ticket && latestAssignment(ticket)
    if (!ticket || !assignment) return
    if (assignment.state === 'pending') this.host.engine.assignmentStarted(ticketId, assignment.id)
    this.host.engine.turnEnded(ticketId, assignment.id)
    const updated = this.host.engine.report(ticketId, { state: 'failed', summary })
    const relay = resultRelay(updated, 'failed', summary)
    this.host.sessions.relay(relay.id, relay.text)
  }
  stop(ticket: Ticket, _assignment: Assignment, _reason: string): void {
    this.host.store.afterCommit(() => { this.stopRemote(ticket) })
  }
  private stopRemote(ticket: Ticket): void {
    const turn = this.turns.get(ticket.id)
    const binding = this.host.store.get(KV.opencode.session(ticket.id))
    // Abort the server as well as the local HTTP request; closing a socket does not cancel server-side execution.
    turn?.controller.abort()
    const stopped = (binding ? this.request(binding, `/session/${binding.id}/abort`, 'POST', undefined, AbortSignal.timeout(10_000)) : Promise.resolve())
      .then(() => {}, error => { this.host.health.set({ state: 'error', detail: `OpenCode stop failed: ${String(error)}` }) })
    this.stopping.set(ticket.id, stopped)
    void stopped.finally(() => { if (this.stopping.get(ticket.id) === stopped) this.stopping.delete(ticket.id) })
  }
  activeCount(): number { return this.turns.size }
  install(): void { /* HTTP turns are owned here, not by DSH's agent event bus. */ }
  resume(): void {
    for (const ticket of this.host.store.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const running = runningAssignment(ticket), latest = latestAssignment(ticket)
      if (running) this.host.engine.assignmentInterrupted(ticket.id, running.id)
      else if (latest?.state === 'pending' && !waitsForPerson(ticket)) this.start(ticket, latest)
    }
  }
  async shutdown(): Promise<void> {
    for (const [id, turn] of this.turns) {
      const ticket = this.host.store.tickets.get(id)
      if (ticket) this.stop(ticket, latestAssignment(ticket)!, 'host shutdown')
      else turn.controller.abort()
    }
    await Promise.allSettled([...this.stopping.values(), ...[...this.turns.values()].map(turn => turn.done)])
  }
  dispose(): void { for (const turn of this.turns.values()) turn.controller.abort() }
}
