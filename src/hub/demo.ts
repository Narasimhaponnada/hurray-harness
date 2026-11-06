import type { ChangeRequest, GitSnapshot, HHEvent, TrackerSnapshot, WorkItem } from '../shared/types.js'
import type { Hub } from './hub.js'

// Demo mode: a made-up milestone that plays out in a few minutes, so the dashboard can be tried
// with no repo, no GitHub and no running agents. Nothing here touches the network or the disk.

const REPO = 'demo/acme-app'
const RUN = 'demo-run'

interface Plan {
  lane: string
  ticket: number
  title: string
  epic: number
  ui?: boolean
  docs?: boolean
  role: string
  model: string
  failAt?: 'check'
  files: string[]
}

const PLANS: Plan[] = [
  { lane: 'L1', ticket: 42, title: 'Cursor pagination', epic: 30, role: 'developer', model: 'sonnet', files: ['src/api/list.ts', 'src/api/cursor.ts', 'tests/api/list.spec.ts'] },
  { lane: 'L2', ticket: 51, title: 'Settings screen', epic: 31, ui: true, role: 'designer', model: 'opus', files: ['src/ui/settings/Settings.vue', 'tests/ui/settings.spec.ts'] },
  { lane: 'L3', ticket: 47, title: 'Auth token refresh', epic: 30, role: 'developer', model: 'opus', failAt: 'check', files: ['src/auth/refresh.ts', 'tests/auth/refresh.spec.ts'] },
  { lane: 'L4', ticket: 59, title: 'API guide', epic: 31, docs: true, role: 'associate-developer', model: 'haiku', files: ['docs/api/guide.md'] },
  { lane: 'L1', ticket: 64, title: 'Plan limits', epic: 32, role: 'developer', model: 'sonnet', files: ['src/billing/limits.ts', 'tests/billing/limits.spec.ts'] },
]

const BUDGET: Record<string, number> = { developer: 120_000, designer: 200_000, 'associate-developer': 60_000 }

