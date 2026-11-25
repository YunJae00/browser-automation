// Stands in for both model APIs so the whole app runs without keys or cost.
// It picks the option sharing the most words with the goal; it is not smart, only well-formed.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const words = (text: string) => new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 1))

function rank(goal: string, options: [string, string][]): [string, number][] {
  const wanted = words(goal)
  const scored = options.map(([key, meaning]): [string, number] => [key, [...words(meaning)].filter(word => wanted.has(word)).length])
  return scored.sort((a, b) => b[1] - a[1])
}

const goalOf = (content: string) => /Goal: (.*)/.exec(content)?.[1] ?? ''

function decision(body: any) {
  const state: string = body.state
  const options = Object.entries(body.questions.next.criteria as Record<string, string>)
  const ranked = rank(goalOf(state), options.filter(([key]) => key !== 'blocked'))
  // Past the first page, the goal is taken as met.
  const choice = state.includes('Nothing has been done yet.') ? ranked[0]![0] : 'done'
  const other = options.find(([key]) => key !== choice)![0]
  // Sure of a good word match, close to a coin toss otherwise, so both paths of the gate get exercised.
  const sure = ranked[0]![1] >= 3 ? 0.9 : 0.55
  return { answers: { next: { choice, confidence: sure, probabilities: { [choice]: sure, [other]: 1 - sure } } } }
}

function claude(body: any) {
  const content: string = body.messages.at(-1).content
  const schema = body.output_config?.format?.schema
  let text = '요청한 페이지를 열었습니다.'
  if (schema?.properties?.url) {
    const url = /https?:\/\/\S+/.exec(content)?.[0] ?? null
    text = JSON.stringify({ url, goal: content, text: null, question: url ? null : '어느 사이트에서 찾을까요?' })
  } else if (schema?.properties?.choice) {
    const options = [...content.matchAll(/^(done|blocked|more|first|(?:press|type|choose) #\d+): (.*)$/gm)].map((match): [string, string] => [match[1]!, match[2]!])
    const ranked = rank(goalOf(content), options.filter(([key]) => key !== 'blocked'))
    text = JSON.stringify({ choice: content.includes('Nothing has been done yet.') ? ranked[0]![0] : 'done' })
  }
  return { id: 'msg_fake', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 500, output_tokens: 50 } }
}

export async function startFakeModels(port = 0): Promise<{ url: string; server: Server }> {
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body.questions ? decision(body) : claude(body)))
  })
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }
}
