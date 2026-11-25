// Use directories from a single evaluation per policy. --json emits evidence for the report and slides.
import { readRuns, type Row } from './runs.js'

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
const success = (run: Pick<Row, 'success'>) => Number(run.success)
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]!

// Resample task means to keep repeated trials of a task together.
function bootstrap(byTask: number[], rounds: number): [number, number] {
  let seed = 12345
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32
  const samples = Array.from({ length: rounds }, () => mean(byTask.map(() => byTask[Math.floor(next() * byTask.length)]!)))
  return [percentile(samples, 0.025), percentile(samples, 0.975)]
}

export function interval(rows: Pick<Row, 'task' | 'success'>[], rounds = 2_000): [number, number] {
  const byTask = [...Map.groupBy(rows, row => row.task)].sort(([a], [b]) => a.localeCompare(b))
  return bootstrap(byTask.map(([, runs]) => mean(runs.map(success))), rounds)
}

export function compare(rows: Row[], baseline: Row[]) {
  const byKey = new Map(baseline.map(run => [JSON.stringify([run.task, run.round]), run]))
  const pairs = rows.flatMap(run => {
    const other = byKey.get(JSON.stringify([run.task, run.round]))
    return other ? [{ run, other }] : []
  })
  if (!pairs.length) return null
  const tasks = [...Map.groupBy(pairs, pair => pair.run.task)].sort(([a], [b]) => a.localeCompare(b))
  const deltas = tasks.map(([, pairs]) => mean(pairs.map(({ run, other }) => success(run) - success(other))))
  return {
    tasks: tasks.length, pairs: pairs.length, successDelta: mean(deltas), successDeltaInterval: bootstrap(deltas, 2_000),
    llmCallsDelta: mean(pairs.map(({ run, other }) => run.llmCalls - other.llmCalls)),
    secondsDelta: mean(pairs.map(({ run, other }) => (run.ms - other.ms) / 1000)),
  }
}

export function metrics(rows: Row[]) {
  const llmCost = rows.every(row => !row.llmCalls || row.llm.estimatedUsd !== undefined)
    ? mean(rows.map(row => row.llm.estimatedUsd ?? 0)) : null
  const smallRate = process.env['SMALL_PRICE_CALL']
  const smallCost = rows.every(row => !row.smallCalls) ? 0
    : smallRate?.trim() && Number.isFinite(Number(smallRate)) && Number(smallRate) >= 0
      ? mean(rows.map(row => row.smallCalls * Number(smallRate))) : null
  return {
    runs: rows.length, success: rows.filter(run => run.success).length, successInterval: interval(rows),
    falseDone: rows.filter(run => run.status === 'done' && !run.success).length,
    errors: rows.filter(run => run.status === 'error').length,
    stops: rows.filter(run => run.status === 'stopped').length,
    llmCalls: mean(rows.map(run => run.llmCalls)), smallCalls: mean(rows.map(run => run.smallCalls)),
    seconds: mean(rows.map(run => run.ms)) / 1000, medianSeconds: percentile(rows.map(run => run.ms), 0.5) / 1000,
    p90Seconds: percentile(rows.map(run => run.ms), 0.9) / 1000,
    llmEstimatedUsd: llmCost, decisionEstimatedUsd: smallCost,
    changedPicks: rows.flatMap(run => run.steps).filter(step => step.decider === 'llm' && step.smallChoice && step.smallChoice !== step.choice).length,
    singleScore: rows.flatMap(run => run.steps).filter(step => step.smallProbabilityCount === 1).length,
    byTask: [...Map.groupBy(rows, row => row.task)].map(([task, runs]) => ({
      task, trap: runs[0]!.trap, runs: runs.length, success: runs.filter(run => run.success).length,
      failures: runs.filter(run => !run.success).map(run => ({ round: run.round, status: run.status, finalPath: run.finalPath, note: run.note })),
    })).sort((a, b) => a.task.localeCompare(b.task)),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const rows = (await readRuns(args.filter(arg => arg !== '--json'))).filter(row => row.set === 'final' || row.set === 'final2')
  if (!rows.length) throw new Error('No evaluation runs.')
  const groups = Map.groupBy(rows, row => `${row.condition}|${row.threshold ?? ''}`)
  const baseline = groups.get('llm|') ?? []
  const order = ['small', 'always', 'fixed', 'risk', 'llm']
  const results = [...groups].map(([key, rows]) => {
    if (new Set(rows.map(row => JSON.stringify([row.task, row.round]))).size !== rows.length) throw new Error(`Duplicate trials in ${key}. Use one run directory per policy and threshold.`)
    const [condition, cutoff] = key.split('|')
    return { condition, cutoff: cutoff ? Number(cutoff) : null, ...metrics(rows), versusLlm: condition === 'llm' ? null : compare(rows, baseline) }
  }).sort((a, b) => order.indexOf(a.condition!) - order.indexOf(b.condition!))
  if (args.includes('--json')) {
    console.log(JSON.stringify(results, null, 2))
  } else {
    const percent = (value: number) => `${(100 * value).toFixed(1)}%`
    console.log('| 조건 | 기준 | 도달/실행 | 성공률 (95% 구간) | 거짓 완료 | 오류 | LLM/과제 | 소형/과제 | 평균 / P90 | LLM 추정액 |')
    console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
    for (const item of results) {
      const [low, high] = item.successInterval
      console.log(`| ${item.condition} | ${item.cutoff?.toFixed(3) ?? '—'} | ${item.success}/${item.runs} | ${percent(item.success / item.runs)} (${percent(low)}–${percent(high)}) | ${item.falseDone} | ${item.errors} | ${item.llmCalls.toFixed(2)} | ${item.smallCalls.toFixed(2)} | ${item.seconds.toFixed(1)} / ${item.p90Seconds.toFixed(1)}s | ${item.llmEstimatedUsd !== null ? '$' + item.llmEstimatedUsd.toFixed(4) : '—'} |`)
    }
  }
}
