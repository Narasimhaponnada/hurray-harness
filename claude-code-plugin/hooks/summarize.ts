import type { Cell, LaneRow, Summary } from '../types'

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
    step: cur?.step ? STEP_LABEL[cur.step] ?? cur.step : undefined,
    agent: cur?.agent?.role ?? builder?.role,
    model: cur?.agent?.model ?? builder?.model,
    skill: cur?.skill,
    doing: cur?.status === 'running' ? cur?.detail : undefined,
    attempt: Number(cur?.attempt ?? 1),
  }
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
        return { branch: String(w.branch), ahead: Number(w.ahead ?? 0), behind: Number(w.behind ?? 0), pr: pr?.number, checks: pr?.checks, conflict: pr?.mergeable === 'conflicting' }
      }),
  )
  return {
    ok: true, at: now, url,
    repo: tracker?.repo ?? run?.repo,
    milestone: tracker?.milestone?.title ?? run?.milestone,
    stage: run?.status === 'running' ? run?.stage : undefined,
    done: Number(board['Done'] ?? 0),
    total,
    busy: rows.filter((r) => r.current && r.steps?.[r.current]?.status === 'running').length,
    decisions: (live.decisions ?? []).slice(0, 10).map((d: Json) => ({ id: String(d.id), title: String(d.title ?? ''), why: d.why, url: d.url })),
    build: rows.filter((r) => r.kind !== 'qa').map((r) => lane(r, BUILD_STEPS)),
    test: rows.filter((r) => r.kind === 'qa').map((r) => lane(r, TEST_STEPS)),
    worktrees,
  }
}

export function statusLine(s: Summary | null): string {
  if (!s) return 'lanes · connecting'
  if (!s.ok) return 'lanes · hub offline (run hh start)'
  const parts = ['lanes']
  if (s.stage) parts.push(s.stage)
  parts.push(`${s.busy} busy`)
  if (s.decisions.length) parts.push(`${s.decisions.length} need you`)
  if (s.total) parts.push(`${s.done}/${s.total} done`)
  return parts.join(' · ')
}

export const GLYPH: Record<Cell, string> = { done: '✓', running: '●', failed: '✗', blocked: '!', skipped: '–', waiting: '·' }
