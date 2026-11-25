import assert from 'node:assert/strict'
import { test } from 'node:test'
import { interval } from '../experiment/report.js'
import { pageOptions, runAgent } from '../src/agent.js'
import type { Control, Surface } from '../src/browser.js'
import { httpUrl, readChoice, type Decide } from '../src/models.js'
import { escalates, features, predict, train } from '../src/risk.js'

test('the decision answer is read strictly', () => {
  const options = { done: 'd', blocked: 'b' }
  const answer = (next: object) => ({ answers: { next } })
  assert.deepEqual(readChoice(answer({ choice: 'done', confidence: 0.7, probabilities: { done: 0.7, blocked: 0.3, gone: 0.1, odd: 'x' } }), options), { choice: 'done', probabilities: { done: 0.7, blocked: 0.3 } })
  assert.deepEqual(readChoice(answer({ choice: 'done', confidence: 0.7 }), options), { choice: 'done', probabilities: { done: 0.7 } })
  assert.throws(() => readChoice(answer({ choice: 'press #9', confidence: 1 }), options))
  assert.throws(() => readChoice(answer({ choice: 'done' }), options))
  assert.throws(() => readChoice(answer({ choice: 'done', confidence: 2 }), options))
  assert.throws(() => readChoice({}, options))
})

test('features read margin and spread from the distribution', () => {
  assert.deepEqual(features({ a: 1 }, false, false), { margin: 1, entropy: 0, stalled: 0, revisit: 0 })
  const even = features({ a: 0.5, b: 0.5 }, true, true)
  assert.equal(even.margin, 0)
  assert.ok(Math.abs(even.entropy - 1) < 1e-9)
  assert.equal(even.stalled + even.revisit, 2)
})

test('training learns that close calls fail, and the policies escalate on it', () => {
  const close = { margin: 0.05, entropy: 0.9, stalled: 0, revisit: 0 }, clear = { margin: 0.9, entropy: 0.1, stalled: 0, revisit: 0 }
  const model = train([...Array(20).fill({ features: close, failed: true }), ...Array(20).fill({ features: clear, failed: false })])
  assert.ok(predict(model, close) > 0.8)
  assert.ok(predict(model, clear) < 0.2)
  assert.equal(escalates({ kind: 'risk', model, threshold: 0.5 }, close).ask, true)
  assert.equal(escalates({ kind: 'risk', model, threshold: 0.5 }, clear).ask, false)
  assert.equal(escalates({ kind: 'fixed', margin: 0.3 }, close).ask, true)
  assert.equal(escalates({ kind: 'fixed', margin: 0.3 }, clear).ask, false)
  assert.equal(escalates({ kind: 'small' }, close).ask, false)
  assert.throws(() => train([]))
})

test('the interval resamples tasks and brackets the mean', () => {
  const rows = ['a', 'b', 'c', 'd'].flatMap((task, index) => [{ task, success: index > 0 }, { task, success: index > 1 }])
  const [low, high] = interval(rows)
  assert.ok(low <= 0.625 && 0.625 <= high && low < high)
  assert.deepEqual(interval([...rows].reverse()), [low, high])
})

test('only http and https addresses are opened', () => {
  assert.equal(httpUrl('example.com/a'), 'https://example.com/a')
  assert.equal(httpUrl('http://example.com/'), 'http://example.com/')
  assert.equal(httpUrl('file:///etc/passwd'), null)
  assert.equal(httpUrl('javascript:alert(1)'), null)
  assert.equal(httpUrl(null), null)
})

const button = (id: string, name: string, extra: Partial<Control> = {}): Control => ({ id, kind: 'button', name, submits: false, posts: false, ...extra })

test('options offer fields only with text to enter, and page long lists', () => {
  const field: Control = { id: '1', kind: 'field', name: '검색', submits: false, posts: false }
  assert.ok(!('type #1' in pageOptions([field], undefined)))
  assert.ok('type #1' in pageOptions([field], '보고서'))
  const many = Array.from({ length: 300 }, (_, index) => button(String(index), `b${index}`))
  const first = pageOptions(many, undefined)
  assert.ok(Object.keys(first).length <= 200 && 'more' in first)
  assert.ok('first' in pageOptions(many, undefined, 196))
})

