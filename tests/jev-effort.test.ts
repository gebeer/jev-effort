import { describe, expect, mock, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'
import {
  buildState,
  clip,
  decide,
  effortLevel,
  LIMITS,
  logLine,
  readAnswer,
  requestBody,
  requestHeaders,
  skipReason,
  askingLine,
  sparkline,
  statusLine,
  sticky,
} from '../hooks/policy.ts'

const bars = { up: 0.3, down: 0.6 }
const jev = (score: number, confidence: number) =>
  JSON.stringify({
    id: 'gen-dec-1',
    provider: 'TypeSafe',
    model: 'typesafe/jev-1.13',
    answers: { effort: { type: 'score', score, confidence, probabilities: { '0': 0.68, '1': 0.24, '2': 0.06, '3': 0.02 } } },
    usage: { input_tokens: 812, output_tokens: 0, cost: 0.000034 },
  })
const composer = { kind: 'composer' } as const
const user = (text: string, extra: Partial<SessionMessage> = {}): SessionMessage => ({ role: 'user', text, toolUses: [], ...extra })
const bot = (text: string, tools: { tool: string; isError?: true }[] = []): SessionMessage => ({
  role: 'assistant',
  text,
  toolUses: tools.map((t, i) => ({ tool_use_id: `t${i}`, input: {}, ...t })),
})

describe('readAnswer', () => {
  test('parses a full response', () => {
    expect(readAnswer(jev(0.42, 0.71))).toEqual({
      score: 0.42,
      confidence: 0.71,
    })
  })
  test('null on anything unexpected', () => {
    for (const bad of ['not json', '{}', '{"answers":{}}', '{"answers":{"effort":{"score":"x","confidence":1}}}', '{"answers":{"effort":{"score":1}}}'])
      expect(readAnswer(bad)).toBe(null)
  })
})

describe('decision', () => {
  test('effortLevel rounds and clamps, never max', () => {
    const cases: [number, string][] = [[0, 'low'], [0.49, 'low'], [0.5, 'medium'], [1.49, 'medium'], [1.5, 'high'], [2.49, 'high'], [2.5, 'xhigh'], [3, 'xhigh'], [-1, 'low'], [99, 'xhigh']]
    for (const [s, e] of cases) expect(effortLevel(s)).toBe(e)
  })
  test('upgrade bar', () => {
    expect(decide({ score: 2, confidence: 0.3 }, 'medium', bars).target).toBe('high')
    expect(decide({ score: 2, confidence: 0.29 }, 'medium', bars)).toEqual({ wanted: 'high', target: null, reason: 'conf 0.29 < 0.30' })
  })
  test('downgrade bar', () => {
    expect(decide({ score: 0.2, confidence: 0.6 }, 'high', bars).target).toBe('low')
    expect(decide({ score: 0.2, confidence: 0.59 }, 'high', bars).target).toBe(null)
  })
  test('jumps two levels', () => {
    expect(decide({ score: 2.8, confidence: 0.5 }, 'low', bars).target).toBe('xhigh')
  })
  test('leaves alone', () => {
    const a = { score: 0.1, confidence: 0.99 }
    expect(decide({ score: 2.1, confidence: 0.9 }, 'high', bars).reason).toBe('already high')
    expect(decide(a, 'max', bars).reason).toBe('max left alone')
    expect(decide(a, 4000, bars).reason).toBe('numeric budget left alone')
    expect(decide(a, undefined, bars).reason).toBe('model takes no effort')
    expect(decide(a, 'turbo' as never, bars).reason).toBe('unknown effort turbo')
    expect(decide(null, 'high', bars)).toEqual({ wanted: null, target: null, reason: 'no answer' })
  })
  test('sticky repeats the previous effort only while /effort is unchanged', () => {
    expect(sticky('high', { session: 'high', sent: 'low' })).toBe('low')
    expect(sticky('high', { session: 'high', sent: 'high' })).toBe(null)
    expect(sticky('medium', { session: 'high', sent: 'low' })).toBe(null)
    expect(sticky('max', { session: 'max', sent: 'max' })).toBe(null)
    expect(sticky('high', null)).toBe(null)
  })
})

describe('request', () => {
  test('one score question, bearer auth', () => {
    const body = JSON.parse(requestBody('~typesafe/jev-latest', { prompt: 'x' }))
    expect(Object.keys(body)).toEqual(['model', 'state', 'questions'])
    expect(Object.keys(body.questions)).toEqual(['effort'])
    expect(body.questions.effort.type).toBe('score')
    expect(body.questions.effort.criteria.length).toBe(4)
    expect(requestHeaders('k')).toEqual({ 'content-type': 'application/json', authorization: 'Bearer k' })
  })
  test('skipReason', () => {
    for (const kind of ['composer', 'bridge', 'sdk']) expect(skipReason('fix it', { kind } as never, undefined)).toBe(null)
    for (const kind of ['task-notification', 'peer', 'plugin', 'unclassified'])
      expect(skipReason('fix it', { kind } as never, undefined)).toBe(`origin ${kind}`)
    expect(skipReason('fix it', composer, 'turn-1')).toBe('mid-turn prompt')
    expect(skipReason('  ', composer, undefined)).toBe('empty prompt')
    expect(skipReason('/simplify', composer, undefined)).toBe('bare command')
    expect(skipReason('/code-review high', composer, undefined)).toBe(null)
    expect(skipReason('/tmp/log.txt', composer, undefined)).toBe(null)
  })
})

describe('buildState', () => {
  const history: SessionMessage[] = [
    user('first   task'),
    bot('', [{ tool: 'Read' }]),
    user('<system-reminder>ignore</system-reminder>'),
    user('second task'),
    bot('done', [{ tool: 'Grep' }]),
    user('third task'),
    user('', { toolResults: [{ tool_use_id: 't', text: 'SECRET_RESULT', isError: false }] }),
    user('fourth task'),
    bot('', [{ tool: 'Read', result: 'SECRET_OUTPUT', text: 'SECRET_OUTPUT', input: { q: 'SECRET_INPUT' } } as never]),
    bot('', [{ tool: 'Read' }, { tool: 'Edit' }, { tool: 'Bash', isError: true }, { tool: 'Bash' }]),
    bot('Shall I add a mutex?'),
    bot('', [{ tool: 'Read' }]),
  ]
  test('empty history and context off give the prompt alone', () => {
    expect(buildState('yes', [], true)).toEqual({ prompt: 'yes' })
    expect(buildState('yes', history, false)).toEqual({ prompt: 'yes' })
  })
  test('reply, earlier prompts and last turn tools', () => {
    expect(buildState('yes,   do it', history, true)).toEqual({
      prompt: 'yes, do it',
      last_reply: 'Shall I add a mutex?',
      earlier_prompts: ['second task', 'third task', 'fourth task'],
      last_turn_tools: 'Read×3, Edit, Bash×2 (1 failed)',
    })
  })
  test('drops the prompt itself when already in the transcript', () => {
    expect(buildState('yes do it', [...history, user('yes  do it')], true).earlier_prompts).toEqual(['second task', 'third task', 'fourth task'])
  })
  test('never sends tool inputs or outputs', () => {
    const json = JSON.stringify(buildState('go', history, true))
    for (const s of ['SECRET_INPUT', 'SECRET_OUTPUT', 'SECRET_RESULT']) expect(json.includes(s)).toBe(false)
  })
  test('clips head and tail, and caps the whole state', () => {
    const long = `start ${'x'.repeat(5000)} end?`
    expect(clip(long, 20)).toBe('start xxx … xxx end?')
    const state = buildState(long.repeat(2), [user(long), bot(long, Array.from({ length: 200 }, (_, i) => ({ tool: `mcp__srv__tool${i}` })))], true)
    expect(state.prompt.length <= LIMITS.promptChars).toBe(true)
    expect(state.last_reply!.endsWith('end?')).toBe(true)
    expect(JSON.stringify(state).length <= 5200).toBe(true)
  })
})

describe('formatting', () => {
  const answer = { score: 0.42, confidence: 0.71 }
  test('log and status lines', () => {
    const changed = { shadow: false, session: 'high' as const, answer, note: null, jevMs: 212, decision: decide(answer, 'high', bars) }
    expect(logLine(changed)).toBe('[jev-effort] jev 0.42 → low (conf 0.71, 212ms) · high → low')
    expect(logLine({ ...changed, shadow: true })).toBe('[jev-effort] shadow · jev 0.42 → low (conf 0.71, 212ms) · high → low')
    expect(statusLine(changed, '▁█')).toBe('jev ● ▁█ high → low 0.71 · 212ms')
    const kept = { ...changed, answer: { score: 0.42, confidence: 0.41 }, jevMs: 198, decision: decide({ score: 0.42, confidence: 0.41 }, 'high', bars) }
    expect(logLine(kept)).toBe('[jev-effort] jev 0.42 → low (conf 0.41, 198ms) · high kept: conf 0.41 < 0.60')
    expect(statusLine({ ...kept, shadow: true }, '')).toBe('jev·s ● high kept (wanted low, 0.41 < 0.60) · 198ms')
    const none = { shadow: false, session: 'high' as const, answer: null, note: 'timeout 800ms', decision: { wanted: null, target: null, reason: 'timeout 800ms' } }
    expect(logLine(none)).toBe('[jev-effort] timeout 800ms · high kept')
    expect(statusLine({ ...none, note: 'skipped: bare command' }, '▃')).toBe('jev – ▃ skipped: bare command · high kept')
    expect(statusLine(none, '▃')).toBe('jev ✕ ▃ timeout 800ms · high kept')
    expect(askingLine(true, '▃')).toBe('jev·s ◌ ▃ asking…')
    expect(logLine({ ...none, stuck: 'low' })).toBe('[jev-effort] timeout 800ms · high → low (sticky)')
  })
  test('sparkline maps 0..3 onto eight bars, clamped', () => {
    expect(sparkline([0, 1, 1.5, 2, 3, -1, 9])).toBe('▁▃▅▆█▁█')
    expect(sparkline([])).toBe('')
  })
})

// ---------------------------------------------------------------- hooks

function harness(on: any, opts: { reply?: () => unknown; messages?: SessionMessage[]; env?: Record<string, string> } = {}) {
  const efforts: unknown[] = []
  const requests: any[] = []
  const auth: string[] = []
  const logs: string[] = []
  mock.clock(on)
  mock.env(on, opts.env ?? {})
  on('ui.log', (_$: unknown, e: any) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('prompt.submit', (_$: unknown, e: any) => ({ text: e.text }))
  on('session.messages', () => ({ value: opts.messages ?? [] }))
  on('http.fetch', (_$: unknown, e: any) => {
    requests.push(JSON.parse(e.init.body))
    auth.push(e.init.headers.authorization)
    return { value: opts.reply ? opts.reply() : { status: 200, ok: true, headers: {}, text: jev(0.2, 0.9) } }
  })
  on('turn.step', async function* (_$: unknown, e: any) {
    efforts.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return { efforts, requests, logs, auth }
}

async function step($: any, turnId: string, index: number, extra: object = {}) {
  const s = $.turn.step({ turnId, index, model: 'claude-opus-5-5', effort: 'high', messageCount: 3, ...extra })
  for await (const _ of s) {}
  return s.result
}
const submit = ($: any, text: string, extra: object = {}) => $.prompt.submit({ text, wait: false, origin: composer, ...extra })

describe('hooks', () => {
  test('route: step 0 and later steps get the decision', { options: { apiKey: 'k', shadow: false } }, async ($, on) => {
    const h = harness(on)
    await submit($, 'rename foo to bar')
    await step($, 't1', 0)
    await step($, 't1', 1)
    expect(h.efforts).toEqual(['low', 'low'])
  })
  test('shadow: classifies but never changes effort', { options: { apiKey: 'k' } }, async ($, on) => {
    const h = harness(on)
    await submit($, 'rename foo to bar')
    await step($, 't1', 0)
    await step($, 't1', 1)
    expect(h.requests.length).toBe(1)
    expect(h.efforts).toEqual(['high', 'high'])
    expect(h.logs.some((l) => l.startsWith('[jev-effort] shadow · jev 0.20 → low'))).toBe(true)
  })
  test('fail open: HTTP error, bad body, throw', { options: { apiKey: 'k', shadow: false } }, async ($, on) => {
    let n = 0
    const replies = [
      () => ({ status: 500, ok: false, headers: {}, text: '' }),
      () => ({ status: 200, ok: true, headers: {}, text: 'not json' }),
      () => { throw new Error('boom') },
    ]
    const h = harness(on, { reply: () => replies[n++]!() })
    for (const id of ['a', 'b', 'c']) {
      await submit($, 'do something')
      await step($, id, 0)
    }
    expect(h.efforts).toEqual(['high', 'high', 'high'])
  })
  test('sticky: a failure after a routed turn repeats its effort', { options: { apiKey: 'k', shadow: false } }, async ($, on) => {
    let fail = false
    const h = harness(on, { reply: () => (fail ? { status: 429, ok: false, headers: {}, text: '' } : { status: 200, ok: true, headers: {}, text: jev(0.2, 0.9) }) })
    await submit($, 'rename foo')
    await step($, 't1', 0)
    fail = true
    await submit($, 'rename bar')
    await step($, 't2', 0)
    expect(h.efforts).toEqual(['low', 'low'])
  })
  test('subagent steps are untouched and do not consume the decision', { options: { apiKey: 'k', shadow: false } }, async ($, on) => {
    const h = harness(on)
    await submit($, 'rename foo')
    await step($, 'sub', 0, { agentId: 'agent-1' })
    await step($, 't1', 0)
    expect(h.efforts).toEqual(['high', 'low'])
  })
  test('key falls back to OPENROUTER_API_KEY', async ($, on) => {
    const h = harness(on, { env: { OPENROUTER_API_KEY: 'envkey' } })
    await submit($, 'rename foo')
    expect(h.auth).toEqual(['Bearer envkey'])
  })
  test('the configured key wins over the env', { options: { apiKey: 'k' } }, async ($, on) => {
    const h = harness(on, { env: { OPENROUTER_API_KEY: 'envkey' } })
    await submit($, 'rename foo')
    expect(h.auth).toEqual(['Bearer k'])
  })
  test('no key: no fetch, no change', async ($, on) => {
    const h = harness(on)
    await submit($, 'rename foo')
    await step($, 't1', 0)
    expect(h.requests.length).toBe(0)
    expect(h.efforts).toEqual(['high'])
  })
  test('skips make no request', { options: { apiKey: 'k', shadow: false } }, async ($, on) => {
    const h = harness(on)
    await submit($, '/simplify')
    await submit($, 'fix it', { origin: { kind: 'task-notification' } })
    await submit($, 'fix it', { turnId: 'running' })
    await step($, 't1', 0)
    expect(h.requests.length).toBe(0)
    expect(h.efforts).toEqual(['high'])
  })
  test('a turn without its own prompt repeats the previous effort', { options: { apiKey: 'k', shadow: false } }, async ($, on) => {
    const h = harness(on)
    await submit($, 'rename foo')
    await step($, 't1', 0)
    await step($, 't2', 0)
    await step($, 't3', 0, { effort: 'medium' })
    expect(h.requests.length).toBe(1)
    expect(h.efforts).toEqual(['low', 'low', 'medium'])
  })
  test('context reaches the request state', { options: { apiKey: 'k' } }, async ($, on) => {
    const h = harness(on, { messages: [user('why are users logged out?'), bot('Shall I add a mutex?', [{ tool: 'Grep' }])] })
    await submit($, 'yes, do it')
    expect(h.requests[0].state).toEqual({
      prompt: 'yes, do it',
      last_reply: 'Shall I add a mutex?',
      earlier_prompts: ['why are users logged out?'],
      last_turn_tools: 'Grep',
    })
    expect(h.requests[0].model).toBe('~typesafe/jev-latest')
  })
})
