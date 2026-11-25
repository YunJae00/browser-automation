// Trains the risk predictor from runs of the small model alone.
//   npm run train -- runs/<dir> [runs/<dir> ...]
// A step is labeled by whether its run failed. Writes data/risk-model.json.
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { MODEL_PATH, predict, train } from '../src/risk.js'
import { readRuns } from './runs.js'

const args = process.argv.slice(2)
const calibration = args.find(arg => arg.startsWith('--validation='))?.slice('--validation='.length)
const runs = await readRuns(args.filter(arg => !arg.startsWith('--validation=')))
if (runs.some(run => run.condition !== 'small' || run.set !== 'dev')) throw new Error('Train on the small-model train set only.')
const usable = runs.filter(run => run.status !== 'error' && run.status !== 'stopped')
const labeledSteps = (runs: typeof usable) => runs.flatMap(run => run.steps.flatMap(step => step.features ? [{ features: step.features, failed: !run.success }] : []))
const rows = labeledSteps(usable)
const failed = rows.filter(row => row.failed).length
if (!failed || failed === rows.length) throw new Error(`Training needs both outcomes: ${failed} of ${rows.length} steps come from failed runs.`)
const model = train(rows)
await mkdir(dirname(MODEL_PATH), { recursive: true })
await writeFile(MODEL_PATH, `${JSON.stringify(model, null, 2)}\n`)
const right = rows.filter(row => predict(model, row.features) >= 0.5 === row.failed).length
console.log(`${rows.length} steps from ${usable.length}/${runs.length} runs, ${failed} from failed runs. Training accuracy ${(100 * right / rows.length).toFixed(1)}%.`)
console.log(JSON.stringify(model))

if (calibration) {
  const validation = await readRuns([calibration])
  if (validation.some(run => run.condition !== 'small' || run.set !== 'test')) throw new Error('Calibrate on the small-model validation set only.')
  const valid = validation.filter(run => run.status !== 'error' && run.status !== 'stopped')
  const steps = labeledSteps(valid)
  if (!steps.length) throw new Error('No validation decisions.')
  const target = 0.35
  const match = (scores: number[], calls: (score: number, threshold: number) => boolean) => {
    const sorted = [...new Set([0, ...scores, 1])].sort((a, b) => a - b)
    const candidates = [0, ...sorted.slice(1).map((upper, i) => (upper + sorted[i]!) / 2), 1]
      .map(threshold => ({ threshold, rate: scores.filter(score => calls(score, threshold)).length / scores.length }))
    return candidates.sort((a, b) => Math.abs(a.rate - target) - Math.abs(b.rate - target) || a.rate - b.rate)[0]!
  }
  const riskScores = steps.map(({ features }) => predict(model, features))
  const margins = steps.map(({ features }) => features.margin)
  const prevalence = steps.filter(step => step.failed).length / steps.length
  const auc = (scores: number[]) => {
    const positive = scores.filter((_, i) => steps[i]!.failed)
    const negative = scores.filter((_, i) => !steps[i]!.failed)
    if (!positive.length || !negative.length) return null
    return positive.reduce((sum, p) => sum + negative.reduce((wins, n) => wins + (p > n ? 1 : p === n ? 0.5 : 0), 0), 0) / (positive.length * negative.length)
  }
  const settings = {
    target, validationDecisions: steps.length,
    fitting: { runs: usable.length, attempted: runs.length, decisions: rows.length, failedDecisions: failed, accuracy: right / rows.length },
    validation: {
      runs: valid.length, attempted: validation.length, failurePrevalence: prevalence,
      aucRisk: auc(riskScores), aucMargin: auc(margins.map(margin => 1 - margin)),
      brier: riskScores.reduce((sum, score, i) => sum + (score - Number(steps[i]!.failed)) ** 2, 0) / steps.length,
      brierPrevalence: prevalence * (1 - prevalence),
    },
    fixed: match(margins, (score, threshold) => score < threshold),
    risk: match(riskScores, (score, threshold) => score >= threshold),
  }
  await writeFile(new URL('../data/calibration.json', import.meta.url), JSON.stringify(settings, null, 2) + '\n')
  console.log(JSON.stringify(settings))
}
