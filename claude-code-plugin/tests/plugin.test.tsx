import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const RUN_LANES = { command: 'lanes', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

// A hub snapshot like the one /api/state returns, trimmed to what the plugin reads.
const STATE = {
  live: {
    runs: [{ run: 'r1', repo: 'me/app', milestone: '0.2', stage: 'Build', status: 'running', startedAt: 't' }],
    segments: [
      { lane: 'L1', ticket: 42, step: 'plan', status: 'done', role: 'lead', start: '2026-11-06T10:00:00.000Z', end: '2026-11-06T10:00:20.000Z' },
      { lane: 'L1', ticket: 42, step: 'code', status: 'running', role: 'developer', start: '2026-11-06T10:00:21.000Z' },
    ],
    agents: [
      { key: 'r1:L1:developer', role: 'developer', model: 'sonnet', status: 'busy', ticket: 42, step: 'code', skill: 'feature-build', since: '2026-11-06T10:00:21.000Z' },
      { key: 'r1:L1:lead', role: 'lead', status: 'idle', since: '2026-11-06T10:00:20.000Z' },
    ],
    rows: [
      {
        key: 'r1:42', ticket: 42, lane: 'L1', title: 'Cursor pagination', kind: 'dev', current: 'code', finished: false,
        steps: {
          plan: { step: 'plan', status: 'done', agent: { role: 'lead' }, files: [], attempt: 1 },
          code: { step: 'code', status: 'running', agent: { role: 'developer', model: 'sonnet' }, skill: 'feature-build', detail: 'Edit src/api/list.ts', files: [], attempt: 2, tokens: { used: 100000, budget: 120000 } },
        },
      },
    ],
    phases: [{ name: 'Plan', status: 'done' }, { name: 'Build', status: 'running', skill: 'feature-build' }, { name: 'Test', status: 'waiting' }],
    decisions: [{ id: 'd1', title: '#63 Choose tenancy model', why: 'Decision ticket', openedAt: 't', source: 'demo' }],
  },
  trackers: [{ repo: 'me/app', milestone: { title: '0.2' }, board: { Done: 4, Ready: 15 }, changes: [{ number: 88, head: 'feat/42-x', state: 'open', checks: 'success', mergeable: 'mergeable' }] }],
  git: [{ base: 'origin/develop', baseHead: 'a1c9e02', worktrees: [{ branch: 'feat/42-x', ticket: 42, ahead: 3, behind: 1 }] }],
}

const PANE = {
  plugin: 'hurray-harness', component: 'Pane', requestId: 'hh-lanes',
  props: { title: 'Agent lanes', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

type Seen = { status: (string | undefined)[]; toasts: string[]; opened?: string[]; spawned?: { argv: readonly string[]; cwd?: string }[] }

// spawn: how hh start behaves when the plugin starts it. 'runs' keeps running, 'missing' cannot start.
function engine(on: On, hub: 'up' | 'down', seen: Seen, opts: { spawn?: 'runs' | 'missing'; env?: Record<string, string> } = {}) {
  mock.clock(on)
  mock.store(on)
  on('command.register', () => ({ value: { command: 'lanes' } }))
  on('ui.open', (_, e) => { (seen.opened ??= []).push(e.id); return { value: { isPlaced: true } } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: opts.env?.[e.name] }))
  on('process.spawn', async function* (_, e) {
    (seen.spawned ??= []).push({ argv: e.argv, cwd: e.cwd })
    if (opts.spawn !== 'runs') throw new Error('ENOENT')
    yield { stream: 'stdout' as const, text: 'Hub on http://127.0.0.1:7311\n' }
    await new Promise(() => {}) // keeps running
    return { value: { code: 0, signal: null } }
  })
  on('ui.status', (_, e) => { seen.status.push(e.text); return { value: undefined } })
  on('ui.toast', (_, e) => { seen.toasts.push(e.text); return { value: undefined } })
  on('http.fetch', (_, e) => {
    expect(e.url).toBe('http://127.0.0.1:7311/api/state')
    if (hub === 'down') throw new Error('connection refused')
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(STATE) } }
  })
}

test('the status line and toast show lanes and what needs you', async ($, on) => {
  const seen = { status: [] as (string | undefined)[], toasts: [] as string[] }
  engine(on, 'up', seen)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(RUN_LANES)
  expect(seen.status.at(-1)).toBe('lanes · Build · 1 busy · 1 need you · 4/19 done')
  expect(seen.toasts[0]).toBe('Needs you: #63 Choose tenancy model')
})

test('the pane draws each lane, its agent and what it is doing, on every surface', async ($, on) => {
  engine(on, 'up', { status: [], toasts: [] })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(RUN_LANES)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // The grid: a cell's status on top and its agent below, and what the agent is doing under the row.
    expect((await ui.find({ type: 'Text', text: /recode 2/ }))?.text?.trim()).toBe('recode 2')
    expect((await ui.findAll({ type: 'Text', text: /^\s*developer\s*$/ })).length).toBeGreaterThan(0)
    expect(await ui.find({ type: 'Text', text: /↳ feature-build · sonnet/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Edit src\/api\/list\.ts/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Needs your decision \(1\)/ })).toBeTruthy()
    await ui.unmount()
  }
  // A narrow pane keeps whole words: agent names shorten instead of being cut.
  const slim = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 70 } })
  expect((await slim.findAll({ type: 'Text', text: /^\s*dev\s*$/ })).length).toBeGreaterThan(0)
  await slim.unmount()
})

