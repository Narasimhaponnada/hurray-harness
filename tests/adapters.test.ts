import { describe, expect, it } from 'vitest'
import { trackerDecisions } from '../src/hub/decisions.js'
import { parseWorktreeList, ticketFromBranch, worktreeFor } from '../src/hub/git.js'
import { hookToEvent } from '../src/hub/hooks.js'
import { deriveStatus, epicsFrom, toChange, toWorkItem } from '../src/hub/trackers/github.js'
import { DEFAULT_LABELS } from '../src/hub/config.js'
import type { TrackerSnapshot } from '../src/shared/types.js'

describe('git', () => {
  it('reads tickets from harness branch names', () => {
    expect(ticketFromBranch('feat/42-cursor-pagination')).toBe(42)
    expect(ticketFromBranch('refs/heads/fix/71-limit')).toBe(71)
    expect(ticketFromBranch('develop')).toBeUndefined()
  })
  it('parses git worktree list --porcelain', () => {
    const out = 'worktree /r\nHEAD aaa\nbranch refs/heads/develop\n\nworktree /wt/42\nHEAD bbb\nbranch refs/heads/feat/42-x\n\nworktree /wt/d\nHEAD ccc\ndetached\n'
    expect(parseWorktreeList(out)).toEqual([
      { path: '/r', head: 'aaa', branch: 'develop' },
      { path: '/wt/42', head: 'bbb', branch: 'feat/42-x' },
      { path: '/wt/d', head: 'ccc', branch: '(detached)' },
    ])
  })
  it('maps a path to the deepest worktree that holds it', () => {
    const snap = { repoPath: '/r', base: 'origin/develop', fetchedAt: '', worktrees: [
      { path: '/r', branch: 'develop', head: '', ahead: 0, behind: 0, dirty: false },
      { path: '/r/.wt/42', branch: 'feat/42-x', head: '', ticket: 42, ahead: 1, behind: 0, dirty: false },
    ] }
    expect(worktreeFor('/r/.wt/42/src/a.ts', [snap])?.wt.ticket).toBe(42)
    expect(worktreeFor('/r/src/a.ts', [snap])?.wt.branch).toBe('develop')
    expect(worktreeFor('/elsewhere', [snap])).toBeUndefined()
  })
})

describe('github mapping', () => {
  it('derives board status when the issue is not on a board', () => {
    expect(deriveStatus('OPEN', ['needs-human'], [])).toBe('Blocked')
    expect(deriveStatus('OPEN', ['WIP'], [])).toBe('In Progress')
    expect(deriveStatus('OPEN', ['doing'], [], undefined, { ...DEFAULT_LABELS, inProgress: ['doing'] })).toBe('In Progress')
    expect(deriveStatus('OPEN', [], [{ state: 'open' }])).toBe('In Review')
    expect(deriveStatus('CLOSED', [], [])).toBe('Done')
    expect(deriveStatus('OPEN', [], [], 'QA Validation')).toBe('QA Validation')
  })
  it('maps an issue node and builds epic progress from sub-issues', () => {
    const items = [
      toWorkItem({ number: 30, title: 'Auth', state: 'OPEN', url: 'u', issueType: { name: 'Epic' }, labels: { nodes: [] } }),
      toWorkItem({ number: 41, title: 'a', state: 'CLOSED', url: 'u', parent: { number: 30 }, labels: { nodes: [] } }),
      toWorkItem({ number: 42, title: 'b', state: 'OPEN', url: 'u', parent: { number: 30 }, labels: { nodes: [] }, closedByPullRequestsReferences: { nodes: [{ number: 88, state: 'OPEN', url: 'p' }] } }),
    ]
    expect(items[2]!.status).toBe('In Review')
    expect(epicsFrom(items, new Map())).toEqual([{ number: 30, title: 'Auth', url: 'u', total: 2, done: 1, active: 1, blocked: 0 }])
  })
  it('maps a pull request and its checks', () => {
    const c = toChange({ number: 92, title: 't', headRefName: 'feat/47-auth', baseRefName: 'develop', state: 'OPEN', mergeable: 'CONFLICTING', url: 'u', commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } })
    expect(c).toMatchObject({ ticket: 47, mergeable: 'conflicting', checks: 'failure', state: 'open' })
  })
  it('turns decision labels and a green PR into an approval branch into decisions', () => {
    const snap: TrackerSnapshot = {
      provider: 'github', repo: 'o/r', board: {}, epics: [], fetchedAt: 't',
      items: [
        toWorkItem({ number: 60, title: 'Export', state: 'OPEN', url: 'u', labels: { nodes: [{ name: 'Needs-Human' }] } }),
        toWorkItem({ number: 61, title: 'Stuck', state: 'OPEN', url: 'u', labels: { nodes: [{ name: 'blocked' }] } }),
        toWorkItem({ number: 62, title: 'Fine', state: 'OPEN', url: 'u', labels: { nodes: [] } }),
      ],
      changes: [{ number: 99, title: 'p', head: 'develop', base: 'stage', state: 'open', draft: false, mergeable: 'mergeable', checks: 'success', url: 'u' }],
    }
    expect(trackerDecisions([snap], DEFAULT_LABELS, ['stage']).map((d) => d.id)).toEqual(['o/r#60:decision', 'o/r#61:blocked', 'o/r!99:approval'])
    expect(trackerDecisions([snap], DEFAULT_LABELS).map((d) => d.id)).toEqual(['o/r#60:decision', 'o/r#61:blocked'])
  })
})

describe('hooks', () => {
  it('keeps only the action, never content', () => {
    const e = hookToEvent({ hook_event_name: 'PostToolUse', tool_name: 'Edit', session_id: 's', cwd: '/r', tool_input: { file_path: '/r/a.ts', old_string: 'SECRET', new_string: 'SECRET' }, tool_response: 'SECRET' })!
    expect(e.detail).toBe('Edit /r/a.ts')
    expect(JSON.stringify(e)).not.toContain('SECRET')
  })
  it('reads Cursor shell hooks', () => {
    expect(hookToEvent({ hook_event_name: 'afterShellExecution', command: 'npm test', conversation_id: 'c' })).toMatchObject({ source: 'cursor', detail: 'Running npm test' })
  })
})