function surfaceOf(controls: Control[]): Surface & { moves: string[] } {
  const moves: string[] = []
  return { moves, read: async () => ({ url: `http://x/${moves.length}`, title: 't', text: `page ${moves.length}`, controls }), act: async (kind, id) => { moves.push(`${kind} ${id}`); return { ok: true } } }
}
const fixed = (choice: string, probabilities: Record<string, number> = { [choice]: 1 }): Decide => async () => ({ choice, probabilities, usage: { input: 1, output: 1 }, ms: 0 })

test('a clear pick stays with the small model; a close one goes to the LLM, which decides', async () => {
  const clear = await runAgent({ goal: 'g', surface: surfaceOf([button('1', '열기')]), small: fixed('done', { done: 0.9, blocked: 0.1 }), llm: fixed('blocked'), policy: { kind: 'fixed', margin: 0.3 } })
  assert.deepEqual([clear.status, clear.llmCalls, clear.smallCalls, clear.steps[0]!.decider], ['done', 0, 1, 'small'])
  const close = await runAgent({ goal: 'g', surface: surfaceOf([button('1', '열기')]), small: fixed('blocked', { done: 0.5, blocked: 0.5 }), llm: fixed('done'), policy: { kind: 'fixed', margin: 0.3 } })
  assert.deepEqual([close.status, close.llmCalls, close.steps[0]!.decider], ['done', 1, 'llm'])
})

test('the llm condition never calls the small model', async () => {
  let called = false
  const run = await runAgent({ goal: 'g', surface: surfaceOf([]), small: async () => { called = true; throw new Error('no') }, llm: fixed('done'), policy: { kind: 'llm' } })
  assert.deepEqual([run.status, run.llmCalls, called], ['done', 1, false])
})

test('always calls both models in order, applies the LLM decision and records both picks', async () => {
  const order: string[] = []
  const small: Decide = async () => { order.push('small'); return fixed('blocked', { done: 0.05, blocked: 0.95 })('', {}) }
  const llm: Decide = async () => { order.push('llm'); return fixed('done')('', {}) }
  const run = await runAgent({ goal: 'g', surface: surfaceOf([]), small, llm, policy: { kind: 'always' } })
  assert.deepEqual(order, ['small', 'llm'])
  assert.deepEqual([run.status, run.smallCalls, run.llmCalls], ['done', 1, 1])
  assert.deepEqual([run.steps[0]!.smallChoice, run.steps[0]!.choice], ['blocked', 'done'])
})

test('never presses what is hard to take back, whichever model picked it', async () => {
  for (const control of [button('1', '결제하기'), button('1', '다음', { submits: true, posts: true }), button('1', 'Place order')]) {
    const surface = surfaceOf([control])
    const run = await runAgent({ goal: 'g', surface, small: null, llm: fixed('press #1'), policy: { kind: 'llm' } })
    assert.equal(run.status, 'needs-person', control.name)
    assert.deepEqual(surface.moves, [])
  }
})

test('a sign-in page stops the run, and a repeated pick on an unchanged page ends it', async () => {
  const wall: Surface = { read: async () => ({ url: 'http://x/', title: 't', text: '', wall: 'login', controls: [] }), act: async () => ({ ok: true }) }
  assert.equal((await runAgent({ goal: 'g', surface: wall, small: null, llm: fixed('done'), policy: { kind: 'llm' } })).status, 'needs-person')
  const still: Surface & { moves: number } = { moves: 0, read: async () => ({ url: 'http://x/', title: 't', text: 'same', controls: [button('1', '열기')] }), act: async () => { still.moves++; return { ok: true } } }
  const run = await runAgent({ goal: 'g', surface: still, small: null, llm: fixed('press #1'), policy: { kind: 'llm' } })
  assert.deepEqual([run.status, still.moves], ['blocked', 1])
})

test('an error or a stop ends the run with what was done so far', async () => {
  const failed = await runAgent({ goal: 'g', surface: surfaceOf([]), small: null, llm: async () => { throw new Error('boom') }, policy: { kind: 'llm' } })
  assert.deepEqual([failed.status, failed.note], ['error', 'boom'])
  const stop = new AbortController()
  stop.abort()
  assert.equal((await runAgent({ goal: 'g', surface: surfaceOf([]), small: null, llm: fixed('done'), policy: { kind: 'llm' }, signal: stop.signal })).status, 'stopped')
})
