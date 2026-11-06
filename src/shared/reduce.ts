import type {
  ActivityItem, AgentState, Decision, HHEvent, LiveState, PhaseState, RowKind, RunState, Segment, StepState, TicketRow,
} from './types.js'

export const DEV_STEPS = ['plan', 'code', 'tests', 'check', 'pr', 'review', 'merge', 'close'] as const
export const QA_STEPS = ['qa-plan', 'cycle-open', 'run', 'second-look', 'file-bugs', 'verify', 'cycle-close', 'sign-off'] as const

export const STEP_LABELS: Record<string, string> = {
  plan: 'Plan', code: 'Code', tests: 'Tests and docs', check: 'Check', pr: 'PR and gate', review: 'Review', merge: 'Merge', close: 'Close or QA',
  'qa-plan': 'QA plan', 'cycle-open': 'Open cycle', run: 'Run tests', 'second-look': 'Second look', 'file-bugs': 'File bugs',
  verify: 'Verify fixes', 'cycle-close': 'Close cycle', 'sign-off': 'Sign-off',
}

// Default SDLC phases. A harness names its own skill for a phase with a 'phase' or 'run.stage' event.
export const PHASES: { name: string; skill?: string }[] = [
  { name: 'Discovery' }, { name: 'Design' }, { name: 'Architecture' }, { name: 'Plan' }, { name: 'Build' },
  { name: 'Promote' }, { name: 'Test' }, { name: 'Release' }, { name: 'Launch' },
]

// The harness's run stages land on these phases.
const STAGE_TO_PHASE: Record<string, string> = {
  discovery: 'Discovery', design: 'Design', architecture: 'Architecture', preflight: 'Plan', lead: 'Plan', plan: 'Plan', planning: 'Plan',
  build: 'Build', dev: 'Build', develop: 'Build', promote: 'Promote', test: 'Test', qa: 'Test', release: 'Release', launch: 'Launch',
}

const ROLE_STEP_HINT: Record<string, RowKind> = { tester: 'qa', 'qa-lead': 'qa', 'design-auditor': 'qa' }

function kindOfStep(step: string, role?: string): RowKind {
  if ((DEV_STEPS as readonly string[]).includes(step)) return 'dev'
  if ((QA_STEPS as readonly string[]).includes(step)) return 'qa'
  return (role && ROLE_STEP_HINT[role]) || 'other'
}

const FINISHED_STEPS = new Set(['close', 'sign-off', 'cycle-close'])
const MAX_ACTIVITY = 80
const MAX_SEGMENTS = 2000

export class LiveBuilder {
  private runs = new Map<string, RunState>()
  private rows = new Map<string, TicketRow>()
  private segments: Segment[] = []
  private decisions = new Map<string, Decision>()
  private phases = new Map<string, PhaseState>()
  private agents = new Map<string, AgentState>()
  private activity: ActivityItem[] = []
  private updatedAt = new Date(0).toISOString()

  constructor() {
    for (const p of PHASES) this.phases.set(p.name, { name: p.name, status: 'waiting', skill: p.skill })
  }

  apply(e: HHEvent): void {
    if (!e || e.v !== 1 || !e.kind || !e.ts) return
    if (e.ts > this.updatedAt) this.updatedAt = e.ts
    switch (e.kind) {
      case 'run.start': return this.runStart(e)
      case 'run.stage': return this.runStage(e)
      case 'run.end': return this.runEnd(e)
      case 'phase': return this.phase(e)
      case 'step.start': return this.step(e, 'start')
      case 'step.end': return this.step(e, 'end')
      case 'decision.open': return this.decisionOpen(e)
      case 'decision.close': return this.decisionClose(e)
      case 'activity': return this.act(e)
    }
  }

  private runStart(e: HHEvent) {
    if (!e.run) return
    this.runs.set(e.run, {
      run: e.run, repo: e.repo, milestone: e.milestone, mode: e.mode, stage: e.stage ?? 'Preflight',
      status: 'running', startedAt: e.ts, user: e.user,
    })
    if (e.stage) this.stageToPhase(e.stage, 'running', e.skill)
  }

  private runStage(e: HHEvent) {
    const r = e.run ? this.runs.get(e.run) : undefined
    const prev = r?.stage
    if (r && e.stage) r.stage = e.stage
    if (prev && prev !== e.stage) this.stageToPhase(prev, 'done')
    if (e.stage) this.stageToPhase(e.stage, 'running', e.skill)
  }

  private runEnd(e: HHEvent) {
    const r = e.run ? this.runs.get(e.run) : undefined
    if (!r) return
    r.status = 'ended'
    r.endedAt = e.ts
    if (r.stage) this.stageToPhase(r.stage, e.status === 'failed' ? 'failed' : 'done')
    for (const a of this.agents.values()) if (a.status === 'busy') { a.status = 'idle'; a.since = e.ts }
  }

  private stageToPhase(stage: string, status: PhaseState['status'], skill?: string) {
    const name = STAGE_TO_PHASE[stage.toLowerCase()]
    if (!name) return
    const p = this.phases.get(name)
    if (!p) return
    // A later phase never moves an earlier finished one backwards.
    if (p.status === 'done' && status === 'running') return
    p.status = status
    if (skill) p.skill = skill
  }

  private phase(e: HHEvent) {
    if (!e.phase) return
    const p = this.phases.get(e.phase) ?? { name: e.phase, status: 'waiting' as const }
    if (e.status) p.status = e.status
    if (e.skill) p.skill = e.skill
    if (e.agent) p.agent = e.agent.role
    if (e.detail) p.detail = e.detail
    this.phases.set(e.phase, p)
  }

