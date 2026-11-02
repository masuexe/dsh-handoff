import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import fs from 'node:fs'

const terminal = new Set(['completed', 'blocked', 'failed', 'interrupted', 'cancelled'])
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const now = () => new Date().toISOString()

export function parseReport(text) {
  // Accept a complete terminal JSON object after a short prose preamble or fence.
  const candidates = [text, ...[...text.matchAll(/(?:^|\n)[ \t]*(?=\{)/g)]
    .map(match => text.slice(match.index).trim().replace(/\s*```\s*$/, ''))]
  for (const candidate of candidates) {
    try {
      const report = JSON.parse(candidate)
      if (report && !Array.isArray(report) && ['completed', 'blocked', 'failed'].includes(report.status)) return report
    } catch {}
  }
}

function save(file, value) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(file + '.tmp', file)
}

/** A local socket is the submit boundary. Only its owner can reach it. */
export class HandoffHost {
  constructor(ctx, options = {}) {
    this.ctx = ctx
    this.home = options.home ?? process.env.DSH_HANDOFF_HOME ?? path.join(os.homedir(), '.local/state/dsh-handoff')
    this.socket = options.socket ?? process.env.DSH_HANDOFF_HOST_SOCKET ?? path.join(this.home, 'host.sock')
    this.jobs = new Map()
    this.workspaces = new Set()
    this.connections = new Set()
    this.handles = new Map()
    this.waiters = new Map()
    this.closed = false
    fs.mkdirSync(path.join(this.home, 'host-jobs'), { recursive: true, mode: 0o700 })
    for (const id of fs.readdirSync(path.join(this.home, 'host-jobs'))) {
      if (!uuid.test(id)) continue
      const file = this.file(id)
      if (!fs.existsSync(file)) continue
      const job = JSON.parse(fs.readFileSync(file, 'utf8'))
      this.jobs.set(id, job)
    }
  }

  file(id) { return path.join(this.home, 'host-jobs', id, 'job.json') }
  persist(job) { save(this.file(job.id), job); this.jobs.set(job.id, job) }
  info(job) {
    const { request_hash, ...publicJob } = job
    return publicJob
  }

  async submit(request) {
    if (this.closed) throw new Error('The handoff host is closing.')
    if (!uuid.test(request.id ?? '')) throw new Error('Invalid job ID.')
    if (typeof request.prompt !== 'string' || !request.prompt.trim()) throw new Error('The prompt is empty.')
    if (request.prompt.length > 1024 * 1024) throw new Error('The prompt exceeds one MiB.')
    if (!Number.isInteger(request.timeout_seconds) || request.timeout_seconds < 1) throw new Error('Invalid task time limit.')
    if (!path.isAbsolute(request.cwd ?? '')) throw new Error('The workspace must be an absolute path.')
    const cwd = fs.realpathSync(request.cwd)
    if (!fs.statSync(cwd).isDirectory()) throw new Error('The workspace is not a directory.')
    const hash = createHash('sha256').update(JSON.stringify({ cwd, model: request.model,
      effort: request.effort, prompt: request.prompt, timeout: request.timeout_seconds })).digest('hex')
    const previous = this.jobs.get(request.id)
    if (previous) {
      if (previous.request_hash !== hash) throw new Error('The job ID already names another request.')
      return this.info(previous)
    }
    // Reserve before the first await. A second client cannot create another Agent.
    const job = { id: request.id, session_id: `session-${request.id}`, cwd,
      model: request.model, effort: request.effort, request_hash: hash,
      status: 'starting', created_at: now() }
    fs.mkdirSync(path.dirname(this.file(job.id)), { recursive: true, mode: 0o700 })
    this.persist(job)
    if (this.workspaces.has(cwd)) {
      this.finish(job, { status: 'blocked', error: 'Another Web Host handoff owns this workspace.' })
      return this.info(job)
    }
    this.workspaces.add(cwd)
    this.run(job, request).catch(error => {
      this.finish(job, { status: 'failed', error: String(error) })
    }).finally(() => this.workspaces.delete(cwd))
    return this.info(job)
  }

  async run(job, request) {
    const selection = await this.ctx.llm.resolveCallConfig({
      provider: 'magpie', model: request.model, reasoningEffort: request.effort })
    const selected = { provider: selection.provider, model: selection.model,
      reasoningEffort: selection.reasoningEffort }
    const handle = await this.ctx.agents.create({
      sessionId: job.session_id,
      meta: { cwd: job.cwd, agentPreset: 'standard' },
      agentOptions: selected,
      setup: async (agentCtx, agent) => {
        await this.ctx.agentPresets.mount(agentCtx, 'standard')
        // Seed the session-local selection before Web observers can resolve it.
        // Do not call selectModel(), which also changes the global default.
        agent.session.append('model/selection', selected)
      },
    })
    this.handles.set(job.id, handle)
    if (this.closed) {
      await handle.dispose()
      throw new Error('The plugin closed during Agent creation.')
    }
    const agent = handle.agent
    const log = path.join(path.dirname(this.file(job.id)), 'events.ndjson')
    let text = '', reason
    const stop = this.ctx.on('session/event', (session, event) => {
      if (session.id !== job.session_id) return
      fs.appendFileSync(log, JSON.stringify(event) + '\n', { mode: 0o600 })
      if (event.type === 'assistant/message') text = event.data.message.content
        .filter(block => block.type === 'text').map(block => block.text).join('') || text
      if (event.type === 'turn/end') reason = event.data.reason
    }, { global: true })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      agent.cancel({ kind: 'hook', reason: 'The handoff task exceeded its time limit.' })
    }, request.timeout_seconds * 1000)
    try {
      job.status = 'running'; job.started_at = now(); job.events_path = log
      this.persist(job)
      await this.ctx.sessionController.rename({ sessionId: job.session_id,
        title: `Handoff ${job.id.slice(0, 8)}` })
      await this.ctx.sessionController.prompt({ sessionId: job.session_id,
        requestId: randomUUID(), mode: 'queue',
        content: [{ type: 'text', text: request.prompt }] }, new AbortController().signal)
      while (true) {
        await agent.whenIdle()
        const seq = agent.session.seq
        const children = await this.ctx.get('subagents')?.waitForChildren(agent)
        if (!children && agent.status === 'idle' && agent.session.seq === seq) break
      }
      await this.ctx.sessions.flush(agent.session)
      const report = parseReport(text)
      const status = !timedOut && reason?.kind === 'completed' &&
        ['completed', 'blocked', 'failed'].includes(report?.status) ? report.status : 'failed'
      this.finish(job, { status, text, report, reason,
        ...(timedOut ? { error: 'The handoff task exceeded its time limit.' } : {}) })
    } finally {
      clearTimeout(timer)
      stop()
    }
  }

  finish(job, fields) {
    if (terminal.has(job.status)) return
    Object.assign(job, fields, { finished_at: now() })
    this.persist(job)
    for (const resolve of this.waiters.get(job.id) ?? []) resolve(this.info(job))
    this.waiters.delete(job.id)
  }

  async wait(id) {
    const job = this.jobs.get(id)
    if (!job) throw new Error('The job does not exist on this Host.')
    if (terminal.has(job.status)) return this.info(job)
    return new Promise(resolve => {
      const waiters = this.waiters.get(id) ?? new Set()
      waiters.add(resolve); this.waiters.set(id, waiters)
    })
  }

  async request(message) {
    if (message.command === 'probe') return { protocol: 1, build: 2, pid: process.pid, backend: 'web-host' }
    if (message.command === 'inspect') {
      const job = this.jobs.get(message.id)
      if (!job) throw new Error('The job does not exist on this Host.')
      const observation = await this.ctx.sessionQuery.observeSession(job.session_id)
      try {
        return { session_id: job.session_id, source: observation.source,
          agent_status: this.ctx.agents.get(job.session_id)?.status,
          interrupted: observation.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'interrupted'),
          default_model: this.ctx.agentDefaultModel.currentSelection() }
      } finally { observation[Symbol.dispose]() }
    }
    if (message.command === 'submit') return this.submit(message)
    if (message.command === 'wait') return this.wait(message.id)
    if (message.command === 'status') {
      const job = this.jobs.get(message.id)
      if (!job) throw new Error('The job does not exist on this Host.')
      return this.info(job)
    }
    throw new Error('Unknown handoff command.')
  }

  async listen() {
    fs.mkdirSync(path.dirname(this.socket), { recursive: true, mode: 0o700 })
    if (fs.existsSync(this.socket)) {
      const active = await new Promise(resolve => {
        const probe = net.createConnection(this.socket)
        probe.once('connect', () => { probe.destroy(); resolve(true) })
        probe.once('error', () => resolve(false))
      })
      if (active) throw new Error('Another handoff host owns the socket.')
      fs.unlinkSync(this.socket)
    }
    this.server = net.createServer(socket => {
      this.connections.add(socket)
      socket.once('close', () => this.connections.delete(socket))
      socket.on('error', () => {})
      let buffer = '', admitted = false
      socket.setEncoding('utf8')
      socket.on('data', chunk => {
        if (admitted) return
        buffer += chunk
        if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) { socket.destroy(); return }
        if (!buffer.includes('\n')) return
        admitted = true
        Promise.resolve().then(() => this.request(JSON.parse(buffer.split('\n', 1)[0])))
          .then(result => { if (!socket.destroyed) socket.end(JSON.stringify({ result }) + '\n') })
          .catch(error => { if (!socket.destroyed) socket.end(JSON.stringify({ error: String(error) }) + '\n') })
      })
    })
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.socket, resolve)
    })
    fs.chmodSync(this.socket, 0o600)
    for (const job of this.jobs.values()) if (!terminal.has(job.status)) {
      this.finish(job, { status: 'interrupted', error: 'The owning Web Host stopped before it saved the job outcome.' })
    }
  }

  async close() {
    this.closed = true
    for (const job of this.jobs.values()) if (!terminal.has(job.status)) {
      this.finish(job, { status: 'interrupted', error: 'The handoff plugin stopped.' })
    }
    await Promise.allSettled([...this.handles.values()].map(handle => handle.dispose()))
    for (const socket of this.connections) socket.destroy()
    if (this.server) await new Promise(resolve => this.server.close(resolve))
  }
}

export const inject = ['agents', 'agentPresets', 'sessionController', 'sessionQuery', 'agentDefaultModel', 'sessions', 'llm']

export async function apply(ctx) {
  const host = new HandoffHost(ctx)
  await host.listen()
  ctx.effect(() => () => host.close())
}
