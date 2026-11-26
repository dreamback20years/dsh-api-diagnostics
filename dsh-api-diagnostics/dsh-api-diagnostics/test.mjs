import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createErrorLog, registerDiagnostics } from './index.js'

async function run(chunk, signal, logger, writer) {
  const lines = []
  const entries = []
  let listener
  registerDiagnostics({ on(event, fn) { assert.equal(event, 'llm/stream'); listener = fn }, logger: { warn: logger ?? (line => lines.push(line)) } }, writer ?? (entry => entries.push(entry)))
  const output = []
  for await (const value of listener({ provider: 'demo', model: 'test-model', signal }, async function* () { yield chunk })) output.push(value)
  return { chunk: output[0], lines, entries }
}

test('creates the file only on failure, writes structured detail and rotates', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'dsh-api-test-')), 'logs', 'errors.jsonl')
  const write = createErrorLog(file, 2000)
  await run({ type: 'finish', reason: { kind: 'stop' } }, undefined, undefined, write)
  assert.equal(existsSync(file), false)
  const detail = 'Upstream timeout: ' + 'connection timed out. '.repeat(50)
  await run(finish({ code: 'TIMEOUT', status: 504, message: detail }), undefined, undefined, write)
  const first = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(first.reason, detail.trim())
  assert.equal(first.httpStatus, 504)
  assert.ok(!Number.isNaN(Date.parse(first.timestamp)))
  await run(finish({ code: 'TIMEOUT', status: 504, message: detail }), undefined, undefined, write)
  assert.deepEqual(JSON.parse(readFileSync(`${file}.1`, 'utf8')), first)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).code, 'TIMEOUT')
})

test('file IO failure falls back to the Host logger without changing the failure', async () => {
  const output = await run(finish({ code: 'NETWORK', message: 'offline' }), undefined, undefined, () => { throw Object.assign(new Error('private path'), { code: 'EACCES' }) })
  assert.match(output.lines[0], /EACCES/)
  assert.doesNotMatch(output.lines[0], /private path/)
  assert.match(output.chunk.reason.failure.message, /offline/)
})

const finish = failure => Object.freeze({ type: 'finish', reason: Object.freeze({ kind: 'error', failure: Object.freeze(failure) }) })

test('enriches native error text and logs the same detail without changing retry fields', async () => {
  const input = finish({ code: 'RATE_LIMIT', status: 429, message: 'Capacity exceeded', providerRetryAfterMs: 2501, requestId: 'req-test-1' })
  const output = await run(input)
  const { message, ...metadata } = output.chunk.reason.failure
  assert.deepEqual(metadata, { code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 2501, requestId: 'req-test-1' })
  for (const field of ['Capacity exceeded', 'demo', 'test-model', 'HTTP 429', 'req-test-1', 'Retry-After: 3s']) assert.ok(message.includes(field))
  assert.deepEqual(output.lines, [`[api-diagnostics] ${message}`])
  assert.equal(input.reason.failure.message, 'Capacity exceeded')
})

test('never copies upstream authentication text, even when code is unknown', async () => {
  for (const failure of [{ code: 'AUTH' }, { code: 'UNKNOWN', status: 401 }, { code: 'FORBIDDEN', status: 403 }]) {
    const output = await run(finish({ ...failure, message: 'arbitrary sensitive content' }))
    assert.doesNotMatch(output.chunk.reason.failure.message, /sensitive content/)
    assert.doesNotMatch(output.lines.join(''), /sensitive content/)
  }
})

test('redacts common credentials and URLs and keeps the diagnostic bounded', async () => {
  const output = await run(finish({ code: 'UNKNOWN', message: 'Bearer abc123; "api_key": "test-secret"; https://user:pass@host/?key=query-secret; sk-token123; ' + 'network issue '.repeat(200) }))
  for (const text of [output.chunk.reason.failure.message, ...output.lines]) {
    assert.doesNotMatch(text, /abc123|test-secret|query-secret|token123|user:pass/)
    assert.ok(text.length < 900)
  }
})

test('passes through success and cancellation; a logger failure cannot break the stream', async () => {
  const controller = new AbortController()
  controller.abort()
  for (const [input, signal] of [[{ type: 'finish', reason: { kind: 'stop' } }], [{ type: 'finish', reason: { kind: 'aborted' } }], [finish({ code: 'NETWORK', message: 'offline' }), controller.signal]]) {
    const output = await run(input, signal)
    assert.equal(output.chunk, input)
    assert.equal(output.lines.length, 0)
  }
  const output = await run(finish({ code: 'NETWORK', message: 'offline' }), undefined, () => { throw new Error('logger unavailable') })
  assert.match(output.chunk.reason.failure.message, /offline/)
})
