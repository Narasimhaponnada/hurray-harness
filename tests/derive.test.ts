import { describe, expect, it } from 'vitest'
import { defaultConfig } from '../src/hub/config.js'
import { hookToEvent } from '../src/hub/hooks.js'
import { Hub } from '../src/hub/hub.js'
import { EventStore } from '../src/hub/store.js'

const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
const issue = (number: number, status: string, o: Record<string, unknown> = {}) => ({ number, title: 'T' + number, type: 'Issue', state: 'open', status, labels: [], url: '', prs: [], ...o })
const pr = (number: number, ticket: number, o: Record<string, unknown> = {}) => ({ number, title: '', head: `fix/${ticket}-x`, base: 'main', state: 'open', draft: false, mergeable: 'mergeable', checks: 'pending', url: '', ticket, ...o })

function hub(items: unknown[], changes: unknown[], worktrees: unknown[] = []) {
  const h = new Hub({ ...defaultConfig(), repos: [] } as never, new EventStore(':memory:'))
  ;(h as any).repoOfPath.set('/r', 'me/db')
  h.setGit({ repoPath: '/r', base: 'origin/main', fetchedAt: ago(0), worktrees } as never)
  h.setTracker({ provider: 'github', repo: 'me/db', fetchedAt: ago(0), board: {}, epics: [], items, changes } as never)
  return h
}
const cells = (h: Hub, ticket: number) => {
  const r = h.snapshot().live.rows.find((x) => x.ticket === ticket)!
  return Object.fromEntries(Object.entries(r.steps).map(([k, s]) => [k, s.status]))
}

describe('lanes built from the tracker, git and hooks', () => {
  it('walks an issue through the stages from its board status, PR, checks, review and merge', () => {
    const h = hub(
      [issue(1, 'In progress'), issue(2, 'In review', { prs: [{ number: 20, state: 'open' }] }), issue(3, 'In review', { prs: [{ number: 30, state: 'open' }] }),
        issue(4, 'QA', { prs: [{ number: 40, state: 'merged' }] }), issue(5, 'Todo'), issue(6, 'Blocked')],
      [pr(20, 2, { checks: 'success', review: 'required' }), pr(30, 3, { checks: 'success', review: 'approved', mergeable: 'conflicting' }), pr(40, 4, { state: 'merged', checks: 'success', mergedAt: ago(30) })],
    )
    expect(cells(h, 1)).toMatchObject({ plan: 'done', code: 'running', pr: 'waiting' })
    expect(cells(h, 2)).toMatchObject({ code: 'done', check: 'done', pr: 'done', review: 'running', merge: 'waiting' })
    expect(cells(h, 3)).toMatchObject({ review: 'done', merge: 'failed' })
    expect(cells(h, 4)).toMatchObject({ merge: 'done', close: 'running' })
    expect(cells(h, 6)).toMatchObject({ plan: 'done', code: 'blocked' })
    expect(h.snapshot().live.rows.map((r) => r.ticket)).not.toContain(5) // not started: not a lane
  })

  it('shows the agent, its skill and what it does from Claude Code hooks, and a recode loop after red checks', () => {
    const h = hub([issue(7, 'In progress', { type: 'Bug', prs: [{ number: 70, state: 'open' }] })], [pr(70, 7, { checks: 'failure' })],
      [{ path: '/r/.wt/lane-1', branch: 'fix/7-x', head: 'h', ticket: 7, ahead: 2, behind: 0, dirty: true }])
    const hook = (raw: Record<string, unknown>) => h.ingest(hookToEvent(raw, 'claude-code')!)
    hook({ hook_event_name: 'PreToolUse', session_id: 's', cwd: '/r/.wt/lane-1', agent_type: 'developer', tool_name: 'Skill', tool_input: { skill: 'product-fix' } })
    hook({ hook_event_name: 'PreToolUse', session_id: 's', cwd: '/r/.wt/lane-1', agent_type: 'developer', tool_name: 'Bash', tool_input: { command: 'cargo test' } })
    const s = h.snapshot()
    const row = s.live.rows.find((r) => r.ticket === 7)!
    expect(row).toMatchObject({ derived: true, lane: 'lane-1', current: 'code', title: 'Bug: T7' })
    expect(row.steps.check!.status).toBe('failed')
    expect(row.steps.code).toMatchObject({ status: 'running', attempt: 2, skill: 'product-fix', detail: 'Running cargo test', agent: { role: 'developer' } })
    expect(s.live.agents).toContainEqual(expect.objectContaining({ key: 'gh:lane-1:developer', role: 'developer', skill: 'product-fix', ticket: 7 }))
  })

  it('leaves a ticket a harness reports on to the harness', () => {
    const h = hub([issue(8, 'In progress')], [])
    h.ingest({ v: 1, ts: ago(0), kind: 'step.start', source: 'my-harness', repo: 'me/db', run: 'r', lane: 'L1', ticket: 8, step: 'tests', agent: { role: 'tester' } })
    const rows = h.snapshot().live.rows.filter((r) => r.ticket === 8)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.derived).toBeUndefined()
  })
})

describe('tool hooks name the agent and the skill', () => {
  it('reads the skill, the subagent started, and the acting agent', () => {
    expect(hookToEvent({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'feature-build' } })).toMatchObject({ skill: 'feature-build', detail: 'Running skill feature-build' })
    expect(hookToEvent({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'tester', description: 'Run QA' } })).toMatchObject({ detail: 'Started agent tester: Run QA' })
    expect(hookToEvent({ hook_event_name: 'PreToolUse', agent_type: 'developer', tool_name: 'Edit', tool_input: { file_path: 'a.rs' } })).toMatchObject({ agent: { role: 'developer' }, detail: 'Edit a.rs' })
  })
})

describe('which ticket an action belongs to', () => {
  it('goes by the file touched when the session started in the main clone', () => {
    const h = hub([issue(9, 'In progress')], [], [
      { path: '/r', branch: 'main', head: 'h', ahead: 0, behind: 0, dirty: false },
      { path: '/r/.wt/lane-4', branch: 'fix/9-x', head: 'h', ticket: 9, ahead: 1, behind: 0, dirty: true },
    ])
    const e = h.ingest(hookToEvent({ hook_event_name: 'PreToolUse', cwd: '/r', tool_name: 'Edit', tool_input: { file_path: '/r/.wt/lane-4/src/a.rs' } }, 'claude-code')!)
    expect(e.ticket).toBe(9)
  })
})
