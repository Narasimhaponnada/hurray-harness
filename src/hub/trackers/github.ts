import type { ChangeRequest, Epic, TrackerSnapshot, WorkItem } from '../../shared/types.js'
import { DEFAULT_LABELS, type LabelRules } from '../config.js'
import { run } from '../exec.js'
import { ticketFromBranch } from '../git.js'
import type { TrackerAdapter } from './index.js'

// GitHub through the gh CLI, so it uses the person's own sign-in and never stores a token.
// Read-only: only GraphQL queries, no mutations.

const ISSUE_FIELDS_FULL = `
  number title state url updatedAt
  assignees(first: 3) { nodes { login } }
  issueType { name }
  parent { number }
  labels(first: 20) { nodes { name } }
  projectItems(first: 5) { nodes { fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } }
  closedByPullRequestsReferences(first: 5, includeClosedPrs: true) { nodes { number state url } }`

const ISSUE_FIELDS_LITE = `
  number title state url updatedAt
  assignees(first: 3) { nodes { login } }
  labels(first: 20) { nodes { name } }
  closedByPullRequestsReferences(first: 5, includeClosedPrs: true) { nodes { number state url } }`

const MILESTONES = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    milestones(states: OPEN, first: 30, orderBy: { field: DUE_DATE, direction: ASC }) {
      nodes { number title dueOn url open: issues(states: OPEN) { totalCount } closed: issues(states: CLOSED) { totalCount } }
    }
  }
}`

const issuesQuery = (fields: string) => `query($owner: String!, $name: String!, $ms: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, after: $after, filterBy: { milestoneNumber: $ms }, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${fields} }
    }
  }
}`

const PULLS = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    open: pullRequests(states: OPEN, first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ...pr } }
    merged: pullRequests(states: MERGED, first: 20, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ...pr } }
  }
}
fragment pr on PullRequest {
  number title headRefName baseRefName isDraft mergeable url state
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`

type Json = Record<string, any>

async function gql(query: string, vars: Record<string, string | number | string[] | number[] | undefined>): Promise<Json> {
  const args = ['api', 'graphql', '-f', 'query=' + query]
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) continue
    if (Array.isArray(v)) for (const x of v) args.push('-F', k + '[]=' + x)
    else args.push(typeof v === 'number' ? '-F' : '-f', k + '=' + v)
  }
  const r = await run('gh', args, { timeoutMs: 45_000 })
  if (r.code) throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-3).join(' '))
  const out = JSON.parse(r.stdout) as Json
  if (out.errors?.length) throw new Error(out.errors.map((e: Json) => e.message).join('; '))
  return out.data as Json
}

const lower = (s?: string) => (s ?? '').toLowerCase()

// Board status when the item is not on a project board: derived from state, labels and PRs.
export function deriveStatus(state: string, labels: string[], prs: { state: string }[], projectStatus?: string, rules: LabelRules = DEFAULT_LABELS): string {
  if (projectStatus) return projectStatus
  if (lower(state) === 'closed') return 'Done'
  const ls = labels.map(lower)
  const has = (list: string[]) => list.some((l) => ls.includes(l.toLowerCase()))
  if (has(rules.blocked) || has(rules.decision)) return 'Blocked'
  if (has(rules.qa)) return 'QA Validation'
  if (prs.some((p) => lower(p.state) === 'open')) return 'In Review'
  if (has(rules.inProgress)) return 'In Progress'
  if (has(rules.ready)) return 'Ready'
  return 'Backlog'
}

function typeOf(n: Json, labels: string[]): string {
  if (n.issueType?.name) return n.issueType.name
  const t = labels.find((l) => /^type:/i.test(l))
  if (t) return t.slice(5).replace(/^\w/, (c) => c.toUpperCase())
  if (labels.some((l) => lower(l) === 'epic')) return 'Epic'
  if (labels.some((l) => lower(l) === 'bug')) return 'Bug'
  return 'Issue'
}

export function toWorkItem(n: Json, rules: LabelRules = DEFAULT_LABELS): WorkItem {
  const labels: string[] = (n.labels?.nodes ?? []).map((l: Json) => l.name)
  const prs = (n.closedByPullRequestsReferences?.nodes ?? []).map((p: Json) => ({ number: p.number, state: lower(p.state), url: p.url }))
  const projectStatus = (n.projectItems?.nodes ?? []).map((p: Json) => p?.fieldValueByName?.name).find(Boolean)
  return {
    number: n.number, title: n.title, type: typeOf(n, labels), state: lower(n.state) === 'closed' ? 'closed' : 'open',
    status: deriveStatus(n.state, labels, prs, projectStatus, rules), labels, epic: n.parent?.number, url: n.url, prs,
    assignees: (n.assignees?.nodes ?? []).map((a: Json) => a.login).filter(Boolean),
    updatedAt: n.updatedAt,
  }
}