export function startDemo(hub: Hub, speed = 1): void {
  const t0 = Date.now()
  const queue: { at: number; e: Partial<HHEvent> }[] = []
  const at = (sec: number, e: Partial<HHEvent>) => queue.push({ at: sec, e })
  const base = { source: 'demo-harness', repo: REPO, run: RUN, milestone: '0.2 — Core', user: 'you', machine: 'laptop' }

  at(0, { kind: 'run.start', mode: 'dev', stage: 'Preflight', skill: 'feature-build' })
  at(0, { kind: 'phase', phase: 'Discovery', status: 'done', skill: 'market-scan' })
  at(0, { kind: 'phase', phase: 'Design', status: 'done', skill: 'ui-design' })
  at(0, { kind: 'phase', phase: 'Architecture', status: 'done', skill: 'write-adr' })
  at(3, { kind: 'run.stage', stage: 'Lead', skill: 'feature-build' })
  at(8, { kind: 'run.stage', stage: 'Build', skill: 'feature-build' })

  const laneFree: Record<string, number> = {}
  for (const p of PLANS) {
    let s = Math.max(8, laneFree[p.lane] ?? 0) + 1
    const who = { role: p.role, model: p.model }
    const lead = { role: 'lead', model: 'opus' }
    const coord = { role: 'coordinator', model: 'haiku' }
    const tk = { lane: p.lane, ticket: p.ticket, title: p.title, epic: p.epic, skill: 'feature-build' }
    const branch = (p.docs ? 'docs/' : 'feat/') + p.ticket + '-' + p.title.toLowerCase().replace(/\W+/g, '-')
    const step = (name: string, agent: { role: string; model: string }, dur: number, detail: string, extra: Partial<HHEvent> = {}, status: HHEvent['status'] = 'done') => {
      at(s, { kind: 'step.start', ...tk, step: name, agent, detail, branch, ...extra })
      s += dur
      at(s, { kind: 'step.end', ...tk, step: name, agent, status, branch, ...extra })
      s += 1
    }
    const budget = BUDGET[p.role] ?? 120_000
    step('plan', lead, 3, 'Picked into batch, brief written', { tokens: { used: 8000, budget: 60_000 } })
    if (!p.docs) {
      at(s + 2, { kind: 'activity', source: 'claude-code', ticket: p.ticket, repo: REPO, tool: 'Edit', detail: 'Edit ' + p.files[0], files: [p.files[0]!] })
      step('code', who, 14, 'Building ' + p.title.toLowerCase(), { files: p.files.slice(0, -1), tokens: { used: Math.round(budget * 0.45), budget } })
    } else {
      at(s, { kind: 'step.end', ...tk, step: 'code', status: 'skipped', agent: who })
    }
    step('tests', who, 6, p.docs ? 'Writing ' + p.files[0] : 'Writing tests', { files: [p.files.at(-1)!], tokens: { used: Math.round(budget * 0.55), budget } })
    if (p.failAt === 'check') {
      step('check', who, 3, 'npm run check', {}, 'failed')
      at(s, { kind: 'step.start', ...tk, step: 'code', agent: who, detail: 'Fixing refresh.ts:88 type mismatch after check failed', files: [p.files[0]!], tokens: { used: Math.round(budget * 0.7), budget }, branch })
      at(s + 3, { kind: 'activity', source: 'claude-code', ticket: p.ticket, repo: REPO, tool: 'Bash', detail: 'Running npx tsc --noEmit src/auth/refresh.ts' })
      s += 12
      at(s, { kind: 'step.end', ...tk, step: 'code', agent: who, status: 'done', branch })
      s += 1
    }
    step('check', who, 3, 'npm run check passed')
    const pr = ({ 42: 88, 51: 90, 47: 92, 59: 94, 64: 96 } as Record<number, number>)[p.ticket] ?? 80 + p.ticket
    step('pr', coord, 3, 'Opened PR #' + pr + ', checks green', { pr })
    step('review', p.ui ? { role: 'ui-aligner', model: 'haiku' } : coord, p.ui ? 6 : 2, p.ui ? 'Comparing the screen with the design baseline' : 'Scope check: only the declared files changed', { pr, skill: 'feature-build' })
    step('merge', coord, 4, 'Waiting for auto-merge, squash into develop', { pr })
    if (p.ui) {
      at(s, { kind: 'step.start', ...tk, step: 'close', agent: coord, detail: 'Merged; moved to QA Validation', pr })
      s += 1
      at(s, { kind: 'step.end', ...tk, step: 'close', agent: coord, status: 'done', pr })
    } else {
      step('close', coord, 2, 'Closed with the gate transcript as evidence', { pr })
    }
    laneFree[p.lane] = s
  }

  // A decision the lead sends to the owner, and the owner answering it later.
  at(20, { kind: 'decision.open', ticket: 63, decision: { id: 'demo#63', title: '#63 Choose tenancy model', why: 'Decision ticket: only the owner or an ADR can make it', recommendation: 'Lead recommends a shared schema with row-level tenant ids', url: 'https://github.com/' + REPO + '/issues/63' } })
  at(75, { kind: 'decision.close', decision: { id: 'demo#63', title: '#63 Choose tenancy model' } })

  // The architect writes an ADR in its own lane while the developers build.
  at(24, { kind: 'step.start', lane: 'L5', ticket: 58, title: 'ADR 0007 tenancy', epic: 30, step: 'tests', skill: 'write-adr', agent: { role: 'architect', model: 'opus' }, detail: 'Writing docs/adr/0007-tenancy.md', files: ['docs/adr/0007-tenancy.md'], tokens: { used: 40_000, budget: 150_000 } })
  at(70, { kind: 'step.end', lane: 'L5', ticket: 58, step: 'tests', agent: { role: 'architect', model: 'opus' }, status: 'done' })

  const end = Math.max(...Object.values(laneFree))
  at(end + 2, { kind: 'run.stage', stage: 'Promote', skill: 'feature-build' })
  at(end + 4, { kind: 'decision.open', decision: { id: 'demo!99:approval', title: 'PR #99 into stage', why: 'Checks green: ready for your merge', url: 'https://github.com/' + REPO + '/pull/99' } })
  at(end + 10, { kind: 'decision.close', decision: { id: 'demo!99:approval', title: '' } })

  // Test stage: one QA cycle with a bug that goes back to a developer lane.
  let q = end + 11
  at(q, { kind: 'run.stage', stage: 'Test', skill: 'qa-cycle' })
  const tester = { role: 'tester', model: 'haiku' }
  const qaLead = { role: 'qa-lead', model: 'sonnet' }
  const cyc = { lane: 'QA', ticket: 101, title: 'Test cycle 1', skill: 'qa-cycle' }
  const qstep = (name: string, agent: { role: string; model: string }, dur: number, detail: string, status: HHEvent['status'] = 'done') => {
    at(q, { kind: 'step.start', ...cyc, step: name, agent, detail })
    q += dur
    at(q, { kind: 'step.end', ...cyc, step: name, agent, status, detail })
    q += 1
  }
  qstep('qa-plan', qaLead, 3, 'Planning from journeys and acceptance rows')
  qstep('cycle-open', { role: 'coordinator', model: 'haiku' }, 1, 'Opened cycle issue #101')
  qstep('run', tester, 8, '31 pass, 1 fail on stage', 'failed')
  qstep('second-look', { role: 'tester', model: 'sonnet' }, 3, 'Confirmed: export button ignores plan limit')
  qstep('file-bugs', qaLead, 2, 'Filed #71 High')
  const fix = { lane: 'L2', ticket: 71, title: 'Bug: export ignores plan limit', epic: 32, skill: 'feature-build' }
  at(q, { kind: 'step.start', ...fix, step: 'code', agent: { role: 'developer', model: 'sonnet' }, detail: 'Fixing the limit check from test cycle 1', files: ['src/billing/limits.ts'] })
  at(q + 12, { kind: 'step.end', ...fix, step: 'code', agent: { role: 'developer', model: 'sonnet' }, status: 'done' })
  at(q + 13, { kind: 'step.start', ...fix, step: 'check', agent: { role: 'developer', model: 'sonnet' }, detail: 'npm run check' })
  at(q + 16, { kind: 'step.end', ...fix, step: 'check', agent: { role: 'developer', model: 'sonnet' }, status: 'done' })
  at(q + 17, { kind: 'step.start', ...cyc, step: 'verify', agent: tester, detail: 'Re-verifying #71 on stage' })

  queue.sort((a, b) => a.at - b.at)
  const total = q + 30
  let next = 0
  const tick = () => {
    const now = ((Date.now() - t0) * speed) / 1000
    if (now > total) {
      // Play the story again from the start.
      hub.resetLive()
      startDemo(hub, speed)
      return
    }
    while (next < queue.length && queue[next]!.at <= now) {
      hub.ingest({ v: 1, ts: new Date().toISOString(), ...base, ...queue[next]!.e } as HHEvent)
      next++
    }
    hub.setGit(demoGit(now))
    setTimeout(tick, 1000)
  }
  hub.setTracker(demoTracker())
  tick()
}

