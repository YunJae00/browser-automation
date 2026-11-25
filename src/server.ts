import { createReadStream } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import type { Browser } from 'playwright'
import { runAgent, type Step } from './agent.js'
import { launch, openSurface } from './browser.js'
import { httpUrl, llmModel, parseRequest, smallModel, summarize, type Decide } from './models.js'
import { appThreshold, loadRiskModel, type Policy } from './risk.js'

const PAGE = fileURLToPath(new URL('../public/index.html', import.meta.url))
const BODY_LIMIT = 64_000
const FIXED_MARGIN = 0.3
interface Demo { prompt: string; simulated: boolean; grade(url: string): boolean | undefined }

export function appPolicy(small: Decide | null): { policy: Policy; mode: string } {
  if (!small) return { policy: { kind: 'llm' }, mode: '소형 모델이 연결되지 않아 모든 단계를 LLM이 판단합니다' }
  const model = process.env['APP_POLICY'] === 'risk' ? loadRiskModel() : null
  if (!model) {
    const margin = appThreshold('fixed')
    return { policy: { kind: 'fixed', margin }, mode: `선택지 1·2위의 확률 격차가 ${margin.toFixed(3)} 미만이면 LLM에게 다시 묻습니다` }
  }
  const threshold = appThreshold('risk', process.env['RISK_THRESHOLD'])
  return { policy: { kind: 'risk', model, threshold }, mode: `위험 점수가 ${threshold.toFixed(3)} 이상이면 LLM에게 다시 묻습니다` }
}

const stepEvent = (step: Step) => ({
  type: 'step', number: step.step + 1, decider: step.decider, risk: step.risk,
  what: step.what ?? (step.choice === 'done' ? '완료 판단' : '더 진행할 수 없다고 판단'),
  ...(step.moved === false ? { failed: true } : {}),
})

function friendly(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/api.?key|auth/i.test(message)) return 'LLM에 연결하지 못했습니다. .env에 ANTHROPIC_API_KEY를 설정한 뒤 다시 실행해 주세요.'
  if (/ERR_|net::|Timeout/.test(message)) return `페이지를 열지 못했습니다. 주소를 확인해 주세요. (${message.split('\n', 1)[0]})`
  return `문제가 생겼습니다: ${message}`
}

async function readMessages(req: IncomingMessage): Promise<string[] | null> {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > BODY_LIMIT) return null
  }
  try {
    const { messages } = JSON.parse(raw) as { messages?: unknown }
    return Array.isArray(messages) && messages.length > 0 && messages.length <= 20 && messages.every(one => typeof one === 'string' && one.trim() && one.length <= 2_000) ? messages as string[] : null
  } catch { return null }
}

export function createApp(demo?: Demo): Server {
  let browser: Browser | null = null
  let running = false

  async function chat(messages: string[], res: ServerResponse, signal: AbortSignal): Promise<void> {
    const send = (event: object) => { if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`) }
    try {
      const request = await parseRequest(messages, signal)
      const url = httpUrl(request.url)
      if (!url || request.question) { send({ type: 'ask', text: request.question ?? '어느 사이트에서 할까요? 주소를 알려 주세요.' }); return }
      const small = smallModel()
      const { policy, mode } = demo?.simulated
        ? { policy: { kind: 'fixed', margin: FIXED_MARGIN } as const, mode: '시연에서는 확률 격차가 작은 단계에서 모의 LLM에 묻습니다' }
        : appPolicy(small)
      send({ type: 'start', goal: request.goal, mode })
      // The window of the last run stays open so the page can be looked at; the next run replaces it.
      await browser?.close()
      browser = await launch(process.env['HEADLESS'] === '1')
      const surface = await openSurface(await browser.newContext({ acceptDownloads: false }), url)
      const run = await runAgent({
        goal: request.goal, ...(request.text ? { text: request.text } : {}), surface, small, llm: llmModel, policy, signal,
        onStep: (step, { smallCalls, llmCalls }) => send({ ...stepEvent(step), smallCalls, llmCalls }),
      })
      const answer = run.status === 'done'
        ? await summarize(request.goal, run.title, run.text, signal).catch(() => `"${run.title}" 페이지를 열었습니다.`)
        : run.note ?? '끝내지 못했습니다.'
      send({ type: 'done', status: run.status, answer, url: httpUrl(run.url), verified: demo?.grade(run.url), llmCalls: run.llmCalls, smallCalls: run.smallCalls, seconds: run.ms / 1000 })
    } catch (error) {
      if (!signal.aborted) send({ type: 'error', text: friendly(error) })
    }
  }

  const server = createServer(async (req, res) => {
    const address = server.address()
    const own = typeof address === 'object' && address ? [`127.0.0.1:${address.port}`, `localhost:${address.port}`] : []
    // Only this page may drive the browser and spend tokens, not a website open in another tab.
    if (!own.includes(req.headers.host ?? '') || (req.headers.origin && !own.includes(req.headers.origin.replace(/^https?:\/\//, '')))) {
      res.writeHead(403).end()
      return
    }
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      createReadStream(PAGE).pipe(res)
      return
    }
    if (req.method === 'GET' && req.url === '/api/config') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ demoPrompt: demo?.prompt, simulated: demo?.simulated }))
      return
    }
    if (req.method !== 'POST' || req.url !== '/api/chat' || req.headers['content-type'] !== 'application/json') {
      res.writeHead(404).end()
      return
    }
    const messages = await readMessages(req)
    if (!messages) { res.writeHead(400).end(); return }
    if (running) { res.writeHead(409).end(); return }
    running = true
    const stop = new AbortController()
    res.on('close', () => stop.abort())
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' })
    try {
      await chat(messages, res, stop.signal)
    } finally {
      running = false
      res.end()
    }
  })
  server.on('close', () => { void browser?.close() })
  return server
}

export function start(port = Number(process.env['PORT'] ?? 3000), demo?: Demo): Promise<Server> {
  const server = createApp(demo)
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await start()
  const address = server.address()
  console.log(`http://localhost:${typeof address === 'object' && address ? address.port : ''}`)
  const quit = () => { server.close(); server.closeAllConnections(); process.exit(0) }
  process.on('SIGINT', quit)
  process.on('SIGTERM', quit)
}
