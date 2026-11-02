import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { HandoffHost, parseReport } from '../index.js'

function fixture(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-host-'))
  const workspace = path.join(home, 'workspace'); fs.mkdirSync(workspace)
  const events = new EventEmitter(), agents = new Map(), configurations = []
  let creates = 0
  const ctx = {
    on(name, listener) { events.on(name, listener); return () => events.off(name, listener) },
    llm: { async resolveCallConfig(config) { configurations.push(config); return config } },
    agentPresets: { async mount(_, preset) { assert.equal(preset, 'standard') } },
    sessions: { async flush() {} },
    sessionProjections: { stateOf(session) { return { pending: session.selection, lastUsed: session.selection } } },
    sessionQuery: { async readTitle(id) { return { title: agents.get(id)?.title ?? 'Stored title' } } },
    get() { return undefined },
    agents: {
      get(id) { return agents.get(id) },
      async create(request) {
        creates++
        let settle
        let idle = Promise.resolve()
        const session = { id: request.sessionId, header: { cwd: request.meta.cwd }, seq: 0,
          append(type, data) { this.seq++; if (type === 'model/selection') this.selection = data },
          requestHeader() { return { config: this.selection } } }
        const emit = event => { session.seq++; events.emit('session/event', session, event) }
        const agent = { id: session.id, session, status: 'idle',
          begin() { idle = new Promise(resolve => { settle = resolve }); agent.status = 'running' },
          async whenIdle() { await idle },
          async runMaintenance(task) { if (agent.status !== 'idle') throw new Error('busy'); return task() },
          cancel() { emit({ type: 'turn/end', data: { reason: { kind: 'aborted' } } }); agent.status = 'idle'; settle?.() },
          finish() {
            emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text',
              text: JSON.stringify({ status: 'completed', summary: 'done', tests: [] }) }] } } })
            emit({ type: 'turn/end', data: { reason: { kind: options.reason ?? 'completed' } } })
            agent.status = 'idle'; settle()
          } }
        await request.setup({}, agent)
        agents.set(session.id, agent)
        return { agent, async dispose() { agent.cancel(); agents.delete(session.id) } }
      },
    },
    sessionController: {
      async rename(request) { agents.get(request.sessionId).title = request.title },
      async list() { return { items: [...agents.values()].map(agent => ({ sessionId: agent.id,
        cwd: agent.session.header.cwd, running: agent.status === 'running', agentAvailable: true,
        updatedAt: Date.now(), projections: { values: { title: { title: agent.title },
          modelSelection: { next: agent.session.selection } } } })) } },
      async resolveAgent(id) { return { agent: agents.get(id) } },
      async selectModel() { throw new Error('Do not change the global model default.') },
      async prompt(request) {
        const agent = agents.get(request.sessionId); agent.begin()
        events.emit('session/event', agent.session, { type: 'turn/start', data: {} })
        if (!options.hang) setTimeout(() => agent.finish(), 20)
      },
    },
  }
  const host = new HandoffHost(ctx, { home })
  t.after(async () => { await host.close(); fs.rmSync(home, { recursive: true, force: true }) })
  const request = { id: randomUUID(), cwd: workspace, model: 'auto/deepseek-v4.1-flash',
    effort: 'low', prompt: 'Perform the test task.', timeout_seconds: 5 }
  return { host, request, agents, configurations, home, ctx, creates: () => creates }
}

test('a report after prose or a fence succeeds, but incomplete reports do not', () => {
  assert.equal(parseReport('Verification complete.\n\n{"status":"completed","tests":[]}').status, 'completed')
  assert.equal(parseReport('```json\n{"status":"blocked"}\n```').status, 'blocked')
  assert.equal(parseReport('Text\n{"status":"completed"'), undefined)
  assert.equal(parseReport('{"status":"completed"} additional prose'), undefined)
})

test('creates an ordinary live session with a local model and retains it after completion', async t => {
  const f = fixture(t)
  const receipt = await f.host.submit(f.request)
  const result = await f.host.wait(receipt.id)
  assert.equal(result.status, 'completed')
  assert.ok(f.agents.has(result.session_id))
  assert.deepEqual(f.configurations[0], { provider: 'magpie', model: f.request.model, reasoningEffort: 'low' })
  assert.equal(JSON.parse(result.text).summary, 'done')
})

test('duplicate submissions join the original task without another Agent', async t => {
  const f = fixture(t)
  const [a, b] = await Promise.all([f.host.submit(f.request), f.host.submit(f.request)])
  assert.equal(a.session_id, b.session_id)
  await f.host.wait(a.id)
  assert.equal(f.creates(), 1)
  await assert.rejects(f.host.submit({ ...f.request, prompt: 'different' }), /another request/)
})

