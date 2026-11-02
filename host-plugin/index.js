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
    this.instance = randomUUID()
    this.home = options.home ?? process.env.DSH_HANDOFF_HOME ?? path.join(os.homedir(), '.local/state/dsh-handoff')
    this.socket = options.socket ?? process.env.DSH_HANDOFF_HOST_SOCKET ?? path.join(this.home, 'host.sock')
    this.jobs = new Map()
    this.workspaces = new Map()
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

  async sessions(cwd, limit = 20) {
    if (!path.isAbsolute(cwd ?? '')) throw new Error('The workspace must be an absolute path.')
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('The session limit must be between 1 and 100.')
    const workspace = fs.realpathSync(cwd)
    const list = await this.ctx.sessionController.list({}, new AbortController().signal)
    const jobs = [...this.jobs.values()].sort((a, b) => b.created_at.localeCompare(a.created_at))
    return Promise.all(list.items.filter(row => row.cwd && row.origin !== 'subagent' &&
      path.resolve(row.cwd) === workspace).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit).map(async row => {
      const previous = jobs.find(job => job.session_id === row.sessionId)
      const values = row.projections?.values ?? {}
      const selection = values.modelSelection?.next ?? values.modelSelection?.lastUsed
      const title = values.title?.title ?? (await this.ctx.sessionQuery.readTitle(row.sessionId))?.title ?? ''
      return { session_id: row.sessionId, cwd: workspace, title,
        running: row.running, blank: row.blank, live: row.agentAvailable, updated_at: row.updatedAt,
        can_continue: !row.running && row.formatStatus !== 'migration-required',
        model: selection?.model ?? previous?.model,
        effort: selection?.reasoningEffort ?? previous?.effort,
        last_job_id: previous?.id, last_status: previous?.status,
        summary: String(previous?.report?.summary ?? '').slice(0, 800) }
    }))
  }

  async continuation(job, selected) {
    const list = await this.ctx.sessionController.list({}, new AbortController().signal)
    const row = list.items.find(value => value.sessionId === job.session_id && value.origin !== 'subagent' &&
      value.cwd && path.resolve(value.cwd) === job.cwd)
    if (!row) throw new Error('The continuation session is not a visible ordinary session in this workspace.')
    if (row.running || row.formatStatus === 'migration-required') throw new Error('The continuation session is busy or requires migration.')
    const resolved = await this.ctx.sessionController.resolveAgent(job.session_id)
    if (resolved.error) throw resolved.error
    const agent = resolved.agent
    if (fs.realpathSync(agent.session.header.cwd) !== job.cwd) throw new Error('The continuation workspace changed.')
    if (agent.status !== 'idle') throw new Error('The continuation session is busy.')
    if (agent.inbox?.nextTurn?.length || agent.inbox?.nextStep?.length) throw new Error('The continuation session has pending input.')
    const state = this.ctx.sessionProjections.stateOf(agent.session, 'modelSelection')
    const selection = state?.pending ?? state?.lastUsed ?? agent.session.requestHeader()?.config
    if (selection?.provider !== selected.provider || selection?.model !== selected.model ||
        selection?.reasoningEffort !== selected.reasoningEffort) {
      throw new Error('The session uses another model or reasoning effort. Start a new session.')
    }
    return agent
  }

  async sessionInfo(id, cwd) {
    const workspace = fs.realpathSync(cwd)
    const list = await this.ctx.sessionController.list({}, new AbortController().signal)
    const row = list.items.find(value => value.sessionId === id && value.origin !== 'subagent' &&
      value.cwd && path.resolve(value.cwd) === workspace)
    if (!row) throw new Error('The session is not visible in this workspace.')
    const inspection = await this.ctx.sessionController.inspect(id)
    const messages = inspection.events.filter(event => ['user/message', 'assistant/message'].includes(event.type))
      .slice(-3).map(event => ({ role: event.type.split('/')[0], text: event.data.message.content
        .filter(block => block.type === 'text').map(block => block.text).join('').slice(-1600) }))
    return { session_id: id, cwd: workspace, running: row.running,
      title: row.projections?.values.title?.title ?? inspection.events.findLast(event => event.type === 'session/title')?.data.title ?? '',
      recent_messages: messages }
  }

  async submit(request) {
    if (this.closed) throw new Error('The handoff host is closing.')
    if (!uuid.test(request.id ?? '')) throw new Error('Invalid job ID.')
    if (typeof request.prompt !== 'string' || !request.prompt.trim()) throw new Error('The prompt is empty.')
    if (request.prompt.length > 1024 * 1024) throw new Error('The prompt exceeds one MiB.')
    if (!Number.isInteger(request.timeout_seconds) || request.timeout_seconds < 1) throw new Error('Invalid task time limit.')
    if (request.session_id !== undefined && (typeof request.session_id !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,160}$/.test(request.session_id))) throw new Error('Invalid continuation session ID.')
    if (!path.isAbsolute(request.cwd ?? '')) throw new Error('The workspace must be an absolute path.')
    const cwd = fs.realpathSync(request.cwd)
    if (!fs.statSync(cwd).isDirectory()) throw new Error('The workspace is not a directory.')
    const hash = createHash('sha256').update(JSON.stringify({ cwd, model: request.model,
      effort: request.effort, prompt: request.prompt, timeout: request.timeout_seconds,
      ...(request.session_id ? { continueSession: request.session_id } : {}) })).digest('hex')
    const previous = this.jobs.get(request.id)
    if (previous) {
      if (previous.request_hash !== hash) throw new Error('The job ID already names another request.')
      return this.info(previous)
    }
    // Reserve before the first await. A second client cannot create another Agent.
    const job = { id: request.id, session_id: request.session_id ?? `session-${request.id}`, cwd,
      session_mode: request.session_id ? 'continue' : 'new',
      model: request.model, effort: request.effort, request_hash: hash,
      status: 'starting', created_at: now() }
    fs.mkdirSync(path.dirname(this.file(job.id)), { recursive: true, mode: 0o700 })
    this.persist(job)
    if (this.workspaces.has(cwd)) {
      this.finish(job, { status: 'blocked', error: 'Another Web Host handoff owns this workspace.' })
      return this.info(job)
    }
    this.workspaces.set(cwd, job.id)
    this.run(job, request).catch(error => {
      this.finish(job, { status: 'failed', error: String(error) })
    }).finally(() => { if (this.workspaces.get(cwd) === job.id) this.workspaces.delete(cwd) })
    return this.info(job)
  }

  async run(job, request) {
    const selection = await this.ctx.llm.resolveCallConfig({
      provider: 'magpie', model: request.model, reasoningEffort: request.effort })
    const selected = { provider: selection.provider, model: selection.model,
      reasoningEffort: selection.reasoningEffort }
    let agent
    if (job.session_mode === 'continue') {
      agent = await this.continuation(job, selected)
    } else {
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
      agent = handle.agent
    }
    const log = path.join(path.dirname(this.file(job.id)), 'events.ndjson')
    let text = '', reason, ownedTurn, timer
    const stop = this.ctx.on('session/event', (session, event) => {
      if (session.id !== job.session_id) return
      fs.appendFileSync(log, JSON.stringify(event) + '\n', { mode: 0o600 })
      if (event.type === 'turn/start' && ownedTurn === undefined) ownedTurn = event.data.turn
      if (event.type === 'assistant/message' && event.data.turn === ownedTurn) text = event.data.message.content
        .filter(block => block.type === 'text').map(block => block.text).join('') || text
      if (event.type === 'turn/end' && event.data.turn === ownedTurn) {
        reason = event.data.reason
        clearTimeout(timer)
      }
    }, { global: true })
    let timedOut = false
    timer = setTimeout(() => {
      timedOut = true
      agent.cancel({ kind: 'hook', reason: 'The handoff task exceeded its time limit.' })
    }, request.timeout_seconds * 1000)
    try {
      job.status = 'running'; job.started_at = now(); job.events_path = log
      this.persist(job)
      if (job.session_mode !== 'continue') await this.ctx.sessionController.rename({ sessionId: job.session_id,
        title: `Handoff ${job.id.slice(0, 8)}` })
      const admit = () => this.ctx.sessionController.prompt({ sessionId: job.session_id,
        requestId: randomUUID(), mode: 'queue',
        content: [{ type: 'text', text: request.prompt }] }, new AbortController().signal)
      if (job.session_mode === 'continue') await agent.runMaintenance(admit)
      else await admit()
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
    if (this.workspaces.get(job.cwd) === job.id) this.workspaces.delete(job.cwd)
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
    if (message.command === 'probe') return { protocol: 1, build: 3, instance: this.instance, pid: process.pid, backend: 'web-host' }
    if (message.command === 'sessions') return this.sessions(message.cwd, message.limit ?? 20)
    if (message.command === 'session-info') return this.sessionInfo(message.session_id, message.cwd)
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
      if (job.session_mode === 'continue') this.ctx.agents.get(job.session_id)?.cancel({ kind: 'hook', reason: 'The handoff plugin stopped.' })
      this.finish(job, { status: 'interrupted', error: 'The handoff plugin stopped.' })
    }
    await Promise.allSettled([...this.handles.values()].map(handle => handle.dispose()))
    for (const socket of this.connections) socket.destroy()
    if (this.server) await new Promise(resolve => this.server.close(resolve))
  }
}

export const inject = ['agents', 'agentPresets', 'sessionController', 'sessionQuery', 'sessionProjections', 'agentDefaultModel', 'sessions', 'llm']

export async function apply(ctx, config = {}) {
  const host = new HandoffHost(ctx, { home: config.home, socket: config.socket })
  await host.listen()
  ctx.effect(() => () => host.close())
}
