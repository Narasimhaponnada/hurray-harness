import type { AgentRow, Cell, GhRow, GhStage, GitHubNow, LaneRow, PaneView, Summary } from '../types'

// Turns the hub's /api/state snapshot into the small summary the plugin draws. Pure, so it is tested alone.

export const BUILD_STEPS = ['plan', 'code', 'tests', 'check', 'pr', 'review', 'merge', 'close']
export const TEST_STEPS = ['qa-plan', 'cycle-open', 'run', 'second-look', 'file-bugs', 'verify', 'cycle-close', 'sign-off']
export const STEP_LABEL: Record<string, string> = {
  plan: 'plan', code: 'code', tests: 'tests', check: 'check', pr: 'PR', review: 'review', merge: 'merge', close: 'close',
  'qa-plan': 'QA plan', 'cycle-open': 'open cycle', run: 'run tests', 'second-look': 'second look', 'file-bugs': 'file bugs',
  verify: 'verify', 'cycle-close': 'close cycle', 'sign-off': 'sign-off',
}

type Json = Record<string, any>
const CELLS: Cell[] = ['done', 'running', 'failed', 'blocked', 'skipped', 'waiting']
const cell = (s?: string): Cell => (CELLS.includes(s as Cell) ? (s as Cell) : 'waiting')

const ROLE: Record<string, string> = { 'associate-developer': 'assoc dev', 'ui-aligner': 'ui aligner', 'design-auditor': 'design aud', 'qa-lead': 'QA lead', 'release-lead': 'rel lead' }
const WORD: Record<string, string> = { done: 'done', running: 'working', failed: 'failed', blocked: 'blocked', waiting: '', skipped: 'none' }

