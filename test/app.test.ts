// The real browser and server against the mock sites, with fake models.
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import type { Browser } from 'playwright'
import { FINAL, HELD_OUT, TASKS, type GateTask, type SiteLog } from '../experiment/sites.js'
import { runAgent } from '../src/agent.js'
import { launch, openSurface } from '../src/browser.js'
import type { Decide } from '../src/models.js'
import { startFakeModels } from './fake-models.js'

let browser: Browser, models: Server, app: Server
const sites: Server[] = []

before(async () => {
  const fake = await startFakeModels()
  models = fake.server
  Object.assign(process.env, { ANTHROPIC_BASE_URL: fake.url, ANTHROPIC_API_KEY: 'test', DECISION_BASE_URL: `${fake.url}/decision`, DECISION_MODEL: 'fake', HEADLESS: '1' })
  browser = await launch(true)
  app = await (await import('../src/server.js')).start(0)
})
after(async () => {
  await browser.close()
  models.close()
  app.close()
  app.closeAllConnections()
  for (const site of sites) site.close()
})

async function serve(task: GateTask): Promise<string> {
  const log: SiteLog = { visits: [], served: new Map() }
  const server = createServer((req, res) => {
    const page = task.page(req.url ?? '/', log)
    if (page?.location) { res.writeHead(page.status ?? 302, { location: page.location }); res.end(); return }
    res.writeHead(page?.status ?? (page ? 200 : 404), { 'content-type': 'text/html; charset=utf-8' })
    res.end(page?.html ?? 'not found')
  })
  sites.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
const named = (id: string) => [...TASKS, ...HELD_OUT, ...FINAL].find(task => task.id === id)!

test('the browser reads numbered controls and a press moves the page', async () => {
  const task = named('look-alike')
  const context = await browser.newContext()
  const surface = await openSurface(context, `${await serve(task)}/`)
  const page = await surface.read()
  const target = page.controls.find(control => control.name === '2026년 3월 회의록')!
  assert.equal(target.kind, 'link')
  assert.ok((await surface.act('press', target.id)).ok)
  assert.equal(new URL((await surface.read()).url).pathname, '/minutes/2026-03')
  await context.close()
})

test('a control covered by a dialog fails as a move, not as a crash', async () => {
  const context = await browser.newContext()
  const surface = await openSurface(context, `${await serve(named('dialog-in-the-way'))}/settings`)
  const page = await surface.read()
  assert.ok(page.dialog?.includes('새 기능 안내'))
  const tab = page.controls.find(control => control.name === '알림')!
  const move = await surface.act('press', tab.id)
  assert.equal(move.ok, false)
  assert.ok(move.error)
  await context.close()
})

test('a filled public GET search can be submitted with Enter, but a POST form cannot', async () => {
  const task = {
    ...named('look-alike'),
    page: (path: string) => ({
      html: path.startsWith('/results') ? '<h1>Results</h1>' :
        '<form action="/results"><input type="search" name="q" aria-label="Search"></form>' +
        '<form action="/change" method="post"><input type="search" name="q" aria-label="Other search"></form>',
    }),
  }
  const context = await browser.newContext()
  try {
    const surface = await openSurface(context, await serve(task))
    const [search, post] = (await surface.read()).controls
    assert.ok((await surface.act('type', search!.id, 'table')).ok)
    assert.ok((await surface.act('type', post!.id, 'table')).ok)
    assert.equal((await surface.act('search', post!.id, 'table')).ok, false)
    assert.equal((await surface.act('search', search!.id, 'other')).ok, false)
    assert.ok((await surface.act('search', search!.id, 'table')).ok)
    assert.match((await surface.read()).url, /\/results\?q=table$/)
  } finally {
    await context.close()
  }
})

test('late results, typing and the agent run together on a real page', async () => {
  const task = named('late-results')
  const context = await browser.newContext()
  const surface = await openSurface(context, `${await serve(task)}${task.start}`)
  const start = await surface.read()
  const field = start.controls.find(control => control.kind === 'field')!
  const script: string[] = [`type #${field.id}`, 'done']
  const decide: Decide = async () => ({ choice: script.shift()!, probabilities: { x: 1 }, usage: { input: 0, output: 0 }, ms: 0 })
  const run = await runAgent({ goal: task.goal, text: task.text!, surface, small: null, llm: decide, policy: { kind: 'llm' } })
  assert.equal(run.status, 'done')
  assert.equal(run.steps[0]!.moved, true)
  await context.close()
})

async function post(messages: string[], origin?: string): Promise<{ status: number; events: any[] }> {
  const { port } = app.address() as AddressInfo
  const response = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify({ messages }) })
  const text = await response.text()
  return { status: response.status, events: text.trim() ? text.trim().split('\n').map(line => JSON.parse(line)) : [] }
}

test('chat: a request runs through the agent and streams steps and a result', async () => {
  const url = await serve(named('look-alike'))
  const { status, events } = await post([`${url}/ 에서 2026년 3월 회의록 확정본을 열어.`])
  assert.equal(status, 200)
  assert.deepEqual([events[0].type, events.at(-1).type], ['start', 'done'])
  assert.ok(events.some(event => event.type === 'step'))
  const done = events.at(-1)
  assert.equal(done.status, 'done')
  assert.equal(done.smallCalls > 0, true)
  assert.ok(done.answer)
})

test('chat: without an address the app asks instead of running', async () => {
  const { events } = await post(['회의록 찾아줘'])
  assert.deepEqual(events.map(event => event.type), ['ask'])
})

test('chat: leaving mid-run frees the app for the next request', async () => {
  const { port } = app.address() as AddressInfo
  const url = await serve(named('look-alike'))
  const stop = new AbortController()
  const leaving = fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [`${url}/ 에서 회의록을 열어.`] }), signal: stop.signal })
  const response = await leaving
  stop.abort()
  await response.text().catch(() => '')
  await new Promise(resolve => setTimeout(resolve, 500))
  assert.equal((await post(['회의록 찾아줘'])).status, 200)
})

test('chat: other origins and malformed bodies are refused', async () => {
  assert.equal((await post(['x'], 'https://evil.example')).status, 403)
  assert.equal((await post([])).status, 400)
  const { port } = app.address() as AddressInfo
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 404)
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200)
})

test('workspace supports keyboard submission and compact dark layout', async () => {
  const task = named('look-alike')
  const site = await serve(task)
  const { port } = app.address() as AddressInfo
  const page = await browser.newPage({ viewport: { width: 320, height: 760 }, colorScheme: 'dark' })
  try {
    await page.goto(`http://127.0.0.1:${port}/`)
    const input = page.getByRole('textbox', { name: '브라우저 작업 요청' })
    await page.getByRole('button', { name: /Fetch API/ }).click()
    assert.match(await input.inputValue(), /developer.mozilla.org/)
    await input.fill(`${site}/ 에서 ${task.goal}`)
    await input.press('Enter')
    await page.getByText('에이전트 완료 판단', { exact: true }).waitFor()
    assert.match(await page.getByRole('link', { name: '페이지 열기' }).getAttribute('href') ?? '', /\/minutes\//)
    assert.match(await page.locator('#small-count').textContent() ?? '', /[1-9]회/)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  } finally {
    await page.close()
  }
})