function item(number: number, title: string, type: string, status: string, epic?: number, prs: number[] = [], labels: string[] = []): WorkItem {
  return {
    number, title, type, status, epic, labels, state: status === 'Done' ? 'closed' : 'open',
    url: `https://github.com/${REPO}/issues/${number}`,
    prs: prs.map((n) => ({ number: n, state: status === 'Done' ? 'merged' : 'open', url: `https://github.com/${REPO}/pull/${n}` })),
  }
}

export function demoTracker(): TrackerSnapshot {
  const items: WorkItem[] = [
    item(30, 'Accounts and auth', 'Epic', 'In Progress'), item(31, 'Workspace settings', 'Epic', 'In Progress'), item(32, 'Billing', 'Epic', 'In Progress'),
    item(40, 'Login screen', 'Feature', 'Done', 30, [77]), item(41, 'Session cookies', 'Task', 'Done', 30, [78]), item(43, 'Password reset', 'Feature', 'Done', 30, [79]),
    item(42, 'Cursor pagination', 'Feature', 'In Review', 30, [88]), item(47, 'Auth token refresh', 'Feature', 'In Progress', 30),
    item(58, 'ADR 0007 tenancy', 'Task', 'In Progress', 30), item(45, 'Audit log', 'Feature', 'Ready', 30), item(46, 'SSO stub', 'Feature', 'Backlog', 30),
    item(44, 'Invite members', 'Feature', 'QA Validation', 31, [81]), item(51, 'Settings screen', 'Feature', 'In Review', 31, [90]), item(59, 'API guide', 'Task', 'In Progress', 31),
    item(52, 'Workspace rename', 'Feature', 'Done', 31, [82]), item(53, 'Avatar upload', 'Feature', 'Ready', 31), item(54, 'Theme switch', 'Feature', 'Ready', 31),
    item(60, 'Billing export', 'Bug', 'Blocked', 32, [85], ['needs-human']), item(64, 'Plan limits', 'Feature', 'Ready', 32), item(65, 'Invoice PDF', 'Feature', 'Backlog', 32),
    item(66, 'Usage meter', 'Feature', 'Ready', 32), item(63, 'Choose tenancy model', 'Task', 'Backlog', 30),
  ]
  const board: Record<string, number> = {}
  for (const i of items) if (i.type !== 'Epic') board[i.status] = (board[i.status] ?? 0) + 1
  const epics = [30, 31, 32].map((n) => {
    const kids = items.filter((i) => i.epic === n)
    return {
      number: n, title: items.find((i) => i.number === n)!.title, url: `https://github.com/${REPO}/issues/${n}`, total: kids.length,
      done: kids.filter((k) => k.status === 'Done').length, blocked: kids.filter((k) => k.status === 'Blocked').length,
      active: kids.filter((k) => ['In Progress', 'In Review', 'QA Validation'].includes(k.status)).length,
    }
  })
  const pr = (number: number, head: string, ticket: number, checks: ChangeRequest['checks'], mergeable: ChangeRequest['mergeable'] = 'mergeable'): ChangeRequest => ({
    number, title: head, head, base: 'develop', state: 'open', draft: false, mergeable, checks, url: `https://github.com/${REPO}/pull/${number}`, ticket,
  })
  return {
    provider: 'github', repo: REPO, fetchedAt: new Date().toISOString(),
    milestone: { title: '0.2 — Core', dueOn: new Date(Date.now() + 14 * 86_400_000).toISOString(), url: `https://github.com/${REPO}/milestone/2`, open: 15, closed: 4 },
    board, items, epics,
    changes: [pr(88, 'feat/42-cursor-pagination', 42, 'success'), pr(90, 'feat/51-settings-screen', 51, 'success'), pr(92, 'feat/47-auth-token-refresh', 47, 'failure', 'conflicting')],
  }
}

