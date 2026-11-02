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
    get() { return undefined },
    agents: {
      async create(request) {
        creates++
        let settle
        const idle = new Promise(resolve => { settle = resolve })
        const session = { id: request.sessionId, seq: 0, append() { this.seq++ } }
        const emit = event => { session.seq++; events.emit('session/event', session, event) }
        const agent = { id: session.id, session, status: 'idle',
          async whenIdle() { await idle },
          cancel() { emit({ type: 'turn/end', data: { reason: { kind: 'aborted' } } }); agent.status = 'idle'; settle() },
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
      async rename() {},
      async selectModel() { throw new Error('Do not change the global model default.') },
      async prompt(request) {
        const agent = agents.get(request.sessionId); agent.status = 'running'
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
