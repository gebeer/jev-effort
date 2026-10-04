/**
 * jev-effort — pure logic. No `$`, no I/O: context → Jev state, the request,
 * the answer, the decision, and the log/status formatters.
 *
 * Wire shape (OpenRouter and TypeSafe-direct are identical):
 *   POST {endpoint} { model, state, questions } → { answers: { effort: { score, confidence } } }
 */
import type { PromptOrigin, SessionMessage } from 'claude-code'

/** The only values the mod ever sets, cheapest first. Never `max`. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const
export type Effort = (typeof EFFORTS)[number]
type SessionEffort = Effort | 'max' | number | undefined

// ponytail: fixed caps; promote to options only if shadow data asks for it.
export const LIMITS = {
  promptChars: 2000,
  replyChars: 1500,
  earlierPrompts: 3,
  earlierPromptChars: 300,
  toolsChars: 300,
}
export type Limits = typeof LIMITS

export interface JevState {
  prompt: string
  last_reply?: string
  earlier_prompts?: string[]
  last_turn_tools?: string
}

export interface JevAnswer {
  score: number
  confidence: number
}

export interface Bars {
  up: number
  down: number
}

export interface Decision {
  wanted: Effort | null
  target: Effort | null
  reason: string
}

// ---------------------------------------------------------------- skips

const ROUTED_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

/** Why a submission isn't classified, or null to classify it. */
export function skipReason(text: string, origin: PromptOrigin, turnId: string | undefined): string | null {
  if (!ROUTED_ORIGINS.has(origin.kind)) return `origin ${origin.kind}`
  if (turnId) return 'mid-turn prompt'
  const t = text.trim()
  if (!t) return 'empty prompt'
  // Jev would only see the command's name, never the skill body it expands to.
  if (/^\/[^\s/]+$/.test(t)) return 'bare command'
  return null
}

// ---------------------------------------------------------------- context

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Head and tail: keeps the task statement and the closing question. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.ceil((max - 3) / 2)
  const tail = Math.floor((max - 3) / 2)
  return `${text.slice(0, head)} … ${text.slice(text.length - tail)}`
}

// ponytail: engine-injected rows (<system-reminder>, <command-name>, ...) are told
// apart by a leading '<'; a user prompt starting with '<' is missed. Verify live.
const isPromptRow = (m: SessionMessage) =>
  m.role === 'user' && !m.toolResults?.length && norm(m.text) !== '' && !norm(m.text).startsWith('<')

/** Tool names only, never inputs or outputs: `Read×3, Edit, Bash×2 (1 failed)`. */
function summarizeTools(uses: { tool: string; isError?: true }[], max: number): string {
  const counts = new Map<string, { n: number; failed: number }>()
  for (const u of uses) {
    const c = counts.get(u.tool) ?? { n: 0, failed: 0 }
    c.n += 1
    if (u.isError) c.failed += 1
    counts.set(u.tool, c)
  }
  const parts = [...counts].map(
    ([tool, c]) => `${tool}${c.n > 1 ? `×${c.n}` : ''}${c.failed ? ` (${c.failed} failed)` : ''}`,
  )
  return clip(parts.join(', '), max)
}