test('the phase strip marks the running phase as waiting on you while a decision is open', async ($, on) => {
  engine(on, 'up', { status: [], toasts: [] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(RUN_LANES)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /waits on you/ })).toBeTruthy()
  // Once in the phase strip (Build) and once in the skills-running line.
  expect((await ui.findAll({ type: 'Text', text: /^\s*feature-build\s*$/ })).length).toBe(2)
  await ui.unmount()
})

test('with no hub running, the plugin starts hh start in the session folder', async ($, on) => {
  const seen: Seen = { status: [], toasts: [] }
  engine(on, 'down', seen, { spawn: 'runs' })
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
  expect(seen.spawned?.[0]).toEqual({ argv: ['hh', 'start'], cwd: '/work/app' })
  expect(seen.status.at(-1)).toBe('lanes · starting the hub')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Starting the hub in this folder/ })).toBeTruthy()
  await ui.unmount()
})

test('when hh is not installed, the pane says how to install it', async ($, on) => {
  const seen: Seen = { status: [], toasts: [] }
  engine(on, 'down', seen, { spawn: 'missing' })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(RUN_LANES)
  // Tried directly, then through cmd.exe for Windows.
  expect(seen.spawned?.map((x) => x.argv[0])).toEqual(['hh', 'cmd.exe'])
  expect(seen.status.at(-1)).toBe('lanes · hub offline (run hh start)')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /npm install -g hurray-harness/ })).toBeTruthy()
  await ui.unmount()
})

test('HH_AUTOSTART=0 never starts the hub', async ($, on) => {
  const seen: Seen = { status: [], toasts: [] }
  engine(on, 'down', seen, { spawn: 'runs', env: { HH_AUTOSTART: '0' } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(seen.spawned).toBeUndefined()
  expect(seen.status.at(-1)).toBe('lanes · hub offline (run hh start)')
})

test('the lanes pane opens when an interactive session starts, unless HH_PANE=off', async ($, on) => {
  const seen: Seen = { status: [], toasts: [] }
  engine(on, 'up', seen)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(seen.opened).toEqual(['hh-lanes'])
})

test('HH_PANE=off keeps the pane closed until /lanes', async ($, on) => {
  const seen: Seen = { status: [], toasts: [] }
  engine(on, 'up', seen, { env: { HH_PANE: 'off' } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(seen.opened).toBeUndefined()
  // A running hub is never started twice.
  expect(seen.spawned).toBeUndefined()
})

test('Now and Flow take turns, a button pins one, and decisions stay on top', async ($, on) => {
  engine(on, 'up', { status: [], toasts: [] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(RUN_LANES)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Now first: skills running, the grid with model, time and budget on the running line, idle agents.
  expect(await ui.find({ type: 'Text', text: /now · flow in/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Skills running/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /\(developer L1\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /████░ 100k\/120k/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Idle: lead L1/ })).toBeTruthy()
  // Pin Flow: swimlanes, each lane ending with its merge state.
  await ui.press({ key: 'v-flow' })
  expect(await ui.find({ type: 'Text', text: /Flow · last .* base origin\/develop/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /PR #88 · behind 1/ })).toBeTruthy()
  // Under the lane: its local worktree.
  expect(await ui.find({ type: 'Text', text: /^feat\/42-x$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: / · 3 ahead · / })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^1 behind$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /merges develop in first/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /flow · pinned/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Needs your decision/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Skills running/ })).toBeFalsy()
  // Back to rotating.
  await ui.press({ key: 'v-rotate' })
  expect(await ui.find({ type: 'Text', text: /pinned/ })).toBeFalsy()
  await ui.unmount()
})

test('with no agent lanes, the pane shows the bugs and issues in flight on GitHub, and no empty phases', async ($, on) => {
  const GH = {
    live: { runs: [], segments: [], agents: [], rows: [], decisions: [], phases: [{ name: 'Plan', status: 'waiting' }, { name: 'Build', status: 'waiting' }] },
    trackers: [{
      repo: 'me/db', milestone: { title: 'M9' }, board: { Done: 11, 'In progress': 4 },
      items: [
        { number: 51, title: 'WAL replay drops a segment', type: 'Bug', state: 'open', status: 'In progress', labels: [], prs: [{ number: 9, state: 'open' }], assignees: ['ana'] },
        { number: 52, title: 'Package arm64 builds', type: 'Task', state: 'open', status: 'In review', labels: [], prs: [] },
        { number: 53, title: 'Handle leak under cgroup v2', type: 'Issue', state: 'open', status: 'Todo', labels: ['bug'], prs: [] },
      ],
      changes: [{ number: 9, head: 'fix/51-wal', state: 'open', checks: 'failure', mergeable: 'mergeable' }],
    }],
    git: [],
  }
  mock.clock(on)
  mock.store(on)
  on('command.register', () => ({ value: { command: 'lanes' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(GH) } }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(RUN_LANES)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /1 in progress · 1 in review · 2 open bugs/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /WAL replay drops a segment/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /PR #9 · ✗ checks/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /@ana/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /#53 Handle leak under cgroup v2/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Product phases/ })).toBeFalsy()
  await ui.unmount()
})