export function epicsFrom(items: WorkItem[], parents: Map<number, { title: string; url: string }>): Epic[] {
  const epics = new Map<number, Epic>()
  for (const i of items) if (i.type === 'Epic') epics.set(i.number, { number: i.number, title: i.title, url: i.url, total: 0, done: 0, active: 0, blocked: 0 })
  for (const i of items) {
    if (i.epic == null || i.type === 'Epic') continue
    const p = parents.get(i.epic)
    const e = epics.get(i.epic) ?? { number: i.epic, title: p?.title ?? 'Epic #' + i.epic, url: p?.url ?? '', total: 0, done: 0, active: 0, blocked: 0 }
    e.total++
    if (i.status === 'Done' || i.state === 'closed') e.done++
    else if (i.status === 'Blocked') e.blocked++
    else if (['In Progress', 'In Review', 'QA Validation'].includes(i.status)) e.active++
    epics.set(i.epic, e)
  }
  return [...epics.values()].filter((e) => e.total > 0).sort((a, b) => a.number - b.number)
}

export function toChange(n: Json): ChangeRequest {
  const rollup = lower(n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state)
  const checks = rollup === 'success' ? 'success' : rollup === 'failure' || rollup === 'error' ? 'failure' : rollup ? 'pending' : 'none'
  const m = lower(n.mergeable)
  return {
    number: n.number, title: n.title, head: n.headRefName, base: n.baseRefName,
    state: lower(n.state) === 'merged' ? 'merged' : lower(n.state) === 'closed' ? 'closed' : 'open', draft: !!n.isDraft,
    mergeable: m === 'mergeable' ? 'mergeable' : m === 'conflicting' ? 'conflicting' : 'unknown', checks, url: n.url,
    ticket: ticketFromBranch(n.headRefName ?? ''),
  }
}

export class GitHubAdapter implements TrackerAdapter {
  readonly provider = 'github' as const
  private owner: string
  private name: string
  private lite = false

  constructor(readonly repo: string, private milestoneWanted?: string, private rules: LabelRules = DEFAULT_LABELS) {
    const [o, n] = repo.split('/')
    if (!o || !n) throw new Error('GitHub repo must be owner/name, got ' + repo)
    this.owner = o
    this.name = n
  }

  async snapshot(): Promise<TrackerSnapshot> {
    const fetchedAt = new Date().toISOString()
    const base: TrackerSnapshot = { provider: 'github', repo: this.repo, board: {}, items: [], epics: [], changes: [], fetchedAt }
    try {
      const ms = await this.pickMilestone()
      const [items, changes] = await Promise.all([ms ? this.issues(String(ms.number)) : Promise.resolve([] as WorkItem[]), this.pulls()])
      const parents = new Map<number, { title: string; url: string }>()
      const missing = [...new Set(items.map((i) => i.epic).filter((n): n is number => n != null && !items.some((x) => x.number === n)))]
      for (const n of missing.slice(0, 30)) {
        try {
          const d = await gql(`query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { issue(number: $n) { title url } } }`, { owner: this.owner, name: this.name, n })
          if (d.repository?.issue) parents.set(n, d.repository.issue)
        } catch { /* an epic we cannot read just shows its number */ }
      }
      const board: Record<string, number> = {}
      for (const i of items) if (i.type !== 'Epic') board[i.status] = (board[i.status] ?? 0) + 1
      return {
        ...base, items, changes, board, epics: epicsFrom(items, parents),
        milestone: ms ? { title: ms.title, dueOn: ms.dueOn ?? undefined, url: ms.url, open: ms.open.totalCount, closed: ms.closed.totalCount } : undefined,
      }
    } catch (e) {
      return { ...base, error: (e as Error).message }
    }
  }

  private async pickMilestone(): Promise<Json | undefined> {
    const d = await gql(MILESTONES, { owner: this.owner, name: this.name })
    const list: Json[] = d.repository?.milestones?.nodes ?? []
    const want = this.milestoneWanted
    if (want) return list.find((m) => m.title === want || m.title.startsWith(want + ' ') || m.title.startsWith(want + '—') || String(m.number) === want)
    // The earliest open milestone that still has open work.
    return list.find((m) => m.open.totalCount > 0) ?? list[0]
  }

  private async issues(ms: string): Promise<WorkItem[]> {
    const out: WorkItem[] = []
    let after: string | undefined
    for (let page = 0; page < 5; page++) {
      let d: Json
      try {
        d = await gql(issuesQuery(this.lite ? ISSUE_FIELDS_LITE : ISSUE_FIELDS_FULL), { owner: this.owner, name: this.name, ms, after })
      } catch (e) {
        if (this.lite) throw e
        this.lite = true // older GitHub Enterprise without issue types, sub-issues or projects
        page--
        continue
      }
      const conn = d.repository?.issues
      for (const n of conn?.nodes ?? []) out.push(toWorkItem(n, this.rules))
      if (!conn?.pageInfo?.hasNextPage) break
      after = conn.pageInfo.endCursor
    }
    return out
  }

  private async pulls(): Promise<ChangeRequest[]> {
    const d = await gql(PULLS, { owner: this.owner, name: this.name })
    return [...(d.repository?.open?.nodes ?? []), ...(d.repository?.merged?.nodes ?? [])].map(toChange)
  }
}

