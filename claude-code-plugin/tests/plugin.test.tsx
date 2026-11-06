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

function engine(on: On, hub: 'up' | 'down', seen: { status: (string | undefined)[]; toasts: string[] }) {
  mock.clock(on)
  mock.store(on)
  on('command.register', () => ({ value: { command: 'lanes' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: undefined }))
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
    expect(await ui.find({ type: 'Text', text: /↳ feature-build · sonnet · Edit src\/api\/list\.ts/ })).toBeTruthy()
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
  expect((await ui.findAll({ type: 'Text', text: /^\s*feature-build\s*$/ })).length).toBe(1)
  await ui.unmount()
})

test('a hub that is not running says how to start it', async ($, on) => {
  const seen = { status: [] as (string | undefined)[], toasts: [] as string[] }
  engine(on, 'down', seen)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(RUN_LANES)
  expect(seen.status.at(-1)).toBe('lanes · hub offline (run hh start)')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /hh start/ }))).toBeTruthy()
  await ui.unmount()
})

test('the views take turns, a button pins one, and decisions stay on top', async ($, on) => {
  engine(on, 'up', { status: [], toasts: [] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(RUN_LANES)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // The grid first, saying what comes next.
  expect(await ui.find({ type: 'Text', text: /grid · swimlanes in/ })).toBeTruthy()
  // Pin the swimlanes.
  await ui.press({ key: 'v-swim' })
  expect(await ui.find({ type: 'Text', text: /Swimlanes · last/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /swimlanes · pinned/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Needs your decision/ })).toBeTruthy()
  // Pin the worktrees: the branch, its counts, its PR and its way into the base.
  await ui.press({ key: 'v-tree' })
  expect(await ui.find({ type: 'Text', text: /feat\/42-x/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /▶ PR #88/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /behind 1: merges develop in first/ })).toBeTruthy()
  // Pin the agents: the skill in use, who runs it, and each running agent's row.
  await ui.press({ key: 'v-agents' })
  expect(await ui.find({ type: 'Text', text: /Agents and skills · 1 running · 1 idle/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /1 · developer L1/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /code \(recode 2\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /100k\/120k/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Idle: lead L1/ })).toBeTruthy()
  // Back to rotating.
  await ui.press({ key: 'v-rotate' })
  expect(await ui.find({ type: 'Text', text: /pinned/ })).toBeFalsy()
  await ui.unmount()
})
