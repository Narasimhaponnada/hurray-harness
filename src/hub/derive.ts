import { DEV_STEPS } from '../shared/reduce.js'
import type { ChangeRequest, GitSnapshot, Status, StepState, TicketRow, TicketWork, TrackerSnapshot, WorkItem, Worktree } from '../shared/types.js'
import { isBug, stageOf } from '../shared/work.js'

// Lanes without a harness. When nothing reports steps (hh step), each issue in flight still gets a
// row in the grid, built from what is already known:
//   the tracker: the issue's board status, its PR, the PR's checks, review and merge state
//   git:         the issue's worktree, commits ahead of the base, uncommitted changes
//   tool hooks:  the agent acting in that worktree, the skill its session runs, what it does now
// A ticket a harness reports on keeps the harness's row; these rows fill in the rest.

const WINDOW_MS = 24 * 3600_000 // a merged PR or closed issue stays on the grid for a day

interface Inputs {
  trackers: TrackerSnapshot[]
  git: GitSnapshot[]
  work: TicketWork[]
  repoOfGit: (snap: GitSnapshot) => string | undefined
  now: number
}

export function deriveRows(inp: Inputs): TicketRow[] {
  const rows: TicketRow[] = []
  for (const t of inp.trackers) {
    const trees = inp.git.filter((g) => !inp.repoOfGit(g) || inp.repoOfGit(g) === t.repo).flatMap((g) => g.worktrees)
    const tickets = new Set<number>()
    for (const i of t.items) {
      if (i.type === 'Epic') continue
      const stage = stageOf(i.status)
      const tree = trees.find((w) => w.ticket === i.number)
      const pr = prFor(i, t.changes)
      const work = inp.work.find((w) => w.ticket === i.number && (!w.repo || w.repo === t.repo))
      const recentWork = work && inp.now - Date.parse(work.at) < WINDOW_MS
      const open = i.state === 'open'
      const recentlyDone = !open && pr?.mergedAt && inp.now - Date.parse(pr.mergedAt) < WINDOW_MS
      const inFlight = open && (stage === 'working' || stage === 'review' || stage === 'qa' || stage === 'blocked' || !!tree || pr?.state === 'open' || recentWork)
      if (!inFlight && !recentlyDone) continue
      tickets.add(i.number)
      rows.push(row(t.repo, i, stage, pr, tree, recentWork ? work : undefined, inp.now))
    }
    // A worktree or PR for a ticket the tracker did not list (another milestone, or no issue): still a lane.
    for (const w of trees) {
      if (w.ticket == null || tickets.has(w.ticket)) continue
      const pr = t.changes.find((c) => c.ticket === w.ticket && c.state === 'open')
      if (!pr && !w.dirty && w.ahead === 0) continue
      tickets.add(w.ticket)
      const work = inp.work.find((x) => x.ticket === w.ticket && (!x.repo || x.repo === t.repo))
      const pseudo: WorkItem = { number: w.ticket, title: pr?.title ?? w.branch, type: 'Issue', state: 'open', status: 'In progress', labels: [], url: '', prs: [] }
      rows.push(row(t.repo, pseudo, 'working', pr, w, work && inp.now - Date.parse(work.at) < WINDOW_MS ? work : undefined, inp.now))
    }
  }
  return rows
}

function prFor(i: WorkItem, changes: ChangeRequest[]): ChangeRequest | undefined {
  const linked = i.prs.map((p) => changes.find((c) => c.number === p.number)).filter((c): c is ChangeRequest => !!c)
  const all = linked.length ? linked : changes.filter((c) => c.ticket === i.number)
  return all.find((c) => c.state === 'open') ?? all.find((c) => c.state === 'merged') ?? all[0]
}

