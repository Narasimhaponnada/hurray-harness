import type { EventKind, HHEvent, Status } from './types.js'

const KINDS = new Set<EventKind>([
  'run.start', 'run.stage', 'run.end', 'phase', 'step.start', 'step.end', 'decision.open', 'decision.close', 'activity',
])
const STATUSES = new Set<Status>(['waiting', 'running', 'done', 'failed', 'blocked', 'skipped'])

const str = (x: unknown, max = 500): string | undefined =>
  typeof x === 'string' && x.length ? x.slice(0, max) : typeof x === 'number' ? String(x) : undefined

const num = (x: unknown): number | undefined => {
  const n = typeof x === 'string' ? Number(x.replace(/^#/, '')) : x
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

// Accepts anything a harness sends and returns a clean event, or an error string. Unknown keys are dropped,
// so a sender can never push prompts or file contents into the store by accident.
export function toEvent(raw: unknown, fallbackSource = 'manual'): HHEvent | string {
  if (!raw || typeof raw !== 'object') return 'event must be an object'
  const r = raw as Record<string, unknown>
  const kind = r.kind as EventKind
  if (!KINDS.has(kind)) return 'unknown kind: ' + String(r.kind)
  const ts = str(r.ts) && !Number.isNaN(Date.parse(String(r.ts))) ? new Date(String(r.ts)).toISOString() : new Date().toISOString()
  const status = STATUSES.has(r.status as Status) ? (r.status as Status) : undefined
  const agent = r.agent && typeof r.agent === 'object'
    ? (() => {
        const a = r.agent as Record<string, unknown>
        const role = str(a.role, 80)
        return role ? { role, model: str(a.model, 80), name: str(a.name, 80) } : undefined
      })()
    : typeof r.agent === 'string' ? { role: r.agent.slice(0, 80) } : undefined
  const tokens = r.tokens && typeof r.tokens === 'object'
    ? { used: num((r.tokens as Record<string, unknown>).used), budget: num((r.tokens as Record<string, unknown>).budget) }
    : undefined
  const d = r.decision && typeof r.decision === 'object' ? (r.decision as Record<string, unknown>) : undefined
  const decision = d && str(d.id) && str(d.title)
    ? { id: str(d.id, 200)!, title: str(d.title, 300)!, why: str(d.why, 500), recommendation: str(d.recommendation, 500), url: str(d.url, 500) }
    : undefined
  if ((kind === 'decision.open' || kind === 'decision.close') && !decision && !(kind === 'decision.close' && d && str(d.id))) {
    return 'decision events need decision.id and decision.title'
  }
  const files = Array.isArray(r.files) ? r.files.map((f) => str(f, 300)).filter((f): f is string => !!f).slice(0, 20) : undefined
  const e: HHEvent = {
    v: 1, ts, kind, source: str(r.source, 40) ?? fallbackSource,
    user: str(r.user, 80), machine: str(r.machine, 80), repo: str(r.repo, 200), run: str(r.run, 120), milestone: str(r.milestone, 120),
    mode: str(r.mode, 40), stage: str(r.stage, 40), phase: str(r.phase, 40), lane: str(r.lane, 40), ticket: num(r.ticket),
    title: str(r.title, 200), epic: num(r.epic), step: str(r.step, 40), agent, skill: str(r.skill, 80), status, attempt: num(r.attempt),
    detail: str(r.detail, 300), files, tokens, pr: num(r.pr), branch: str(r.branch, 200), session: str(r.session, 120),
    cwd: str(r.cwd, 500), tool: str(r.tool, 80),
    decision: decision ?? (d && str(d.id) ? { id: str(d.id, 200)!, title: str(d.title, 300) ?? '' } : undefined),
  }
  for (const k of Object.keys(e) as (keyof HHEvent)[]) if (e[k] === undefined) delete e[k]
  return e
}