test('a follow-up preserves the session ID and title without another Agent', async t => {
  const f = fixture(t)
  await f.host.submit(f.request)
  const first = await f.host.wait(f.request.id)
  const title = f.agents.get(first.session_id).title
  const secondRequest = { ...f.request, id: randomUUID(), session_id: first.session_id, prompt: 'Follow-up repair.' }
  await f.host.submit(secondRequest)
  const second = await f.host.wait(secondRequest.id)
  assert.equal(second.status, 'completed')
  assert.equal(second.session_id, first.session_id)
  assert.equal(second.session_mode, 'continue')
  assert.equal(f.agents.get(first.session_id).title, title)
  assert.equal(f.creates(), 1)
  const candidates = await f.host.sessions(f.request.cwd)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].can_continue, true)
  assert.equal(candidates[0].last_job_id, second.id)
})

test('busy, unrelated-workspace, and incompatible-model sessions are refused', async t => {
  const f = fixture(t)
  await f.host.submit(f.request)
  const first = await f.host.wait(f.request.id)
  const agent = f.agents.get(first.session_id)
  agent.status = 'running'
  const busy = { ...f.request, id: randomUUID(), session_id: first.session_id }
  await f.host.submit(busy)
  assert.equal((await f.host.wait(busy.id)).status, 'failed')
  agent.status = 'idle'
  // Let the failed admission release its workspace reservation.
  await new Promise(resolve => setTimeout(resolve, 0))
  const other = path.join(f.home, 'other'); fs.mkdirSync(other)
  const wrongCwd = { ...f.request, id: randomUUID(), cwd: other, session_id: first.session_id }
  await f.host.submit(wrongCwd)
  assert.equal((await f.host.wait(wrongCwd.id)).status, 'failed')
  const wrongModel = { ...f.request, id: randomUUID(), model: 'another-model', session_id: first.session_id }
  await f.host.submit(wrongModel)
  const result = await f.host.wait(wrongModel.id)
  assert.equal(result.status, 'failed')
  assert.match(result.error, /another model/)
  assert.equal(f.creates(), 1)
})

test('candidate titles can come from the native title reader without activating an Agent', async t => {
  const f = fixture(t)
  await f.host.submit(f.request)
  const first = await f.host.wait(f.request.id)
  const title = f.agents.get(first.session_id).title
  f.ctx.sessionController.list = async () => ({ items: [{ sessionId: first.session_id,
    cwd: f.request.cwd, running: false, agentAvailable: false, updatedAt: 1 }] })
  f.ctx.sessionController.resolveAgent = async () => { throw new Error('Do not activate during a list.') }
  const candidates = await f.host.sessions(f.request.cwd)
  assert.equal(candidates[0].title, title)
  assert.equal(candidates[0].live, false)
})

test('workspace collision blocks the second task', async t => {
  const f = fixture(t)
  await f.host.submit(f.request)
  const second = await f.host.submit({ ...f.request, id: randomUUID() })
  assert.equal(second.status, 'blocked')
  await f.host.wait(f.request.id)
  assert.equal(f.creates(), 1)
})

test('an aborted turn cannot pass through a model success claim', async t => {
  const f = fixture(t, { reason: 'aborted' })
  await f.host.submit(f.request)
  assert.equal((await f.host.wait(f.request.id)).status, 'failed')
})

test('timeout cancels the task without killing the Web Host', async t => {
  const f = fixture(t, { hang: true })
  await f.host.submit({ ...f.request, timeout_seconds: 1 })
  const result = await f.host.wait(f.request.id)
  assert.equal(result.status, 'failed')
  assert.match(result.error, /time limit/)
  assert.equal((await f.host.request({ command: 'probe' })).backend, 'web-host')
})

function rpc(endpoint, message) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint)
    let data = ''
    socket.on('error', reject)
    socket.on('connect', () => socket.write(JSON.stringify(message) + '\n'))
    socket.on('data', chunk => { data += chunk })
    socket.on('end', () => {
      const reply = JSON.parse(data)
      if (reply.error) reject(new Error(reply.error)); else resolve(reply.result)
    })
  })
}

test('the owner-only socket serves requests and survives client disconnection', async t => {
  const f = fixture(t)
  await f.host.listen()
  assert.equal(fs.statSync(f.host.socket).mode & 0o777, 0o600)
  const receipt = await rpc(f.host.socket, { ...f.request, command: 'submit' })
  const socket = net.createConnection(f.host.socket)
  await new Promise(resolve => socket.on('connect', resolve))
  socket.end(JSON.stringify({ command: 'wait', id: receipt.id }) + '\n')
  socket.destroy()
  const result = await rpc(f.host.socket, { command: 'wait', id: receipt.id })
  assert.equal(result.status, 'completed')
  assert.equal(f.creates(), 1)
})

test('a second host cannot overwrite live task state', async t => {
  const f = fixture(t, { hang: true })
  await f.host.listen()
  await f.host.submit(f.request)
  const second = new HandoffHost(f.ctx, { home: f.home })
  await assert.rejects(second.listen(), /Another handoff host/)
  const stored = JSON.parse(fs.readFileSync(f.host.file(f.request.id), 'utf8'))
  assert.notEqual(stored.status, 'interrupted')
})
