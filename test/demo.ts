// Hosts a local fixture and the app. The default demonstration uses fake models.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { TASKS, type SiteLog } from '../experiment/sites.js'
import { startFakeModels } from './fake-models.js'

const simulated = !process.argv.includes('--real')
if (simulated) {
  const models = await startFakeModels()
  process.env['LLM_PROVIDER'] = 'api'
  process.env['ANTHROPIC_BASE_URL'] = models.url
  process.env['ANTHROPIC_API_KEY'] = 'demo'
  process.env['DECISION_BASE_URL'] = `${models.url}/decision`
  process.env['DECISION_MODEL'] = 'demo'
}

const task = TASKS.find(one => one.id === 'look-alike')!
const log: SiteLog = { visits: [], served: new Map() }
const site = createServer((req, res) => {
  const page = task.page(req.url ?? '/', log)
  res.writeHead(page?.status ?? (page ? 200 : 404), { 'content-type': 'text/html; charset=utf-8' })
  res.end(page?.html ?? 'not found')
})
await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve))

const { start } = await import('../src/server.js')
const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`
const prompt = `${origin}/ 에서 ${task.goal}`
const app = await start(undefined, {
  prompt,
  simulated,
  grade(url) {
    const final = URL.parse(url)
    if (final?.origin === origin) return task.reached(final.pathname + final.search, log)
    return undefined
  },
})
console.log(`앱: http://localhost:${(app.address() as AddressInfo).port}`)
console.log(`입력 예시: ${prompt}`)