/** What Jev sees. Reads only role, text, tool names, error flags and whether toolResults exist. */
export function buildState(
  prompt: string,
  messages: readonly SessionMessage[],
  sendContext: boolean,
  limits: Limits = LIMITS,
): JevState {
  const state: JevState = { prompt: clip(norm(prompt), limits.promptChars) }
  if (!sendContext) return state

  let end = messages.length
  const last = messages[end - 1]
  if (last && last.role === 'user' && norm(last.text) === norm(prompt)) end -= 1

  let reply: string | undefined
  const uses: { tool: string; isError?: true }[] = []
  const earlier: string[] = []
  let inLastTurn = true
  for (let i = end - 1; i >= 0 && earlier.length < limits.earlierPrompts; i--) {
    const m = messages[i]!
    if (isPromptRow(m)) {
      earlier.unshift(clip(norm(m.text), limits.earlierPromptChars))
      inLastTurn = false
      continue
    }
    if (m.role !== 'assistant') continue
    if (reply === undefined && norm(m.text)) reply = clip(norm(m.text), limits.replyChars)
    if (inLastTurn) uses.unshift(...m.toolUses.map((u) => ({ tool: u.tool, isError: u.isError })))
  }

  if (reply) state.last_reply = reply
  if (earlier.length) state.earlier_prompts = earlier
  if (uses.length) state.last_turn_tools = summarizeTools(uses, limits.toolsChars)
  return state
}

// ---------------------------------------------------------------- request / response

const QUESTION = {
  type: 'score',
  instructions:
    'How much step-by-step reasoning does the coding assistant need to do the work the user asks for in `prompt` well? If `prompt` is a short reply such as "yes", "do it" or "continue", rate the work it approves or continues, as described in `last_reply` and `last_turn_tools`. The other fields are earlier conversation, given for context only.',
  criteria: [
    'Almost none: a direct answer, a confirmation, a lookup, running one command, or a small change whose exact edit is already spelled out.',
    'Some: an ordinary, well-specified change or explanation within a few files, where the approach is obvious.',
    'A lot: a multi-step change across several files, a bug with a clear symptom but unclear cause, or a review that weighs trade-offs.',
    'As much as possible: open-ended design or architecture, a failure whose cause is still unknown after earlier attempts, or work where a mistake is costly or hard to undo (security, concurrency, data migration, production systems).',
  ],
}

export const requestBody = (model: string, state: JevState) =>
  JSON.stringify({ model, state, questions: { effort: QUESTION } })

export const requestHeaders = (apiKey: string): Record<string, string> => ({
  'content-type': 'application/json',
  authorization: `Bearer ${apiKey}`,
})

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Null on anything unexpected; a missing confidence counts as no answer. */
export function readAnswer(responseText: string): JevAnswer | null {
  let body: any
  try {
    body = JSON.parse(responseText)
  } catch {
    return null
  }
  const a = body?.answers?.effort
  if (!finite(a?.score) || !finite(a?.confidence)) return null
  return { score: a.score, confidence: a.confidence }
}

// ---------------------------------------------------------------- decision

export const effortLevel = (score: number): Effort =>
  EFFORTS[Math.min(EFFORTS.length - 1, Math.max(0, Math.round(score)))]!

const isEffort = (v: unknown): v is Effort => EFFORTS.includes(v as Effort)

/** The session's `/effort` is the baseline: neither floor nor ceiling. */
export function decide(answer: JevAnswer | null, session: SessionEffort, bars: Bars): Decision {
  if (!answer) return { wanted: null, target: null, reason: 'no answer' }
  const wanted = effortLevel(answer.score)
  const keep = (reason: string): Decision => ({ wanted, target: null, reason })
  if (session === undefined) return keep('model takes no effort')
  if (typeof session === 'number') return keep('numeric budget left alone')
  if (session === 'max') return keep('max left alone')
  if (!isEffort(session)) return keep(`unknown effort ${session}`)
  if (wanted === session) return keep(`already ${session}`)
  const bar = EFFORTS.indexOf(wanted) < EFFORTS.indexOf(session) ? bars.down : bars.up
  const cmp = `conf ${answer.confidence.toFixed(2)} ${answer.confidence >= bar ? '≥' : '<'} ${bar.toFixed(2)}`
  return answer.confidence >= bar ? { wanted, target: wanted, reason: cmp } : keep(cmp)
}

/**
 * With no answer (failure, skip, no prompt), repeat the previous turn's effort
 * rather than snap back to the session's: the effort stays steady through an outage.
 * Only while the user's own `/effort` hasn't changed since that turn.
 */