  private rowFor(e: HHEvent, step: string): TicketRow | undefined {
    if (e.ticket == null) return undefined
    const key = (e.run ?? e.repo ?? '-') + ':' + e.ticket
    let row = this.rows.get(key)
    if (!row) {
      row = {
        key, run: e.run, repo: e.repo, ticket: e.ticket, kind: kindOfStep(step, e.agent?.role), steps: {},
        updatedAt: e.ts, finished: false,
      }
      this.rows.set(key, row)
    }
    if (e.title) row.title = e.title
    if (e.epic != null) row.epic = e.epic
    if (e.lane) row.lane = e.lane
    if (e.pr != null) row.pr = e.pr
    if (e.branch) row.branch = e.branch
    if (row.kind === 'other') row.kind = kindOfStep(step, e.agent?.role)
    row.updatedAt = e.ts
    return row
  }

  private step(e: HHEvent, phase: 'start' | 'end') {
    const step = e.step
    if (!step) return
    const row = this.rowFor(e, step)
    const laneKey = e.lane ?? (e.ticket != null ? '#' + e.ticket : e.agent?.role ?? 'agent')

    if (row) {
      const prev = row.steps[step]
      const s: StepState = prev ?? { step, status: 'waiting', files: [], attempt: 0 }
      if (phase === 'start') {
        // A step that starts again after it ended is a recode or rework attempt.
        s.attempt = e.attempt ?? (prev && prev.status !== 'running' ? s.attempt + 1 : Math.max(1, s.attempt))
        s.status = 'running'
        s.startedAt = e.ts
        s.endedAt = undefined
        s.files = []
      } else {
        s.status = e.status ?? 'done'
        s.endedAt = e.ts
        if (s.attempt === 0) s.attempt = e.attempt ?? 1
      }
      if (e.agent) s.agent = e.agent
      if (e.skill) s.skill = e.skill
      if (e.detail) s.detail = e.detail
      if (e.files?.length) s.files = [...new Set([...s.files, ...e.files])].slice(-20)
      if (e.tokens) s.tokens = { ...s.tokens, ...e.tokens }
      row.steps[step] = s
      if (phase === 'start' || s.status === 'running') row.current = step
      else if (row.current === step) row.current = undefined
      if (phase === 'end' && FINISHED_STEPS.has(step) && s.status === 'done') row.finished = true
    }

    // Swimlane segment
    if (phase === 'start') {
      this.segments.push({
        lane: laneKey, ticket: e.ticket, step, status: 'running', role: e.agent?.role, skill: e.skill, start: e.ts,
      })
      if (this.segments.length > MAX_SEGMENTS) this.segments.splice(0, this.segments.length - MAX_SEGMENTS)
    } else {
      for (let i = this.segments.length - 1; i >= 0; i--) {
        const g = this.segments[i]!
        if (g.lane === laneKey && g.step === step && g.ticket === e.ticket && !g.end) {
          g.end = e.ts
          g.status = e.status ?? 'done'
          break
        }
      }
    }

    // Agent roster
    if (e.agent) {
      const key = (e.run ?? '-') + ':' + (e.lane ?? '-') + ':' + e.agent.role
      const a: AgentState = this.agents.get(key) ?? { key, role: e.agent.role, status: 'idle', since: e.ts }
      a.role = e.agent.role
      if (e.agent.model) a.model = e.agent.model
      if (phase === 'start') {
        a.status = 'busy'
        a.ticket = e.ticket
        a.step = step
        a.skill = e.skill
      } else {
        a.status = 'idle'
      }
      a.since = e.ts
      this.agents.set(key, a)
    }
  }

  private decisionOpen(e: HHEvent) {
    if (!e.decision?.id) return
    this.decisions.set(e.decision.id, { ...e.decision, openedAt: e.ts, source: e.source, repo: e.repo, ticket: e.ticket })
  }

  private decisionClose(e: HHEvent) {
    if (e.decision?.id) this.decisions.delete(e.decision.id)
  }

  private act(e: HHEvent) {
    const detail = e.detail ?? e.tool ?? 'activity'
    this.activity.push({ ts: e.ts, source: e.source, session: e.session, ticket: e.ticket, tool: e.tool, detail })
    if (this.activity.length > MAX_ACTIVITY) this.activity.splice(0, this.activity.length - MAX_ACTIVITY)
    if (e.ticket == null) return
    // Attach "doing now" to the step that is running for this ticket.
    for (const row of this.rows.values()) {
      if (row.ticket !== e.ticket || (e.repo && row.repo && row.repo !== e.repo)) continue
      const s = row.current ? row.steps[row.current] : undefined
      if (!s || s.status !== 'running') continue
      s.detail = detail
      if (e.files?.length) s.files = [...new Set([...s.files, ...e.files])].slice(-20)
      row.updatedAt = e.ts
    }
  }

  snapshot(now = new Date()): LiveState {
    const cutoff = new Date(now.getTime() - 30 * 60 * 1000).toISOString()
    const rows = [...this.rows.values()]
      .filter((r) => !r.finished || r.updatedAt >= cutoff)
      .sort((a, b) => (a.lane ?? '~').localeCompare(b.lane ?? '~', undefined, { numeric: true }) || a.ticket - b.ticket)
    return {
      runs: [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
      rows,
      segments: this.segments.slice(),
      decisions: [...this.decisions.values()].sort((a, b) => a.openedAt.localeCompare(b.openedAt)),
      phases: [...this.phases.values()],
      agents: [...this.agents.values()].sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true })),
      activity: this.activity.slice(-40).reverse(),
      updatedAt: this.updatedAt,
    }
  }
}

export function reduce(events: HHEvent[], now?: Date): LiveState {
  const b = new LiveBuilder()
  for (const e of events) b.apply(e)
  return b.snapshot(now)
}