export function demoGit(sec: number): GitSnapshot {
  const grow = (n: number) => Math.min(n, 1 + Math.floor(sec / 9))
  return {
    repoPath: '/demo/acme-app', base: 'origin/develop', baseHead: 'a1c9e02', fetchedAt: new Date().toISOString(),
    worktrees: [
      { path: '/demo/acme-app', branch: 'develop', head: 'a1c9e02', ahead: 0, behind: 0, dirty: false },
      { path: '/demo/wt/42', branch: 'feat/42-cursor-pagination', head: 'b77d310', ticket: 42, ahead: grow(4), behind: 0, dirty: false, lastCommitAt: new Date().toISOString() },
      { path: '/demo/wt/51', branch: 'feat/51-settings-screen', head: 'c02aa41', ticket: 51, ahead: grow(6), behind: 1, dirty: true, lastCommitAt: new Date().toISOString() },
      { path: '/demo/wt/47', branch: 'feat/47-auth-token-refresh', head: 'd9e1f07', ticket: 47, ahead: grow(3), behind: 3, dirty: true, lastCommitAt: new Date().toISOString() },
      { path: '/demo/wt/59', branch: 'docs/59-api-guide', head: 'e44b2c8', ticket: 59, ahead: grow(2), behind: 0, dirty: false, lastCommitAt: new Date().toISOString() },
    ],
  }
}
