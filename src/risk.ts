import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface Features { margin: number; entropy: number; stalled: number; revisit: number }
export interface RiskModel { bias: number; weights: Features }
export type Policy =
  | { kind: 'small' }
  | { kind: 'llm' }
  | { kind: 'always' }
  | { kind: 'fixed'; margin: number }
  | { kind: 'risk'; model: RiskModel; threshold: number }

const NAMES = ['margin', 'entropy', 'stalled', 'revisit'] as const
export const MODEL_PATH = fileURLToPath(new URL('../data/risk-model.json', import.meta.url))
export const CALIBRATION_PATH = fileURLToPath(new URL('../data/calibration.json', import.meta.url))

export function features(probabilities: Record<string, number>, stalled: boolean, revisit: boolean): Features {
  const values = Object.values(probabilities).sort((a, b) => b - a)
  const margin = (values[0] ?? 0) - (values[1] ?? 0)
  const entropy = values.length > 1 ? -values.reduce((sum, p) => sum + (p > 0 ? p * Math.log(p) : 0), 0) / Math.log(values.length) : 0
  return { margin, entropy, stalled: stalled ? 1 : 0, revisit: revisit ? 1 : 0 }
}

export function predict(model: RiskModel, f: Features): number {
  return 1 / (1 + Math.exp(-(model.bias + NAMES.reduce((sum, name) => sum + model.weights[name] * f[name], 0))))
}

// Logistic regression by gradient descent; the features are already 0..1.
export function train(rows: { features: Features; failed: boolean }[], epochs = 2_000, rate = 0.5): RiskModel {
  if (!rows.length) throw new Error('No steps to train on.')
  const model: RiskModel = { bias: 0, weights: { margin: 0, entropy: 0, stalled: 0, revisit: 0 } }
  for (let epoch = 0; epoch < epochs; epoch++) {
    const grad = { bias: 0, margin: 0, entropy: 0, stalled: 0, revisit: 0 }
    for (const row of rows) {
      const error = predict(model, row.features) - (row.failed ? 1 : 0)
      grad.bias += error
      for (const name of NAMES) grad[name] += error * row.features[name]
    }
    model.bias -= rate * grad.bias / rows.length
    for (const name of NAMES) model.weights[name] -= rate * grad[name] / rows.length
  }
  return model
}

export function escalates(policy: Policy, f: Features): { ask: boolean; risk?: number } {
  if (policy.kind === 'llm' || policy.kind === 'always') return { ask: true }
  if (policy.kind === 'small') return { ask: false }
  if (policy.kind === 'fixed') return { ask: f.margin < policy.margin }
  const risk = predict(policy.model, f)
  return { ask: risk >= policy.threshold, risk }
}

export function loadRiskModel(path = MODEL_PATH): RiskModel | null {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as RiskModel : null
}

export function appThreshold(policy: 'fixed' | 'risk', override?: string): number {
  const settings = existsSync(CALIBRATION_PATH)
    ? JSON.parse(readFileSync(CALIBRATION_PATH, 'utf8')) as Partial<Record<'fixed' | 'risk', { threshold?: number }>>
    : null
  const threshold = override?.trim() ? Number(override) : settings?.[policy]?.threshold ?? (policy === 'fixed' ? 0.3 : 0.5)
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('RISK_THRESHOLD는 0과 1 사이여야 합니다.')
  return threshold
}
