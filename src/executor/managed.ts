/** Routes each ticket to its pinned harness backend while sharing the durable queues and worker capacity. */
import type { AssessmentOutcome, Assignment, Ticket } from '../core/index.ts'
import { Later } from '../app/effects.ts'
import { DshExecutor, ticketExecution, type ExecutorHost } from './dsh.ts'
import { OpenCodeExecutor, type OpenCodeHost } from './opencode.ts'

type Backend = 'dsh' | 'opencode'
type Payload = { ticketId: string; assignmentId?: string }
type Handler = { run(payload: Payload, key: string): Promise<void> }
type Host = Omit<OpenCodeHost, 'otherActive'>
const backendOf = (ticket?: Ticket): Backend => ticket?.execution?.backend ?? 'dsh'

/** Shares queues/capacity across native and external workers; a ticket's backend never changes implicitly. */
export class ManagedExecutor {
  private readonly backends: { dsh: DshExecutor; opencode: OpenCodeExecutor }
  private readonly handlers = { dsh: new Map<string, Handler>(), opencode: new Map<string, Handler>() }
  private readonly starting = new Set<string>()
  constructor(private readonly host: Host) {
    const scoped = (backend: Backend): OpenCodeHost => {
      const otherActive = () => this.backends?.[backend === 'dsh' ? 'opencode' : 'dsh'].activeCount() ?? 0
      const nativeTickets = host.store.tickets
      const matches = (ticket: Ticket) => backendOf(ticket) === backend
      const tickets: typeof nativeTickets = {
        get: id => { const ticket = nativeTickets.get(id); return ticket && matches(ticket) ? ticket : undefined },
        list: () => nativeTickets.list().filter(matches), open: () => nativeTickets.open().filter(matches),
        active: () => nativeTickets.active().filter(matches), save: ticket => nativeTickets.save(ticket),
      }
      const store = new Proxy(host.store, { get(target, property) {
        if (property === 'tickets') return tickets
        if (property === 'settings' && backend === 'dsh') return () => {
          const settings = target.settings()
          return { ...settings, executor: { ...settings.executor, maxWorkers: Math.max(0, settings.executor.maxWorkers - otherActive()) } }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
      const effects: ExecutorHost['effects'] = {
        enqueue: host.effects.enqueue.bind(host.effects),
        handle: (kind, run) => { this.handlers[backend].set(kind, { run: run as unknown as Handler['run'] }) },
      }
      return { ...host, get engine() { return host.engine }, store, effects, otherActive }
    }
    this.backends = { dsh: new DshExecutor(scoped('dsh')), opencode: new OpenCodeExecutor(scoped('opencode')) }
    host.effects.handle('launch', async (payload, id) => {
      const ticket = host.store.tickets.get(payload.ticketId)
      if (!ticket) return
      if (this.activeCount() + this.starting.size >= host.store.settings().executor.maxWorkers) throw new Later('No worker slot is free')
      this.starting.add(ticket.id)
      try { await this.handlers[backendOf(ticket)].get('launch')!.run(payload, id) }
      finally { this.starting.delete(ticket.id) }
    }, { limit: () => host.paused() ? 0 : Math.max(0, host.store.settings().executor.maxWorkers - this.activeCount()), retry: [5000, 300_000] })
    host.effects.handle('delivery', async (payload, id) => {
      const ticket = host.store.tickets.get(payload.ticketId)
      if (ticket) await this.handlers[backendOf(ticket)].get('delivery')!.run(payload, id)
    }, { limit: () => host.paused() ? 0 : 4, quiet: true })
  }
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    return { ...ticket, execution: { ...ticketExecution(ticket, outcome, this.host.store.settings(), this.host.machine.stateDir),
      backend: this.host.store.settings().executor.backend } }
  }
  start(ticket: Ticket, assignment: Assignment): void { this.backends[backendOf(ticket)].start(ticket, assignment) }
  deliver(ticket: Ticket, assignment: Assignment): void { this.backends[backendOf(ticket)].deliver(ticket, assignment) }
  stop(ticket: Ticket, assignment: Assignment, reason: string): void { this.backends[backendOf(ticket)].stop(ticket, assignment, reason) }
  install(): void { for (const backend of Object.values(this.backends)) backend.install() }
  resume(): void { for (const backend of Object.values(this.backends)) backend.resume() }
  activeCount(): number { return this.backends.dsh.activeCount() + this.backends.opencode.activeCount() }
  async shutdown(): Promise<void> { await Promise.all(Object.values(this.backends).map(backend => backend.shutdown())) }
  dispose(): void { for (const backend of Object.values(this.backends)) backend.dispose() }
}