function row(repo: string, i: WorkItem, stage: ReturnType<typeof stageOf>, pr: ChangeRequest | undefined, tree: Worktree | undefined, work: TicketWork | undefined, now: number): TicketRow {
  const st: Record<string, Status> = Object.fromEntries(DEV_STEPS.map((k) => [k, 'waiting' as Status]))
  const merged = pr?.state === 'merged'
  const prReady = !!pr && pr.state !== 'closed' && !pr.draft
  const started = stage !== 'todo' || !!tree || !!pr || !!work

  if (started) st.plan = 'done'
  // Code: in a worktree or on a draft PR until the PR is ready.
  if (prReady || merged) st.code = 'done'
  else if (started) st.code = 'running'
  // Tests and checks: what the PR's checks say.
  if (pr && !pr.draft) {
    st.tests = 'done'
    st.check = pr.checks === 'success' ? 'done' : pr.checks === 'failure' ? 'failed' : pr.checks === 'pending' ? 'running' : merged ? 'done' : 'skipped'
    st.pr = 'done'
  } else if (pr?.draft) st.pr = 'running'
  // Review: requested changes fail it; approved, or merged, finish it. It starts once checks pass
  // (or the board says review), never while they fail.
  if (merged || pr?.review === 'approved') st.review = 'done'
  else if (pr?.review === 'changes') st.review = 'failed'
  else if (prReady && pr!.checks !== 'failure' && (stage === 'review' || pr!.checks === 'success')) st.review = 'running'
  // Merge: a conflict blocks it; merged is done; approved and green is running (ready to merge).
  if (merged) st.merge = 'done'
  else if (pr?.mergeable === 'conflicting') st.merge = 'failed'
  else if (prReady && pr!.review === 'approved' && pr!.checks === 'success') st.merge = 'running'
  // Close: the issue closed is done; merged and still open is in QA.
  if (i.state === 'closed') st.close = 'done'
  else if (merged || stage === 'qa') st.close = 'running'

  // Recode loop: checks failed or changes were requested, and an agent is at work in the worktree
  // again, so the ticket is back in Code.
  const live = work && now - Date.parse(work.at) < 30 * 60_000 ? work : undefined
  let attempt = 1
  if ((st.check === 'failed' || st.review === 'failed') && live && !merged) {
    st.code = 'running'
    attempt = 2
  }

  // The furthest step reached, so a blocked issue shows where it stopped; in a recode loop, Code.
  const order = [...DEV_STEPS]
  let current = attempt > 1 ? 'code' : order.findLast((k) => st[k] === 'running' || st[k] === 'failed') ?? order.findLast((k) => st[k] === 'done')
  if (stage === 'blocked' && current) st[current] = 'blocked'
  if (i.state === 'closed') current = 'close'

  const steps: Record<string, StepState> = {}
  for (const k of order) steps[k] = { step: k, status: st[k]!, files: [], attempt: k === 'code' ? attempt : 1 }
  // What the agent is doing now goes on the step that is running.
  const at = current && (st[current] === 'running' || st[current] === 'blocked') ? steps[current] : undefined
  if (at) {
    if (live) {
      at.agent = { role: live.agent ?? live.source }
      at.skill = live.skill
      at.detail = live.detail
      at.startedAt = live.since
    } else if (tree?.lastCommitAt && current === 'code') {
      at.detail = (tree.dirty ? 'Uncommitted changes · ' : '') + `${tree.ahead} commit${tree.ahead === 1 ? '' : 's'} ahead`
    }
  }
  if (pr && !at?.detail) {
    const s = steps[current ?? 'pr']
    if (s && (s.status === 'running' || s.status === 'failed')) {
      s.detail = s.step === 'check' ? (pr.checks === 'failure' ? 'Checks failed on PR #' + pr.number : 'Checks running on PR #' + pr.number)
        : s.step === 'merge' ? (pr.mergeable === 'conflicting' ? 'Merge conflict on PR #' + pr.number : 'Approved and green: ready to merge')
        : s.step === 'review' ? (pr.review === 'changes' ? 'Changes requested on PR #' + pr.number : 'Waiting for review on PR #' + pr.number)
        : s.step === 'close' ? 'Merged; waiting for QA or close'
        : undefined
    }
  }

  return {
    key: 'gh:' + repo + '#' + i.number,
    derived: true,
    repo,
    ticket: i.number,
    title: (isBug(i) ? 'Bug: ' : '') + i.title,
    epic: i.epic,
    lane: tree ? laneName(tree) : undefined,
    kind: 'dev',
    steps,
    current,
    pr: pr?.number,
    branch: tree?.branch ?? pr?.head,
    updatedAt: work?.at ?? pr?.updatedAt ?? i.updatedAt ?? new Date(now).toISOString(),
    finished: i.state === 'closed',
  }
}

// The worktree's folder name, shortened: lanes are often named after their folder (lane-3, wt-42).
function laneName(w: Worktree): string {
  const base = w.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? w.branch
  return base.length > 12 ? base.slice(0, 11) + '…' : base
}