function words(step: string, st: Json | undefined, pr?: number): [string, string] {
  if (!st) return ['–', '']
  let top = WORD[st.status] ?? String(st.status)
  const files: string[] = st.files ?? []
  if (st.status === 'running' && Number(st.attempt) > 1) top = 'recode ' + st.attempt
  else if (st.status === 'done' && step === 'pr' && pr) top = '#' + pr
  else if (st.status === 'done' && step === 'tests') top = files.some((f) => /adr/i.test(f)) ? 'ADR' : files.some((f) => /(^|\/)docs?\//.test(f) || f.endsWith('.md')) ? 'docs' : 'tests'
  const role: string | undefined = st.agent?.role
  return [top, st.status === 'skipped' || !role ? '' : ROLE[role] ?? role]
}

function lane(r: Json, steps: string[]): LaneRow {
  const stepMap: Json = r.steps ?? {}
  const cur: Json | undefined = (r.current && stepMap[r.current]) || Object.values(stepMap).at(-1)
  const builder = ['code', 'tests', 'run', 'verify', 'qa-plan'].map((s) => stepMap[s]?.agent).find((a) => a && a.role !== 'coordinator')
  return {
    key: String(r.key ?? r.ticket),
    lane: r.lane,
    ticket: Number(r.ticket),
    title: r.title,
    kind: r.kind === 'qa' ? 'test' : 'build',
    cells: steps.map((s) => (stepMap[s] ? cell(stepMap[s].status) : 'waiting')),
    words: steps.map((s) => words(s, stepMap[s], r.pr)),
    step: cur?.step ? STEP_LABEL[cur.step] ?? cur.step : undefined,
    agent: cur?.agent?.role ?? builder?.role,
    model: cur?.agent?.model ?? builder?.model,
    skill: cur?.skill,
    doing: cur?.status === 'running' ? cur?.detail : undefined,
    attempt: Number(cur?.attempt ?? 1),
    since: cur?.status === 'running' && cur?.startedAt ? Date.parse(cur.startedAt) : undefined,
    used: cur?.status === 'running' ? cur?.tokens?.used : undefined,
    budget: cur?.status === 'running' ? cur?.tokens?.budget : undefined,
  }
}

function agentsOf(live: Json): { agents: AgentRow[]; idle: { role: string; lanes: string[] }[] } {
  const laneOf = (key: string) => { const l = String(key).split(':').at(-2); return l && l !== '-' ? l : undefined }
  const agents: AgentRow[] = []
  const idle = new Map<string, string[]>()
  for (const a of (live.agents ?? []) as Json[]) {
    const lane = laneOf(a.key)
    if (a.status !== 'busy') { idle.set(a.role, [...(idle.get(a.role) ?? []), ...(lane ? [lane] : [])]); continue }
    const row = (live.rows ?? []).find((r: Json) => r.ticket === a.ticket && (!lane || r.lane === lane))
    const st: Json | undefined = a.step ? row?.steps?.[a.step] : undefined
    agents.push({
      lane, role: String(a.role), model: a.model, skill: a.skill, ticket: a.ticket, step: a.step ? STEP_LABEL[a.step] ?? a.step : undefined,
      attempt: Number(st?.attempt ?? 1), since: Date.parse(a.since), doing: st?.detail, used: st?.tokens?.used, budget: st?.tokens?.budget,
    })
  }
  return { agents, idle: [...idle].map(([role, lanes]) => ({ role, lanes })) }
}

// Project boards name their columns freely ("In progress", "Doing", "Todo"), so match loosely.
export function stageOf(status: string): GhStage | 'todo' | 'done' {
  const s = status.toLowerCase()
  if (/block|need|wait|hold/.test(s)) return 'blocked'
  if (/qa|test|verif|validat/.test(s)) return 'qa'
  if (/review/.test(s)) return 'review'
  if (/progress|doing|develop|active|working|started|wip/.test(s)) return 'working'
  if (/done|closed|complete|shipped|merged|released/.test(s)) return 'done'
  return 'todo'
}

const ORDER: Record<string, number> = { blocked: 0, working: 1, review: 2, qa: 3 }

export function githubNow(tracker: Json | undefined, inGrid: Set<number> = new Set()): GitHubNow | undefined {
  if (!tracker?.items) return undefined
  const changes: Json[] = tracker.changes ?? []
  const open: Json[] = tracker.items.filter((i: Json) => i.state === 'open' && i.type !== 'Epic')
  const bug = (i: Json) => /bug|defect/i.test(String(i.type ?? '')) || (i.labels ?? []).some((l: string) => /(^|[:/ ])(bug|defect)s?$/i.test(l))
  const rows: (GhRow & { at: string })[] = []
  const notStarted: Json[] = []
  for (const i of open) {
    const st = stageOf(String(i.status ?? ''))
    if (st === 'todo') { if (bug(i)) notStarted.push(i); continue }
    if (st === 'done') continue
    const ref = (i.prs ?? []).find((p: Json) => p.state === 'open') ?? i.prs?.[0]
    const cr = ref ? changes.find((c) => c.number === ref.number) : changes.find((c) => c.ticket === i.number && c.state === 'open')
    rows.push({ number: i.number, title: String(i.title ?? ''), bug: bug(i), stage: st, pr: cr?.number, checks: cr?.checks, conflict: cr?.mergeable === 'conflicting', who: i.assignees?.[0], at: String(i.updatedAt ?? '') })
  }
  rows.sort((a, b) => ORDER[a.stage]! - ORDER[b.stage]! || Number(b.bug) - Number(a.bug) || b.at.localeCompare(a.at))
  const n = (st: GhStage) => rows.filter((r) => r.stage === st).length
  const bugs = open.filter(bug).length
  const summary = [n('working') && `${n('working')} in progress`, n('review') && `${n('review')} in review`, n('qa') && `${n('qa')} in QA`, n('blocked') && `${n('blocked')} blocked`, `${bugs} open bug${bugs === 1 ? '' : 's'}`].filter(Boolean).join(' · ')
  // Tickets already in the grid are not listed again; the summary still counts them.
  const listed = rows.filter((r) => !inGrid.has(r.number))
  return { summary, rows: listed.slice(0, 8).map(({ at: _, ...r }) => r), more: Math.max(0, listed.length - 8), bugsNotStarted: notStarted.slice(0, 5).map((i) => `#${i.number} ${i.title}`) }
}

export function summarize(state: Json, url: string, now: number): Summary {
  const live: Json = state.live ?? {}
  const tracker: Json | undefined = state.trackers?.[0]
  const board: Record<string, number> = tracker?.board ?? {}
  const total = Object.values(board).reduce((a, b) => a + Number(b || 0), 0)
  const run: Json | undefined = (live.runs ?? []).find((r: Json) => r.status === 'running') ?? live.runs?.[0]
  const rows: Json[] = (live.rows ?? []).filter((r: Json) => !r.finished)
  const changes: Json[] = tracker?.changes ?? []
  const worktrees = (state.git ?? []).flatMap((g: Json) =>
    (g.worktrees ?? [])
      .filter((w: Json) => w.ticket != null)
      .map((w: Json) => {
        const pr = changes.find((c) => c.head === w.branch && c.state === 'open') ?? changes.find((c) => c.head === w.branch)
        const lane = (live.rows ?? []).find((r: Json) => r.ticket === w.ticket)?.lane
        return { branch: String(w.branch), ahead: Number(w.ahead ?? 0), behind: Number(w.behind ?? 0), pr: pr?.number, checks: pr?.checks, conflict: pr?.mergeable === 'conflicting', merged: pr?.state === 'merged', dirty: !!w.dirty, lane, lastCommitAt: w.lastCommitAt ? Date.parse(w.lastCommitAt) : undefined }
      }),
  )
  const decisions: Json[] = live.decisions ?? []
  const approval = (d: Json) => String(d.id).endsWith(':approval')
  const phasesIn: Json[] = live.phases ?? []
  const gated = new Set<string>()
  if (decisions.some(approval)) {
    const nxt = phasesIn.find((p) => (p.name === 'Promote' || p.name === 'Release') && p.status !== 'done')
    if (nxt) gated.add(nxt.name)
  }
  if (decisions.some((d) => !approval(d))) for (const p of phasesIn) if (p.status === 'running') gated.add(p.name)
  const PW: Record<string, string> = { done: 'done', running: 'now', waiting: 'waiting', failed: 'failed', blocked: 'waits on you', skipped: 'skipped' }
  // Only once a harness reports phases: a row of boxes all saying "waiting" tells you nothing.
  const phases = (phasesIn.some((p) => p.status !== 'waiting') ? phasesIn : []).map((p) => ({
    name: String(p.name), tone: (gated.has(p.name) ? 'blocked' : cell(p.status)) as Cell,
    word: gated.has(p.name) ? 'waits on you' : PW[p.status] ?? String(p.status), skill: p.skill,
  }))
  return {
    ok: true, at: now, url, phases,
    base: state.git?.[0]?.base,
    baseHead: state.git?.[0]?.baseHead,
    segments: (live.segments ?? [])
      .filter((g: Json) => Date.parse(g.end ?? new Date(now).toISOString()) >= now - 240 * 60_000)
      .slice(-300)
      .map((g: Json) => ({ lane: String(g.lane), role: g.role, step: String(g.step), status: cell(g.status), start: Date.parse(g.start), end: g.end ? Date.parse(g.end) : undefined, ticket: g.ticket })),
    ...agentsOf(live),
    repo: tracker?.repo ?? run?.repo,
    milestone: tracker?.milestone?.title ?? run?.milestone,
    stage: run?.status === 'running' ? run?.stage : undefined,
    done: Object.entries(board).reduce((n, [k, v]) => n + (stageOf(k) === 'done' ? Number(v) : 0), 0),
    total,
    busy: rows.filter((r) => r.current && r.steps?.[r.current]?.status === 'running').length,
    decisions: (live.decisions ?? []).slice(0, 10).map((d: Json) => ({ id: String(d.id), title: String(d.title ?? ''), why: d.why, url: d.url })),
    build: rows.filter((r) => r.kind !== 'qa').map((r) => lane(r, BUILD_STEPS)),
    test: rows.filter((r) => r.kind === 'qa').map((r) => lane(r, TEST_STEPS)),
    worktrees,
    github: githubNow(tracker, new Set((live.rows ?? []).map((r: Json) => Number(r.ticket)))),
  }
}

export function statusLine(s: Summary | null): string {
  if (!s) return 'lanes · connecting'
  if (!s.ok) return s.starting ? 'lanes · starting the hub' : 'lanes · hub offline (run hh start)'
  const parts = ['lanes']
  if (s.stage) parts.push(s.stage)
  parts.push(`${s.busy} busy`)
  if (s.decisions.length) parts.push(`${s.decisions.length} need you`)
  if (s.total) parts.push(`${s.done}/${s.total} done`)
  return parts.join(' · ')
}

export const GLYPH: Record<Cell, string> = { done: '✓', running: '●', failed: '✗', blocked: '!', skipped: '–', waiting: '·' }

// ---------- rotation: the pane's views take turns in the same space ----------

export const VIEWS: readonly PaneView[] = ['now', 'flow']
export const VIEW_NAME: Record<PaneView, string> = { now: 'now', flow: 'flow' }

export function availableViews(s: Summary): PaneView[] {
  return s.segments.length || s.worktrees.length ? ['now', 'flow'] : ['now']
}

export function rotation(startMs: number, nowMs: number, periodSec: number, list: readonly PaneView[]): { view: PaneView; next: PaneView; remainingSec: number } {
  const views = list.length ? list : VIEWS
  if (periodSec <= 0) return { view: views[0]!, next: views[0]!, remainingSec: 0 }
  const elapsed = Math.max(0, nowMs - startMs) / 1000
  const slot = Math.floor(elapsed / periodSec)
  return { view: views[slot % views.length]!, next: views[(slot + 1) % views.length]!, remainingSec: Math.ceil(periodSec - (elapsed % periodSec)) }
}

export const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`
