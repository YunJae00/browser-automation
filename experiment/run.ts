// Runs the mock-site tasks under one condition and grades each run by where it ended.
//   npm run experiment -- --condition=small|always|fixed|risk|llm [--threshold=N] [--set=train|validation|eval|all] [--repeat=N] [--parallel=N] [--only=a,b]
// Writes runs/<name>/runs.jsonl.
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAgent } from '../src/agent.js'
import { launch, openSurface } from '../src/browser.js'
import { llmConfig, llmModel, smallModel } from '../src/models.js'
import { loadRiskModel, type Policy } from '../src/risk.js'
import { FINAL, FINAL_TWO, HELD_OUT, TASKS, type GateTask, type SiteLog } from './sites.js'

const arg = (name: string) => process.argv.find(one => one.startsWith(`--${name}=`))?.slice(name.length + 3)
const condition = arg('condition') ?? 'small'
const threshold = arg('threshold') ? Number(arg('threshold')) : undefined
const set = arg('set') ?? 'all'
const repeat = Number(arg('repeat') ?? 3)
const parallel = Number(arg('parallel') ?? 4)
const only = arg('only')?.split(',')

function policyFor(): Policy {
  if (condition === 'small' || condition === 'llm' || condition === 'always') return { kind: condition }
  if (condition === 'fixed') return { kind: 'fixed', margin: threshold ?? 0.3 }
  if (condition !== 'risk') throw new Error(`Unknown condition: ${condition}`)
  const model = loadRiskModel()
  if (!model) throw new Error('No data/risk-model.json yet: collect runs, then npm run train.')
  return { kind: 'risk', model, threshold: threshold ?? 0.5 }
}
const policy = policyFor()
const small = smallModel()
if (condition !== 'llm' && !small) throw new Error('Set DECISION_BASE_URL and DECISION_MODEL for this condition.')
if (![repeat, parallel].every(n => Number.isInteger(n) && n > 0)) throw new Error('Repeat and parallel must be positive integers.')
if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)) throw new Error('Threshold must be between 0 and 1.')

const evaluate = [...FINAL, ...FINAL_TWO]
const sets: Record<string, GateTask[]> = { train: TASKS, validation: HELD_OUT, eval: evaluate, all: [...TASKS, ...HELD_OUT, ...evaluate] }
if (!Object.hasOwn(sets, set)) throw new Error(`Unknown set: ${set}`)
const tasks = sets[set]!.filter(task => !only || only.includes(task.id))
if (!tasks.length) throw new Error('No matching tasks.')

async function serve(task: GateTask, log: SiteLog): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const path = req.url ?? '/'
    log.visits.push(path)
    const page = task.page(path, log)
    if (page?.location) { res.writeHead(page.status ?? 302, { location: page.location }); res.end(); return }
    res.writeHead(page ? page.status ?? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page?.html ?? '<!doctype html><meta charset="utf-8"><title>찾을 수 없음</title><h1>페이지를 찾을 수 없습니다</h1><a href="/">홈으로</a>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }
}

await mkdir(fileURLToPath(new URL('../runs', import.meta.url)), { recursive: true })
const name = `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${condition}${threshold !== undefined ? `-${threshold}` : ''}-${set}-`
const out = await mkdtemp(fileURLToPath(new URL(`../runs/${name}`, import.meta.url)))
const browser = await launch(true)
const cutoff = policy.kind === 'fixed' ? policy.margin : policy.kind === 'risk' ? policy.threshold : undefined
await writeFile(join(out, 'manifest.json'), JSON.stringify({
  startedAt: new Date().toISOString(), condition, cutoff, set, repeat, parallel, tasks: tasks.map(task => task.id),
  llm: condition === 'small' ? undefined : llmConfig(), decisionModel: condition === 'llm' ? undefined : process.env['DECISION_MODEL'],
  riskModel: policy.kind === 'risk' ? policy.model : undefined,
  node: process.version, chromium: browser.version(),
}, null, 2) + '\n')
console.log(out)
const queue = Array.from({ length: repeat }, (_, round) => tasks.map(task => ({ task, round }))).flat()
let finished = 0, succeeded = 0

async function worker(): Promise<void> {
  for (let job = queue.shift(); job; job = queue.shift()) {
    const { task, round } = job
    const log: SiteLog = { visits: [], served: new Map() }
    const { url, server } = await serve(task, log)
    const context = await browser.newContext({ acceptDownloads: false })
    const started = performance.now()
    try {
      const surface = await openSurface(context, `${url}${task.start}`)
      const run = await runAgent({ goal: task.goal, ...(task.text ? { text: task.text } : {}), surface, small, llm: llmModel, policy })
      const finalPath = (() => { try { const at = new URL(run.url); return at.pathname + at.search } catch { return '' } })()
      const success = run.status !== 'error' && task.reached(finalPath, log)
      await appendFile(join(out, 'runs.jsonl'), `${JSON.stringify({ task: task.id, set: task.set, trap: task.trap, condition, threshold: cutoff, round, success, finalPath, visits: log.visits, ...run, ms: Math.round(performance.now() - started), agentMs: run.ms, text: undefined })}\n`)
      finished++
      if (success) succeeded++
      console.log(`${finished}/${repeat * tasks.length} ${success ? 'ok  ' : 'fail'} ${task.id} [${run.status}] llm=${run.llmCalls}${run.note ? ` ${run.note}` : ''}`)
    } finally {
      await context.close()
      server.close()
    }
  }
}

try {
  await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, worker))
} finally {
  await browser.close()
}
console.log(`${succeeded}/${finished} succeeded. ${out}`)
