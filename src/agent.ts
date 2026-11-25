import type { Control, MoveKind, PageView, Surface } from './browser.js'
import { MAX_OPTIONS, type Decide, type Usage } from './models.js'
import { pressCommits } from './press-guard.js'
import { escalates, features, type Features, type Policy } from './risk.js'

export type Status = 'done' | 'blocked' | 'needs-person' | 'steps-exhausted' | 'error' | 'stopped'
export interface Step {
  step: number; url: string; title: string; options: number
  decider: 'small' | 'llm'; choice: string; what?: string
  features?: Features; risk?: number; top: [string, number][]
  smallChoice?: string; smallProbabilityCount?: number
  moved?: boolean; error?: string; changed?: boolean; ms: number
}
export interface Run {
  status: Status; note?: string; url: string; title: string; text: string; steps: Step[]
  smallCalls: number; llmCalls: number; small: Usage; llm: Usage; ms: number
}
export interface RunInput {
  goal: string; text?: string; surface: Surface; small: Decide | null; llm: Decide; policy: Policy
  maxSteps?: number; onStep?(step: Step, counts: Pick<Run, 'smallCalls' | 'llmCalls'>): void; signal?: AbortSignal
}

const FIELD = new Set(['field', 'textbox', 'searchbox', 'combobox'])
const SELECT = new Set(['select', 'listbox'])
const PAGE_SIZE = MAX_OPTIONS - 4

export function pageOptions(controls: Control[], text: string | undefined, offset = 0): Record<string, string> {
  const options: Record<string, string> = {
    done: 'The page already shows the goal met; nothing more to do here.',
    blocked: 'Nothing on this page leads to the goal, or only the person can continue.',
  }
  if (controls.length > offset + PAGE_SIZE) options['more'] = 'Read the next group of controls before concluding that the target is absent.'
  if (offset > 0) options['first'] = 'Return to the first group of controls.'
  for (const control of controls.slice(offset, offset + PAGE_SIZE)) {
    const label = `#${control.id} [${control.kind}] ${control.name || '(no words)'}${control.context ? ` (row: ${control.context})` : ''}`
    if (FIELD.has(control.kind)) {
      if (text && control.searchText === text) options[`search #${control.id}`] = `Run the search for the text already entered into ${label}`
      else if (text) options[`type #${control.id}`] = `Type the given text into ${label}`
    }
    else if (SELECT.has(control.kind)) { if (text) options[`choose #${control.id}`] = `Choose the entry matching the given text in ${label}` }
    else options[`press #${control.id}`] = `Press ${label}`
  }
  return options
}

// Where on the site, never which site: a private address does not leave the machine.
const where = (url: string) => { try { const at = new URL(url); return `${at.pathname}${at.search}` } catch { return '' } }

function describe(goal: string, text: string | undefined, page: PageView, done: string[]): string {
  return [
    `Goal: ${goal}`,
    text ? `Text to enter or choose where the goal needs it: ${JSON.stringify(text)}` : 'No text is to be entered.',
    done.length ? `Done so far:\n${done.map((line, index) => `${index + 1}. ${line}`).join('\n')}` : 'Nothing has been done yet.',
    `Page: ${page.title} (${where(page.url)})`,
    ...(page.dialog ? [`A dialog is open: ${page.dialog}`] : []),
    `Page text (start):\n${page.text.slice(0, 1_500)}`,
  ].join('\n\n')
}

const fingerprint = (page: PageView) => `${page.url}|${page.controls.map(control => control.name).join('|')}`

