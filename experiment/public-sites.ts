// Public sites pilot using the app's request parser and browser loop.
import { mkdir, writeFile } from 'node:fs/promises'
import { runAgent } from '../src/agent.js'
import { launch, openSurface } from '../src/browser.js'
import { llmModel, parseRequest, smallModel } from '../src/models.js'
import { appThreshold } from '../src/risk.js'

const documentation = [
  {
    id: 'mdn', name: 'MDN Using Fetch',
    start: 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API',
    target: '/en-US/docs/Web/API/Fetch_API/Using_Fetch',
    instruction: 'Using the Fetch API 문서를 찾아서 열어줘.',
  },
  {
    id: 'python', name: 'Python json',
    start: 'https://docs.python.org/3.14/library/',
    target: '/3.14/library/json.html',
    instruction: '표준 라이브러리에서 json 모듈의 레퍼런스 문서를 찾아서 열어줘.',
  },
  {
    id: 'playwright', name: 'Playwright Auto-waiting',
    start: 'https://playwright.dev/docs/locators',
    target: '/docs/actionability',
    instruction: 'Auto-waiting 문서를 찾아서 열어줘.',
  },
]

const everyday = [
  {
    id: 'ikea', name: 'IKEA 상품 검색',
    start: 'https://www.ikea.com/kr/ko/',
    target: '/kr/ko/p/lack-side-table-white-10449909/',
    instruction: '검색창에 LACK을 검색해서 흰색 라크 보조테이블 55×55cm 상품 상세를 열어줘. 조회만 해줘.',
  },
  {
    id: 'aladin', name: '알라딘 책 검색',
    start: 'https://www.aladin.co.kr/home/welcome.aspx',
    target: '/shop/wproduct.aspx?ItemId=269428498',
    instruction: '검색창에서 불편한 편의점을 검색해서 김호연의 2021년 일반 종이책 1권 상품 상세를 열어줘. 조회만 해줘.',
  },
  {
    id: 'seoul', name: '서울시 단체 관람 안내',
    start: 'https://yeyak.seoul.go.kr/web/main.do',
    target: '/web/reservation/selectReservView.do?rsv_svc_id=S220426092440232101',
    instruction: '서울역사박물관 본관 무료 단체 관람의 안내 상세를 찾아 열어줘. 예약은 하지 말고 안내만 확인해줘.',
  },
]

const isEveryday = process.argv.includes('--everyday')
const retry = isEveryday && process.argv.includes('--retry')
const only = process.argv.find(option => option.startsWith('--only='))?.slice('--only='.length)
const llmOnly = process.argv.includes('--llm-only')
const variant = {
  id: 'ikea-variant', name: 'IKEA 상품 색상 선택',
  start: 'https://www.ikea.com/kr/ko/p/lack-side-table-black-brown-80352927/',
  target: '/kr/ko/p/lack-side-table-white-10449909/',
  instruction: '지금 보고 있는 55×55cm 라크 보조테이블의 색상 옵션에서 흰색을 선택해 상세 화면을 열어줘. 조회만 해줘.',
}
const tasks = (isEveryday ? only === variant.id ? [variant] : everyday : documentation).filter(task => !only || task.id === only)
if (!tasks.length) throw new Error('No matching task.')
const suite = retry ? 'everyday-site-retry' : isEveryday ? 'everyday-site-pilot' : 'public-site-pilot'
const outputName = [suite, only, llmOnly ? 'llm' : ''].filter(Boolean).join('-')
const small = smallModel()
if (!small && !llmOnly) throw new Error('Set DECISION_BASE_URL and DECISION_MODEL for the public-site pilot.')
const threshold = appThreshold('fixed')
const out = new URL('../deliverables/', import.meta.url)
const evidence = new URL(`../runs/${outputName}/`, import.meta.url)
await mkdir(evidence, { recursive: true })
const browser = await launch(true)
try {
  const results = []
  for (const task of tasks) {
    const origin = new URL(task.start).origin
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: false, serviceWorkers: 'block' })
    try {
      await context.route('**/*', route => {
        const request = route.request()
        const guestSession = retry && task.id === 'ikea' && request.method() === 'POST' &&
          request.url() === 'https://api.ingka.ikea.com/guest/token' && !request.isNavigationRequest()
        const allowed = (guestSession || (retry ? ['GET', 'HEAD', 'OPTIONS'] : ['GET', 'HEAD']).includes(request.method())) &&
          (!request.isNavigationRequest() || new URL(request.url()).origin === origin)
        return allowed ? route.continue() : route.abort()
      })
      const prompt = `${task.start} 에서 ${task.instruction}`
      const parsed = await parseRequest([prompt])
      if (!parsed || parsed.question || !parsed.url || new URL(parsed.url).href !== task.start) throw new Error('Request parser did not preserve the supplied start page.')
      const surface = await openSurface(context, parsed.url)
      const run = await runAgent({ goal: parsed.goal, ...(parsed.text ? { text: parsed.text } : {}), surface, small, llm: llmModel, policy: llmOnly ? { kind: 'llm' } : { kind: 'fixed', margin: threshold }, maxSteps: 8, signal: AbortSignal.timeout(120_000) })
      const final = URL.parse(run.url)
      const target = new URL(task.target, origin)
      const passed = Boolean(final?.origin === origin && final.pathname === target.pathname &&
        [...target.searchParams].every(([key, value]) =>
          [...final.searchParams].some(([actual, observed]) => actual.toLowerCase() === key.toLowerCase() && observed === value)))
      const finalPage = context.pages().at(-1)
      await finalPage?.screenshot({ path: new URL(`${task.id}.png`, evidence).pathname, timeout: 12_000 }).catch(() => {})
      const { text: _pageText, ...trace } = run
      results.push({ ...task, prompt, parsedGoal: parsed.goal, parsedText: parsed.text, passed, ...trace })
      console.log(`${task.id}: ${passed ? 'PASS' : 'FAIL'} · ${run.status} · LLM ${run.llmCalls} · ${run.url}`)
    } catch (error) {
      results.push({ ...task, passed: false, status: 'setup-error', note: error instanceof Error ? error.message.split('\n')[0] : String(error) })
      console.log(`${task.id}: setup failed — ${error instanceof Error ? error.stack?.split('\n').slice(0, 4).join('\n') : String(error)}`)
    } finally {
      await context.close()
    }
    await writeFile(new URL(`${outputName}.json`, out), JSON.stringify({ policy: llmOnly ? 'llm' : 'fixed', threshold: llmOnly ? null : threshold, evaluation: 'Public read-only tasks, one run per task; LLM calls refer to action decisions only', results }, null, 2) + '\n')
  }
} finally {
  await browser.close()
}