export function sticky(
  session: SessionEffort,
  prev: { session: SessionEffort; sent: SessionEffort } | null,
): Effort | null {
  if (!prev || prev.session !== session || !isEffort(session) || !isEffort(prev.sent)) return null
  return prev.sent === session ? null : prev.sent
}

// ---------------------------------------------------------------- formatting

const showEffort = (e: SessionEffort) => (e === undefined ? 'default' : String(e))

export interface LineInput {
  shadow: boolean
  session: SessionEffort
  answer: JevAnswer | null
  note: string | null
  jevMs?: number
  decision: Decision
  /** Set when sticky repeated the previous effort. */
  stuck?: Effort | null
}

function outcome(i: LineInput): string {
  const s = showEffort(i.session)
  if (i.decision.target) return `${s} → ${i.decision.target}`
  if (i.stuck) return `${s} → ${i.stuck} (sticky)`
  return `${s} kept`
}

/** One transcript line per main turn. */
export function logLine(i: LineInput): string {
  const head = i.shadow ? '[jev-effort] shadow · ' : '[jev-effort] '
  if (!i.answer) return `${head}${i.note ?? 'no answer'} · ${outcome(i)}`
  const a = i.answer
  const jev = `jev ${a.score.toFixed(2)} → ${i.decision.wanted} (conf ${a.confidence.toFixed(2)}${i.jevMs === undefined ? '' : `, ${Math.round(i.jevMs)}ms`})`
  const tail = i.decision.target ? '' : `: ${i.decision.reason}`
  return `${head}${jev} · ${outcome(i)}${tail}`
}

const BARS = '▁▂▃▄▅▆▇█'
export const SPARK_LENGTH = 8

/** Recent Jev scores (0..3) as bars, oldest first. */
export const sparkline = (scores: readonly number[]) =>
  scores.map((s) => BARS[Math.round((Math.min(3, Math.max(0, s)) / 3) * (BARS.length - 1))]).join('')

const statusHead = (shadow: boolean, glyph: string, spark: string) =>
  `${shadow ? 'shadow ' : ''}${glyph}${spark ? ` ${spark}` : ''}`

/** While Jev is being asked. */
export const askingLine = (shadow: boolean, spark: string) => `${statusHead(shadow, '◌', spark)} asking…`

/** The persistent status line: ● answered, ✕ failed, – nothing asked. */
export function statusLine(i: LineInput, spark: string): string {
  if (!i.answer) {
    const quiet = i.note === null || i.note === 'no prompt' || i.note.startsWith('skipped')
    return `${statusHead(i.shadow, quiet ? '–' : '✕', spark)} ${i.note ?? 'no answer'} · ${outcome(i)}`
  }
  const { decision: d, answer: a } = i
  const why = d.target
    ? ` ${a.confidence.toFixed(2)}`
    : d.reason.startsWith('conf')
      ? ` (wanted ${d.wanted}, ${d.reason.slice(5)})`
      : ` (${d.reason})`
  const ms = i.jevMs === undefined ? '' : ` · ${Math.round(i.jevMs)}ms`
  return `${statusHead(i.shadow, '●', spark)} ${outcome(i)}${why}${ms}`
}

/** The once-per-session setup line. */
export function setupLine(o: {
  apiKey: string
  shadow: boolean
  model: string
  endpoint: string
  sendContext: boolean
  bars: Bars
}): string {
  if (!o.apiKey) return '[jev-effort] no apiKey set; doing nothing'
  const host = /^\w+:\/\/([^/]+)/.exec(o.endpoint)?.[1] ?? o.endpoint
  return `[jev-effort] ready · ${o.shadow ? 'shadow' : 'route'} · ${o.model} via ${host} · context ${o.sendContext ? 'on' : 'off'} · bars ↑${o.bars.up.toFixed(2)} ↓${o.bars.down.toFixed(2)}`
}