export async function runAgent(input: RunInput): Promise<Run> {
  const { goal, text, surface, small, llm, policy, maxSteps = 12, onStep, signal } = input
  const started = Date.now()
  const steps: Step[] = [], done: string[] = [], seen = new Set<string>()
  const used = { smallCalls: 0, llmCalls: 0, small: { input: 0, output: 0 }, llm: { input: 0, output: 0 } }
  const call = async (who: 'small' | 'llm', decide: Decide, state: string, options: Record<string, string>) => {
    used[`${who}Calls`]++
    const decision = await decide(state, options, signal)
    const usage: Usage = used[who]
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'estimatedUsd'] as const) {
      const value = decision.usage[key]
      if (value !== undefined) usage[key] = (usage[key] ?? 0) + value
    }
    return decision
  }
  let page: PageView = { url: '', title: '', text: '', controls: [] }
  const finish = (status: Status, note?: string): Run => ({ status, ...(note ? { note } : {}), url: page.url, title: page.title, text: page.text, steps, ...used, ms: Date.now() - started })
  try {
    page = await surface.read()
    let moves = 0, asks = 0, offset = 0, last = '', stalled = false
    while (moves < maxSteps && asks < maxSteps * 3) {
      signal?.throwIfAborted()
      if (page.wall) return finish('needs-person', page.wall === 'login' ? '로그인이 필요한 페이지입니다.' : '로봇 확인이 필요한 페이지입니다.')
      const state = describe(goal, text, page, done)
      const options = pageOptions(page.controls, text, offset)
      const key = fingerprint(page)
      const revisit = offset === 0 && seen.has(key)
      seen.add(key)
      asks++
      const askedAt = Date.now()
      let decision, decider: Step['decider'] = 'small', f: Features | undefined, risk: number | undefined
      let smallChoice: string | undefined, smallProbabilityCount: number | undefined
      if (policy.kind === 'llm' || !small) {
        decision = await call('llm', llm, state, options)
        decider = 'llm'
      } else {
        decision = await call('small', small, state, options)
        smallChoice = decision.choice
        smallProbabilityCount = Object.keys(decision.probabilities).length
        f = features(decision.probabilities, stalled, revisit)
        const gate = escalates(policy, f)
        risk = gate.risk
        if (gate.ask) {
          decision = await call('llm', llm, state, options)
          decider = 'llm'
        }
      }
      const top = Object.entries(decision.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 5)
      const step: Step = {
        step: steps.length, url: page.url, title: page.title, options: Object.keys(options).length, decider, choice: decision.choice,
        ...(f ? { features: f, smallChoice, smallProbabilityCount } : {}), ...(risk !== undefined ? { risk } : {}),
        top, ms: Date.now() - askedAt,
      }
      const record = () => { steps.push(step); onStep?.(step, used) }
      if (decision.choice === 'more' || decision.choice === 'first') {
        offset = decision.choice === 'more' ? offset + PAGE_SIZE : 0
        step.what = decision.choice === 'more' ? '다음 선택지 보기' : '첫 선택지 보기'
        record()
        continue
      }
      if (decision.choice === 'done') { record(); return finish('done') }
      if (decision.choice === 'blocked') { record(); return finish('blocked', '이 페이지에서는 더 진행할 방법을 찾지 못했습니다.') }
      const [kind, ref] = decision.choice.split(' ') as [MoveKind, string]
      const id = ref.slice(1)
      const control = page.controls.find(one => one.id === id)
      if (!control) { record(); return finish('blocked', '선택한 항목이 페이지에 없습니다.') }
      const operationNames = { press: '누르기', type: '입력', choose: '선택', search: '검색 실행' }
      step.what = `${operationNames[kind]}: ${control.name || '(이름 없음)'}`
      // The same pick on an unchanged page is a loop, not progress.
      const signature = `${decision.choice}|${key}`
      if (signature === last) { record(); return finish('blocked', `"${control.name}"을(를) 눌러도 바뀌는 것이 없습니다.`) }
      last = signature
      // Posting a form is out of scope whatever its button says: the guard lets "다음" or "확인" through.
      if (kind === 'press' && ((control.submits && control.posts) || pressCommits({ submits: control.submits, posts: control.posts, words: control.name }))) {
        record()
        return finish('needs-person', `"${control.name}"은(는) 되돌리기 어려운 동작이라 직접 눌러 주세요.`)
      }
      const move = await surface.act(kind, id, text)
      moves++
      offset = 0
      done.push(move.ok ? `${kind} "${control.name}"` : `${kind} "${control.name}" - did not go through${move.error ? `: ${move.error}` : ''}`)
      const before = `${page.url}|${page.text.slice(0, 2_000)}`
      page = await surface.read()
      stalled = before === `${page.url}|${page.text.slice(0, 2_000)}`
      Object.assign(step, { moved: move.ok, changed: !stalled, ...(move.error ? { error: move.error } : {}) })
      record()
    }
    return finish('steps-exhausted', `${maxSteps}단계 안에 끝내지 못했습니다.`)
  } catch (error) {
    if (signal?.aborted) return finish('stopped', '중지했습니다.')
    return finish('error', error instanceof Error ? error.message : String(error))
  }
}
