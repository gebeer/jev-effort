/**
 * jev-effort — sets the main loop's reasoning effort per prompt with TypeSafe's
 * Jev (via OpenRouter by default). Forked from claude-code-templates'
 * jev-model-router v0.4.2 (MIT), reduced to effort routing only.
 *
 *   prompt.submit  read recent context, ask Jev one score question
 *   turn.step      step 0 applies the decision; later steps reuse it
 *
 * `shadow` (default on) classifies and logs but never changes a request.
 * Fails open: on any error the turn keeps its effort (see `sticky`).
 * Privacy: prompt + reply excerpts and tool names go to `endpoint`; never tool I/O.
 */
import type { Register } from 'claude-code'
import {
  askingLine,
  buildState,
  decide,
  logLine,
  readAnswer,
  requestBody,
  requestHeaders,
  setupLine,
  skipReason,
  SPARK_LENGTH,
  sparkline,
  statusLine,
  sticky,
} from './policy.ts'
import type { Decision, Effort, JevAnswer } from './policy.ts'

interface Classification {
  answer: JevAnswer | null
  note: string | null
  jevMs?: number
}

type SessionEffort = Effort | 'max' | number | undefined

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export const register: Register = (on, options) => {
  const text = (key: string, fallback: string) =>
    typeof options[key] === 'string' && options[key] ? (options[key] as string) : fallback
  const number = (key: string, fallback: number) =>
    typeof options[key] === 'number' ? (options[key] as number) : fallback
  const flag = (key: string, fallback: boolean) =>
    typeof options[key] === 'boolean' ? (options[key] as boolean) : fallback

  const configuredKey = text('apiKey', '')
  const shadow = flag('shadow', true)
  const sendContext = flag('sendContext', true)
  const logDecisions = flag('logDecisions', true)
  const model = text('model', '~typesafe/jev-latest')
  const endpoint = text('endpoint', 'https://openrouter.ai/api/v1/systemone')
  const timeoutMs = clamp(number('timeoutMs', 800), 100, 5000)
  const bars = {
    up: clamp(number('minUpgradeConfidence', 0.3), 0, 1),
    down: clamp(number('minDowngradeConfidence', 0.6), 0, 1),
  }

  // Module state; a hot reload drops it, which fails open.
  let announced = false
  let apiKey = ''
  let pending: Classification | null = null
  let turn: { id: string; applied: Effort | null } | null = null
  let prev: { session: SessionEffort; sent: SessionEffort } | null = null
  const scores: number[] = []

  on('prompt.submit', async ($, e, next) => {
    if (!announced) {
      announced = true
      // Env fallback keeps the key out of settings.json.
      apiKey = configuredKey || ((await $.env.get('OPENROUTER_API_KEY')) ?? '')
      if (logDecisions) $.ui.log(setupLine({ apiKey, shadow, model, endpoint, sendContext, bars }))
    }
    if (!apiKey) return next(e)

    const skip = skipReason(e.text, e.origin, e.turnId)
    if (skip) {
      pending = { answer: null, note: `skipped: ${skip}` }
      return next(e)
    }

    $.ui.status(askingLine(shadow, sparkline(scores)))
    try {
      const state = buildState(e.text, sendContext ? await $.session.messages() : [], sendContext)
      const t0 = await $.clock.now()
      const response = await Promise.race([
        $.http.fetch(endpoint, { method: 'POST', headers: requestHeaders(apiKey), body: requestBody(model, state) }),
        $.clock.sleep(timeoutMs),
      ])
      const jevMs = (await $.clock.now()) - t0
      const answer = response && response.ok ? readAnswer(response.text) : null
      const note = !response
        ? `timeout ${timeoutMs}ms`
        : !response.ok
          ? `HTTP ${response.status}`
          : answer
            ? null
            : 'bad response'
      if (answer) {
        scores.push(answer.score)
        if (scores.length > SPARK_LENGTH) scores.shift()
      }
      pending = { answer, note, jevMs }
    } catch (error) {
      pending = { answer: null, note: `error: ${String(error)}`.slice(0, 120) }
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId || !apiKey) return yield* next(e)

    if (e.index > 0) {
      const applied = turn?.id === e.turnId ? turn.applied : null
      return yield* next(applied ? { ...e, effort: applied } : e)
    }

    const c = pending ?? { answer: null, note: 'no prompt' }
    pending = null
    const session = e.effort
    let decision: Decision = decide(c.answer, session, bars)
    if (!c.answer && c.note) decision = { ...decision, reason: c.note }
    const stuck = c.answer ? null : sticky(session, prev)
    const applied = shadow ? null : (decision.target ?? stuck)

    turn = { id: e.turnId, applied }
    prev = { session, sent: applied ?? session }

    const line = { shadow, session, answer: c.answer, note: c.note, jevMs: c.jevMs, decision, stuck }
    if (logDecisions) $.ui.log(logLine(line))
    $.ui.status(statusLine(line, sparkline(scores)))

    return yield* next(applied ? { ...e, effort: applied } : e)
  })
}
