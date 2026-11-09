import type { ChangeRequest, TrackerSnapshot, WorkItem } from './types.js'

// The tracker's work in flight, for the terminal and Claude Code views: what is being worked on,
// reviewed, tested or blocked on GitHub, with its PR. Shown with or without agent lanes.

export type Stage = 'blocked' | 'working' | 'review' | 'qa' | 'todo' | 'done'

// Project boards name their columns freely ("In progress", "Doing", "Todo"), so match loosely.
export function stageOf(status: string): Stage {
  const s = status.toLowerCase()
  if (/block|need|wait|hold/.test(s)) return 'blocked'
  if (/qa|test|verif|validat/.test(s)) return 'qa'
  if (/review/.test(s)) return 'review'
  if (/progress|doing|develop|active|working|started|wip/.test(s)) return 'working'
  if (/done|closed|complete|shipped|merged|released/.test(s)) return 'done'
  return 'todo'
}

export const isBug = (i: WorkItem) => /bug|defect/i.test(i.type) || i.labels.some((l) => /(^|[:/ ])(bug|defect)s?$/i.test(l))

export interface WorkRow {
  number: number
  title: string
  bug: boolean
  stage: Stage
  status: string
  who?: string // first assignee
  pr?: { number: number; checks: ChangeRequest['checks']; mergeable: ChangeRequest['mergeable']; draft: boolean }
  updatedAt?: string
}

export interface WorkSummary {
  repo: string
  rows: WorkRow[] // in flight, most urgent first
  counts: Record<Exclude<Stage, 'done' | 'todo'>, number>
  bugsOpen: number
  bugsNotStarted: WorkRow[]
}

const ORDER: Record<Stage, number> = { blocked: 0, working: 1, review: 2, qa: 3, todo: 4, done: 5 }

export function workInFlight(t: TrackerSnapshot): WorkSummary {
  const open = t.items.filter((i) => i.state === 'open' && i.type !== 'Epic')
  const row = (i: WorkItem): WorkRow => {
    const ref = i.prs.find((p) => p.state === 'open') ?? i.prs[0]
    const cr = ref ? t.changes.find((c) => c.number === ref.number) : t.changes.find((c) => c.ticket === i.number && c.state === 'open')
    return {
      number: i.number, title: i.title, bug: isBug(i), stage: stageOf(i.status), status: i.status, who: i.assignees?.[0], updatedAt: i.updatedAt,
      pr: cr ? { number: cr.number, checks: cr.checks, mergeable: cr.mergeable, draft: cr.draft } : undefined,
    }
  }
  const rows = open.map(row)
  const active = rows
    .filter((r) => r.stage !== 'todo' && r.stage !== 'done')
    .sort((a, b) => ORDER[a.stage] - ORDER[b.stage] || Number(b.bug) - Number(a.bug) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  const count = (st: Stage) => active.filter((r) => r.stage === st).length
  return {
    repo: t.repo,
    rows: active,
    counts: { blocked: count('blocked'), working: count('working'), review: count('review'), qa: count('qa') },
    bugsOpen: rows.filter((r) => r.bug).length,
    bugsNotStarted: rows.filter((r) => r.bug && r.stage === 'todo').sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')),
  }
}

export const STAGE_WORD: Record<Stage, string> = { blocked: 'blocked', working: 'in progress', review: 'in review', qa: 'in QA', todo: 'to do', done: 'done' }
